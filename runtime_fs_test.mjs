// Tests for the in-memory filesystem behind the WASI surface of runtime.mjs:
// the preopen pair, path_open, and the descriptor calls that read and write
// through it. Each fixture is a hand-built module importing only the calls it
// needs, so a missing import fails at instantiation rather than in the body
// under test, and each answer is reported through ASCII bytes so it survives
// UTF-8 decoding intact.
//
// The fixtures are assembled from raw sections rather than compiled from V,
// because that keeps each one honest about exactly which imports it declares.
//
// Run: node --test runtime_fs_test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWasm } from './runtime.mjs';

// --- minimal wasm assembler ------------------------------------------------

function leb(n) {
	const out = [];
	do {
		let b = n & 0x7f;
		n >>>= 7;
		if (n) b |= 0x80;
		out.push(b);
	} while (n);
	return out;
}

// path_open declares its two rights fields as i64, which wasm hands to the host
// as BigInt, so the encoder has to cope with both widths.
function sleb(n) {
	const wide = typeof n === 'bigint';
	const mask = wide ? 0x7fn : 0x7f;
	const out = [];
	while (true) {
		const b = Number(n & mask);
		n = wide ? n >> 7n : n >> 7;
		const done = wide
			? (n === 0n && (b & 0x40) === 0) || (n === -1n && (b & 0x40) !== 0)
			: (n === 0 && (b & 0x40) === 0) || (n === -1 && (b & 0x40) !== 0);
		if (done) {
			out.push(b);
			return out;
		}
		out.push(b | 0x80);
	}
}

function wstr(s) {
	const bytes = [...new TextEncoder().encode(s)];
	return [...leb(bytes.length), ...bytes];
}

function section(id, payload) {
	return [id, ...leb(payload.length), ...payload];
}

const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const I32 = 0x7f;
const I64 = 0x7e;

const i32 = (n) => [0x41, ...sleb(n)];
const i64 = (n) => [0x42, ...sleb(BigInt(n))];
const call = (idx) => [0x10, ...leb(idx)];
const DROP = [0x1a];
const STORE8 = [0x3a, 0x00, 0x00];
const STORE32 = [0x36, 0x02, 0x00];
const LOAD32 = [0x28, 0x02, 0x00];
const LOAD8 = [0x2d, 0x00, 0x00];
const get = (i) => [0x20, ...leb(i)];
const set = (i) => [0x21, ...leb(i)];
const NO_LOCALS = [0x00];
// A locals vec of one entry: `n` i32 locals, which is the count and the type,
// not the type repeated per local.
const locals = (n) => [0x01, ...leb(n), I32];

// The imports a fixture can ask for, with the ABI signature of each.
const IMPORT_SPECS = {
	path_open: [[I32, I32, I32, I32, I32, I64, I64, I32, I32], [I32]],
	fd_write: [[I32, I32, I32, I32], [I32]],
	fd_read: [[I32, I32, I32, I32], [I32]],
	fd_close: [[I32], [I32]],
	fd_prestat_get: [[I32, I32], [I32]],
	fd_prestat_dir_name: [[I32, I32, I32], [I32]],
	fd_fdstat_get: [[I32, I32], [I32]],
};

// Every file fixture needs these four, so they are always imported in this
// order and their indices are fixed. A fixture that also needs the preopen pair
// or fd_fdstat_get appends them after, which leaves these four where they are.
const PATH_OPEN = 0;
const FD_READ = 1;
const FD_CLOSE = 2;
const FD_WRITE = 3;
const FILE_CALLS = ['path_open', 'fd_read', 'fd_close', 'fd_write'];
const PRESTAT_GET = 4;
const PRESTAT_DIR_NAME = 5;
const FDSTAT_GET = 6;
const ALL_CALLS = [...FILE_CALLS, 'fd_prestat_get', 'fd_prestat_dir_name', 'fd_fdstat_get'];

const PREOPEN_FD = 3;
const OFLAG_CREAT = 1;
const OFLAG_TRUNC = 8;
const PATH_LEN = 7;

// Scratch addresses. REPORT carries the digits a fixture wants observed, and
// FD_AT is where path_open writes the descriptor it handed out.
const IOV_AT = 64;
const PATH_AT = 2048;
const CONTENT_AT = 2060;
const TRAVERSAL_AT = 2200;
const ABSOLUTE_AT = 2300;
const FD_AT = 4096;
const NW_AT = 4100;
const NR_AT = 4104;
const ERR_AT = 4108;
const REPORT = 8192;
const PRESTAT_AT = 8240;
const PRESTAT_NAME_AT = 8264;
const FDSTAT_CONSOLE_AT = 8300;
const FDSTAT_FILE_AT = 8336;
const READ_AT = 8400;
// The cap test needs a span larger than the 1 MiB console cap, which is 18
// pages of linear memory at this offset.
const BULK_AT = 65536;
const BULK_LEN = 1048577;

// at pairs an address with the bytes to place there, so a fixture can hand the
// runtime a path or a payload without emitting a store per byte.
const at = (offset, text) => [offset, [...new TextEncoder().encode(text)]];

// buildModule assembles a module with one defined function `_start`. `datas`
// becomes an active data segment per entry. `body` must leave an empty stack.
function buildModule(names, body, datas = [], pages = 4) {
	const specs = names.map((n) => [n, ...IMPORT_SPECS[n]]);
	const startIdx = specs.length;
	const types = section(1, [
		...leb(specs.length + 1),
		...specs.flatMap(([name, params, results]) => [0x60, ...leb(params.length), ...params,
			...leb(results.length), ...results]),
		0x60, 0x00, 0x00,
	]);
	const importSec = section(2, [
		...leb(specs.length),
		...specs.flatMap(([name, , ], i) => [...wstr('wasi_snapshot_preview1'), ...wstr(name),
			0x00, ...leb(i)]),
	]);
	const funcSec = section(3, [...leb(1), ...leb(startIdx)]);
	const mem = section(5, [...leb(1), 0x00, ...leb(pages)]);
	const exports = section(7, [...leb(2), ...wstr('memory'), 0x02, ...leb(0),
		...wstr('_start'), 0x00, ...leb(startIdx)]);
	const full = [...body, 0x0b];
	const code = section(10, [...leb(1), ...leb(full.length), ...full]);
	const dataSec = section(11, [
		...leb(datas.length),
		...datas.flatMap(([offset, bytes]) => [0x00, ...i32(offset), 0x0b, ...leb(bytes.length),
			...bytes]),
	]);
	return new Uint8Array([
		...HEADER, ...types, ...importSec, ...funcSec, ...mem, ...exports, ...code, ...dataSec,
	]);
}

// iovec points one iovec at IOV_AT at `ptr` for `len` bytes.
function iovec(ptr, len) {
	return [
		...i32(IOV_AT), ...i32(ptr), ...STORE32,
		...i32(IOV_AT + 4), ...i32(len), ...STORE32,
	];
}

// writeOut(ptr, len): the fixture ends by emitting `len` bytes at `ptr` to
// stdout, so the test can read the answer. The byte count out-param is address
// 0, which is where V points it.
function writeOut(ptr, len) {
	return [
		...iovec(ptr, len),
		...i32(1), ...i32(IOV_AT), ...i32(1), ...i32(0), ...call(FD_WRITE), ...DROP,
	];
}

// openFile calls path_open, which returns an errno and writes the descriptor it
// handed out at FD_AT. Every helper below leaves the operand stack empty, so a
// body cannot drift into an imbalance the module rejects at instantiation.
function openFile(pathAt, pathLen, oflags) {
	return [
		...i32(PREOPEN_FD), ...i32(0), ...i32(pathAt), ...i32(pathLen), ...i32(oflags),
		...i64(-1), ...i64(-1), ...i32(0), ...i32(FD_AT),
		...call(PATH_OPEN), ...DROP,
	];
}

// openLocal opens a path and puts the descriptor the runtime handed out into
// `fdLocal`, which is what a body needs to read or write through it.
function openLocal(pathAt, pathLen, oflags, fdLocal) {
	return [...openFile(pathAt, pathLen, oflags), ...i32(FD_AT), ...LOAD32, ...set(fdLocal)];
}

function writeFd(fdLocal, bufAt, len, outAt) {
	return [...iovec(bufAt, len), ...get(fdLocal), ...i32(IOV_AT), ...i32(1), ...i32(outAt),
		...call(FD_WRITE), ...DROP];
}

// readFd and closeFd leave the errno on the stack, so a body either stores it
// with set(reg) through the *Err wrappers below or drops it. Nothing here
// discards a value silently, which is what keeps the stack balanced.
function readFd(fdLocal, bufAt, len, outAt) {
	return [...iovec(bufAt, len), ...get(fdLocal), ...i32(IOV_AT), ...i32(1), ...i32(outAt),
		...call(FD_READ)];
}

// readErr and closeErr keep the errno in a local, for the fixtures that assert
// on what the runtime answered rather than on the bytes it moved.
function readErr(fdLocal, bufAt, len, reg) {
	return [...readFd(fdLocal, bufAt, len, NR_AT), ...set(reg)];
}

function closeErr(fdLocal, reg) {
	return [...closeFd(fdLocal), ...set(reg)];
}

function closeFd(fdLocal) {
	return [...get(fdLocal), ...call(FD_CLOSE)];
}

// reportDigit writes '0' + (the value at `from`, transformed, mod 10) at `addr`.
// The mod is what keeps the result ASCII for a value above 1000.
function reportDigit(addr, from, transform, load = LOAD32) {
	return [...i32(addr), ...i32(48), ...i32(from), ...load, ...transform, [0x6a], ...STORE8];
}

// reportCount writes the low three decimal digits of the u32 at `from`.
function reportCount(from, addr = REPORT) {
	return [
		...reportDigit(addr, from, [...i32(100), [0x6d], ...i32(10), [0x70]]), // hundreds
		...reportDigit(addr + 1, from, [...i32(10), [0x6d], ...i32(10), [0x70]]), // tens
		...reportDigit(addr + 2, from, [...i32(10), [0x70]]), // units
	];
}

// reportEqual writes '1' when the u32 at `from` is `expected`, else '0', which
// is how a count too large for three digits is still reported exactly.
function reportEqual(from, expected, addr = REPORT) {
	return [...i32(addr), ...i32(48), ...i32(expected), ...i32(from), ...LOAD32,
		[0x46], // i32.eq
		[0x6a], ...STORE8];
}

// reportLocal copies a local into a scratch word so reportCount can read it
// back. The digits land at REPORT, which is why the word cannot be REPORT: the
// first digit written would change the value the next two read.
function reportLocal(reg) {
	return [...i32(ERR_AT), ...get(reg), ...STORE32, ...reportCount(ERR_AT)];
}

async function run(bytes, options) {
	const parts = [];
	await runWasm(bytes, (t) => parts.push(t), options);
	return parts.join('');
}

// errnoModule drives a single import and reports its errno as three decimal
// digits: EBADF reads '008', EFAULT '021' and success '000'. An argument is
// pushed as i64 when its declared parameter is i64, which is what path_open's
// two rights fields are.
function errnoModule(name, args, datas = [], pages = 4) {
	const calls = FILE_CALLS.includes(name) ? FILE_CALLS : [...FILE_CALLS, name];
	const params = IMPORT_SPECS[name][0];
	const body = [
		...locals(1),
		...args.flatMap((a, i) => (params[i] === I64 ? i64(a) : i32(a))),
		...call(calls.indexOf(name)), ...set(0),
		...reportLocal(0),
		...writeOut(REPORT, 3),
	];
	return buildModule(calls, body, datas, pages);
}

// roundTripModule writes `content` to a file, closes the descriptor, reopens
// the file and reads it back, reporting the bytes it read and then the count
// the runtime reported.
function roundTripModule(content, pages = 4) {
	const body = [
		...locals(1),
		...openLocal(PATH_AT, PATH_LEN, OFLAG_CREAT, 0),
		...writeFd(0, CONTENT_AT, content.length, NW_AT),
		...closeFd(0), ...DROP,
		...openLocal(PATH_AT, PATH_LEN, 0, 0),
		...readFd(0, READ_AT, 16, NR_AT), ...DROP,
		...writeOut(READ_AT, content.length),
		...reportCount(NR_AT),
		...writeOut(REPORT, 3),
	];
	return buildModule(FILE_CALLS, body, [at(PATH_AT, 'out.txt'), at(CONTENT_AT, content)], pages);
}

// --- the preopen ------------------------------------------------------------

test('fd_prestat_get reports the preopen and its one byte name', async () => {
	// The struct is the tag byte padded out to a u32, so the tag is at +0 and
	// the name length at +4. Writing them as one word would put a 1 in the tag.
	const body = [
		...NO_LOCALS,
		...i32(PREOPEN_FD), ...i32(PRESTAT_AT), ...call(PRESTAT_GET), ...DROP,
		...i32(PREOPEN_FD), ...i32(PRESTAT_NAME_AT), ...i32(1), ...call(PRESTAT_DIR_NAME), ...DROP,
		...reportCount(PRESTAT_AT + 4),
		...reportDigit(REPORT + 3, PRESTAT_AT, [], LOAD8),
		...writeOut(PRESTAT_NAME_AT, 1),
		...writeOut(REPORT, 4),
	];
	const bytes = buildModule(ALL_CALLS, body);
	// '/', then the name length, then the tag: 0 is the directory prestat kind.
	assert.equal(await run(bytes), '/0010');
});

test('fd_prestat_get and fd_prestat_dir_name reject another descriptor', async () => {
	const get = errnoModule('fd_prestat_get', [FD_AT, PRESTAT_AT]);
	const name = errnoModule('fd_prestat_dir_name', [FD_AT, PRESTAT_NAME_AT, 1]);
	assert.equal(await run(get), '008');
	assert.equal(await run(name), '008');
});

// --- writing and reading ----------------------------------------------------

test('a file written through path_open reads back the same bytes', async () => {
	assert.equal(await run(roundTripModule('hello wasi')), 'hello wasi010');
});

test('reopening a file appends rather than truncating', async () => {
	const body = [
		...locals(1),
		...openLocal(PATH_AT, PATH_LEN, OFLAG_CREAT, 0),
		...writeFd(0, CONTENT_AT, 3, NW_AT),
		...closeFd(0), ...DROP,
		...openLocal(PATH_AT, PATH_LEN, 0, 0),
		...writeFd(0, CONTENT_AT + 3, 3, NW_AT),
		...closeFd(0), ...DROP,
		...openLocal(PATH_AT, PATH_LEN, 0, 0),
		...readFd(0, READ_AT, 8, NR_AT), ...DROP,
		...writeOut(READ_AT, 6),
		...reportCount(NR_AT),
		...writeOut(REPORT, 3),
	];
	const bytes = buildModule(FILE_CALLS, body,
		[at(PATH_AT, 'out.txt'), at(CONTENT_AT, 'abcdef')]);
	assert.equal(await run(bytes), 'abcdef006');
});

test('an open with O_TRUNC overwrites what was there', async () => {
	// The store is append-or-overwrite, so the overwrite half has to be
	// exerciseable: O_TRUNC empties the file the descriptor opens.
	const body = [
		...locals(1),
		...openLocal(PATH_AT, PATH_LEN, OFLAG_CREAT, 0),
		...writeFd(0, CONTENT_AT, 10, NW_AT),
		...closeFd(0), ...DROP,
		...openLocal(PATH_AT, PATH_LEN, OFLAG_CREAT | OFLAG_TRUNC, 0),
		...writeFd(0, CONTENT_AT + 6, 2, NW_AT),
		...closeFd(0), ...DROP,
		...openLocal(PATH_AT, PATH_LEN, 0, 0),
		...readFd(0, READ_AT, 16, NR_AT), ...DROP,
		...writeOut(READ_AT, 2),
		...reportCount(NR_AT),
		...writeOut(REPORT, 3),
	];
	const bytes = buildModule(FILE_CALLS, body,
		[at(PATH_AT, 'out.txt'), at(CONTENT_AT, 'hello wasi')]);
	// Without the truncation the read would return all ten bytes, so 'he010'.
	assert.equal(await run(bytes), 'wa002');
});

test('the store does not survive a run', async () => {
	await run(roundTripModule('hello wasi'));
	// The second run opens the same path without O_CREAT: the store is built
	// per runWasm call, so the file the first run wrote is not there.
	const mod = errnoModule('path_open', [PREOPEN_FD, 0, PATH_AT, PATH_LEN, 0, -1, -1, 0, FD_AT],
		[at(PATH_AT, 'out.txt')]);
	assert.equal(await run(mod), '044'); // ENOENT
});

test('path_open without O_CREAT refuses a file that does not exist', async () => {
	const mod = errnoModule('path_open', [PREOPEN_FD, 0, PATH_AT, PATH_LEN, 0, -1, -1, 0, FD_AT],
		[at(PATH_AT, 'out.txt')]);
	assert.equal(await run(mod), '044'); // ENOENT
});

// --- refused paths ----------------------------------------------------------

test('path_open rejects an out of range path pointer', async () => {
	// -1 reaches JS as a signed i32; the >>> 0 coercion turns it into
	// 4294967295, which fails the bounds check and yields EFAULT instead of a
	// RangeError from the DataView.
	const mod = errnoModule('path_open', [PREOPEN_FD, 0, -1, 7, OFLAG_CREAT, -1, -1, 0, FD_AT]);
	assert.equal(await run(mod), '021');
});

test('path_open rejects an out of range descriptor out-param', async () => {
	const mod = errnoModule('path_open', [PREOPEN_FD, 0, PATH_AT, PATH_LEN, OFLAG_CREAT, -1, -1, 0,
		-1], [at(PATH_AT, 'out.txt')]);
	assert.equal(await run(mod), '021');
});

test('path_open rejects a path that walks out of the root', async () => {
	const parent = errnoModule('path_open', [PREOPEN_FD, 0, TRAVERSAL_AT, 9, OFLAG_CREAT, -1, -1, 0,
		FD_AT], [at(TRAVERSAL_AT, '../secret')]);
	const absolute = errnoModule('path_open', [PREOPEN_FD, 0, ABSOLUTE_AT, 11, OFLAG_CREAT, -1, -1, 0,
		FD_AT], [at(ABSOLUTE_AT, '/etc/passwd')]);
	// The store has no directory tree, so both are refused rather than resolved.
	assert.equal(await run(parent), '063'); // EPERM
	assert.equal(await run(absolute), '063');
});

test('path_open rejects an unknown directory descriptor', async () => {
	const mod = errnoModule('path_open', [9, 0, PATH_AT, PATH_LEN, OFLAG_CREAT, -1, -1, 0, FD_AT],
		[at(PATH_AT, 'out.txt')]);
	assert.equal(await run(mod), '008'); // EBADF
});

// --- descriptors ------------------------------------------------------------

test('fd_close releases a descriptor it handed out', async () => {
	// Closing twice has to fail the second time: that is what proves the first
	// call released the descriptor instead of ignoring it. The errno goes to a
	// second local, because the descriptor itself is still needed for the call.
	const body = [
		...locals(2),
		...openLocal(PATH_AT, PATH_LEN, OFLAG_CREAT, 0),
		...writeFd(0, CONTENT_AT, 5, NW_AT),
		...closeErr(0, 1),
		...closeErr(0, 1),
		...reportLocal(1),
		...writeOut(REPORT, 3),
	];
	const bytes = buildModule(FILE_CALLS, body,
		[at(PATH_AT, 'out.txt'), at(CONTENT_AT, 'hello')]);
	assert.equal(await run(bytes), '008');
});

test('fd_close reports EBADF for a descriptor that was never open', async () => {
	const mod = errnoModule('fd_close', [9]);
	assert.equal(await run(mod), '008');
});

test('a closed descriptor refuses a read', async () => {
	const body = [
		...locals(2),
		...openLocal(PATH_AT, PATH_LEN, OFLAG_CREAT, 0),
		...writeFd(0, CONTENT_AT, 5, NW_AT),
		...closeFd(0), ...DROP,
		...readErr(0, READ_AT, 8, 1),
		...reportLocal(1),
		...writeOut(REPORT, 3),
	];
	const bytes = buildModule(FILE_CALLS, body,
		[at(PATH_AT, 'out.txt'), at(CONTENT_AT, 'hello')]);
	assert.equal(await run(bytes), '008');
});

test('fd_close on the console is a no-op that leaves it usable', async () => {
	const body = [
		...locals(1),
		...i32(1), ...call(FD_CLOSE), ...set(0),
		...reportLocal(0),
		...writeOut(CONTENT_AT, 2),
		...writeOut(REPORT, 3),
	];
	const bytes = buildModule(FILE_CALLS, body, [at(CONTENT_AT, 'ok')]);
	assert.equal(await run(bytes), 'ok000');
});

test('fd_fdstat_get tells a console descriptor from a file', async () => {
	const body = [
		...locals(1),
		...i32(1), ...i32(FDSTAT_CONSOLE_AT), ...call(FDSTAT_GET), ...DROP,
		...openLocal(PATH_AT, PATH_LEN, OFLAG_CREAT, 0),
		...get(0), ...i32(FDSTAT_FILE_AT), ...call(FDSTAT_GET), ...DROP,
		...reportDigit(REPORT, FDSTAT_CONSOLE_AT, [], LOAD8),
		...reportDigit(REPORT + 1, FDSTAT_FILE_AT, [], LOAD8),
		...writeOut(REPORT, 2),
	];
	const bytes = buildModule(ALL_CALLS, body, [at(PATH_AT, 'out.txt')]);
	// 2 is a character device, 4 a regular file.
	assert.equal(await run(bytes), '24');
});

test('fd_fdstat_get reports EBADF for an unknown descriptor', async () => {
	const mod = errnoModule('fd_fdstat_get', [9, FDSTAT_FILE_AT]);
	assert.equal(await run(mod), '008');
});

// --- the output cap ---------------------------------------------------------

test('writing a file past the output cap does not trip it', async () => {
	// One call writes more than the 1 MiB console cap into the store, and the
	// run stays quiet because the console is never written to.
	const body = [
		...locals(1),
		...openLocal(PATH_AT, PATH_LEN, OFLAG_CREAT, 0),
		...writeFd(0, BULK_AT, BULK_LEN, NW_AT),
		...closeFd(0), ...DROP,
		...openLocal(PATH_AT, PATH_LEN, 0, 0),
		...readFd(0, BULK_AT, BULK_LEN, NR_AT), ...DROP,
		...reportEqual(NR_AT, BULK_LEN),
		...writeOut(REPORT, 1),
	];
	const bytes = buildModule(FILE_CALLS, body, [at(PATH_AT, 'bulk.bin')], 18);
	assert.equal(await run(bytes), '1');
});

test('the same span written to the console still trips the cap', async () => {
	// The control for the test above: the cap is real, so a fixture that writes
	// the identical span to stdout is refused.
	const body = [...NO_LOCALS, ...writeOut(BULK_AT, BULK_LEN)];
	const bytes = buildModule(FILE_CALLS, body, [], 18);
	await assert.rejects(() => run(bytes), /1 MiB/);
});
