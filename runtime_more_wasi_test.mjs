// Tests for the remaining WASI surface of runtime.mjs: the environment, the
// descriptor calls that position and reconfigure an open file, and the path
// calls that create and remove entries in the store. Each fixture is a
// hand-built module importing only the calls it needs, so a missing import
// fails at instantiation rather than in the body under test, and each answer
// is reported through ASCII bytes so it survives UTF-8 decoding intact.
//
// The fixtures are assembled from raw sections rather than compiled from V,
// because that keeps each one honest about exactly which imports it declares.
//
// Run: node --test runtime_more_wasi_test.mjs
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

// fd_seek declares its offset as i64, which wasm hands to the host as BigInt,
// so the encoder has to cope with both widths.
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

// The ABI signatures of the imports a fixture can ask for.
const IMPORT_SPECS = {
	environ_sizes_get: [[I32, I32], [I32]],
	environ_get: [[I32, I32], [I32]],
	fd_write: [[I32, I32, I32, I32], [I32]],
	fd_read: [[I32, I32, I32, I32], [I32]],
	fd_close: [[I32], [I32]],
	fd_seek: [[I32, I64, I32, I32], [I32]],
	fd_tell: [[I32, I32], [I32]],
	path_open: [[I32, I32, I32, I32, I32, I64, I64, I32, I32], [I32]],
	path_filestat_get: [[I32, I32, I32, I32, I32], [I32]],
	path_create_directory: [[I32, I32, I32], [I32]],
	path_unlink_file: [[I32, I32, I32], [I32]],
	path_remove_directory: [[I32, I32, I32], [I32]],
	fd_fdstat_set_flags: [[I32, I32], [I32]],
	sched_yield: [[], [I32]],
};

// indexer maps an import name onto the index it holds in one module's import
// section, so a body can name the call it emits and a fixture still declares
// only what its body calls.
const indexer = (names) => (name) => names.indexOf(name);

const PREOPEN_FD = 3;
const OFLAG_CREAT = 1;
const OFLAG_TRUNC = 8;
const FDFLAG_APPEND = 1;
const SEEK_SET = 0;
// The size field of a __wasi_filestat_t sits past four u64s.
const FILESTAT_SIZE_AT = 32;
const BOGUS_FD = 9;

// Scratch addresses. IOV_AT holds the one iovec every write goes through,
// REPORT the bytes a fixture wants observed, and FD_AT where path_open writes
// the descriptor it handed out.
const IOV_AT = 64;
const PATH_AT = 2048;
const PATH_LEN = 7; // 'out.txt'
const CONTENT_AT = 2100;
const DIR_PATH_AT = 2200;
const DIR_PATH_LEN = 3; // 'sub'
const NESTED_AT = 2220;
const NESTED_LEN = 14; // 'sub/inside.txt'
const ESCAPE_AT = 2300;
const ESCAPE_LEN = 9; // '../escape'
const ESCAPE_ROOT_AT = 2350;
const ESCAPE_ROOT_LEN = 6; // 'escape'
const UNMAPPED_AT = 2400;
const UNMAPPED_LEN = 11; // 'no/such/file'
const GONEDIR_AT = 2500;
const GONEDIR_LEN = 7; // 'gonedir'
const CHILD_AT = 2520;
const CHILD_LEN = 13; // 'gonedir/child'
const BULK_PATH_AT = 2600;
const BULK_PATH_LEN = 8; // 'bulk.bin'
const BULK_AT = 65536;
const BULK_LEN = 1048577;
// The bulk span is filled with `i & 0xff`, so its last four bytes, 253 254
// 255 0, read back as one little-endian word a guest can compare without
// having to emit them as text.
const BULK_TAIL = 0x00fffefd;
const FD_AT = 4096;
const NW_AT = 4100;
const NR_AT = 4104;
const ERR_AT = 4108;
const SEEK_AT = 4112;
const TELL_AT = 4120;
const COUNT_AT = 4128;
const BUF_SIZE_AT = 4132;
const ENV_PTR_AT = 4136;
const ENV_BUF_AT = 4160;
const STAT_AT = 4224;
const READ_AT = 4296;
const REPORT = 8192;

// at pairs an address with the bytes to place there, so a fixture can hand the
// runtime a path or a payload without emitting a store per byte.
const at = (offset, text) => [offset, [...new TextEncoder().encode(text)]];
const atBytes = (offset, bytes) => [offset, [...bytes]];

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
function writeOut(k, ptr, len) {
	return [
		...iovec(ptr, len),
		...i32(1), ...i32(IOV_AT), ...i32(1), ...i32(0), ...call(k('fd_write')), ...DROP,
	];
}

// openFile calls path_open, which returns an errno and writes the descriptor
// it handed out at FD_AT. Every helper below leaves the operand stack empty,
// so a body cannot drift into an imbalance the module rejects at instantiation.
function openFile(k, pathAt, pathLen, oflags) {
	return [
		...i32(PREOPEN_FD), ...i32(0), ...i32(pathAt), ...i32(pathLen), ...i32(oflags),
		...i64(-1), ...i64(-1), ...i32(0), ...i32(FD_AT),
		...call(k('path_open')), ...DROP,
	];
}

// openLocal opens a path and puts the descriptor the runtime handed out into
// `fdLocal`, which is what a body needs to read or write through it.
function openLocal(k, pathAt, pathLen, oflags, fdLocal) {
	return [...openFile(k, pathAt, pathLen, oflags), ...i32(FD_AT), ...LOAD32, ...set(fdLocal)];
}

function writeFd(k, fdLocal, bufAt, len, outAt) {
	return [...iovec(bufAt, len), ...get(fdLocal), ...i32(IOV_AT), ...i32(1), ...i32(outAt),
		...call(k('fd_write')), ...DROP];
}

// readFd leaves the errno on the stack, so a body either stores it with
// set(reg) or drops it. Nothing here discards a value silently, which is what
// keeps the stack balanced.
function readFd(k, fdLocal, bufAt, len, outAt) {
	return [...iovec(bufAt, len), ...get(fdLocal), ...i32(IOV_AT), ...i32(1), ...i32(outAt),
		...call(k('fd_read'))];
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
// back. Several errnos can be reported in one write, which is why the address
// is a parameter; the digits land there, so the word itself must be elsewhere.
function reportLocal(reg, addr = REPORT) {
	return [...i32(ERR_AT), ...get(reg), ...STORE32, ...reportCount(ERR_AT, addr)];
}

async function run(bytes, options) {
	const parts = [];
	await runWasm(bytes, (t) => parts.push(t), options);
	return parts.join('');
}

// --- the environment --------------------------------------------------------

const ENVIRON_CALLS = ['environ_sizes_get', 'environ_get', 'fd_write'];

test('environ sizes then content round trip reports the same two entries', async () => {
	const k = indexer(ENVIRON_CALLS);
	const body = [
		...NO_LOCALS,
		...i32(COUNT_AT), ...i32(BUF_SIZE_AT), ...call(k('environ_sizes_get')), ...DROP,
		...i32(ENV_PTR_AT), ...i32(ENV_BUF_AT), ...call(k('environ_get')), ...DROP,
		...reportCount(COUNT_AT, REPORT),
		...reportCount(BUF_SIZE_AT, REPORT + 3),
		...writeOut(k, REPORT, 6),
		...writeOut(k, ENV_BUF_AT, 13),
	];
	const out = await run(buildModule(ENVIRON_CALLS, body));
	assert.equal(out.slice(0, 3), '002', 'entry count');
	assert.equal(out.slice(3, 6), '013', 'buffer size for a five and a six byte entry');
	// Both halves answer from the one array, so the strings handed over are
	// the pair the sizes described, and nothing is dropped on the second ask.
	assert.deepEqual(out.slice(6).split('\u0000'), ['PWD=/', 'HOME=/', '']);
});

// --- seek, tell and the round trip -----------------------------------------

const ROUND_TRIP_CALLS = ['path_open', 'fd_write', 'fd_read', 'fd_close', 'fd_seek'];

test('a file written with O_TRUNC reads back identical after a seek to 0', async () => {
	const k = indexer(ROUND_TRIP_CALLS);
	const body = [
		...locals(2),
		...openLocal(k, PATH_AT, PATH_LEN, OFLAG_CREAT | OFLAG_TRUNC, 0),
		...writeFd(k, 0, CONTENT_AT, 10, NW_AT),
		...get(0), ...i64(0), ...i32(SEEK_SET), ...i32(SEEK_AT),
		...call(k('fd_seek')), ...set(1),
		...readFd(k, 0, READ_AT, 16, NR_AT), ...DROP,
		...writeOut(k, READ_AT, 10),
		...reportLocal(1),
		...writeOut(k, REPORT, 3),
		...reportCount(NR_AT),
		...writeOut(k, REPORT, 3),
	];
	const bytes = buildModule(ROUND_TRIP_CALLS, body, [at(PATH_AT, 'out.txt'),
		at(CONTENT_AT, 'round trip')]);
	// The bytes, then the seek errno, then how many the read returned.
	assert.equal(await run(bytes), 'round trip000010');
});

const TELL_CALLS = ['path_open', 'fd_write', 'fd_close', 'fd_seek', 'fd_tell'];

test('fd_tell reports the position a seek left and refuses the console', async () => {
	const k = indexer(TELL_CALLS);
	const body = [
		...locals(3),
		...openLocal(k, PATH_AT, PATH_LEN, OFLAG_CREAT | OFLAG_TRUNC, 0),
		...writeFd(k, 0, CONTENT_AT, 5, NW_AT),
		...get(0), ...i64(3), ...i32(SEEK_SET), ...i32(SEEK_AT),
		...call(k('fd_seek')), ...DROP,
		...get(0), ...i32(TELL_AT), ...call(k('fd_tell')), ...set(1),
		...reportCount(TELL_AT),
		// A console descriptor is not seekable, so the tell refuses before it
		// writes anything and the offset above is the one that stands.
		...i32(1), ...i32(TELL_AT), ...call(k('fd_tell')), ...set(2),
		...reportLocal(1, REPORT + 3),
		...reportLocal(2, REPORT + 6),
		...writeOut(k, REPORT, 9),
	];
	const bytes = buildModule(TELL_CALLS, body, [at(PATH_AT, 'out.txt'),
		at(CONTENT_AT, 'hello')]);
	// The offset, then the two errnos: 68 is ESPIPE.
	assert.equal(await run(bytes), '003000068');
});

// --- filestat --------------------------------------------------------------

const FILESTAT_CALLS = ['path_open', 'fd_write', 'fd_close', 'path_filestat_get'];

test('path_filestat_get reports the byte size of a written file', async () => {
	const k = indexer(FILESTAT_CALLS);
	const body = [
		...locals(1),
		...openLocal(k, PATH_AT, PATH_LEN, OFLAG_CREAT | OFLAG_TRUNC, 0),
		...writeFd(k, 0, CONTENT_AT, 7, NW_AT),
		...get(0), ...call(k('fd_close')), ...DROP,
		...i32(PREOPEN_FD), ...i32(0), ...i32(PATH_AT), ...i32(PATH_LEN), ...i32(STAT_AT),
		...call(k('path_filestat_get')), ...set(0),
		...reportLocal(0),
		...writeOut(k, REPORT, 3),
		...reportCount(STAT_AT + FILESTAT_SIZE_AT),
		...writeOut(k, REPORT, 3),
		...reportDigit(REPORT, STAT_AT + 16, [], LOAD8),
		...writeOut(k, REPORT, 1),
	];
	const bytes = buildModule(FILESTAT_CALLS, body, [at(PATH_AT, 'out.txt'),
		at(CONTENT_AT, 'written')]);
	// The errno, the 7 bytes the file holds, and the filetype byte: 4 is a
	// regular file, which is what separates it from a directory.
	assert.equal(await run(bytes), '0000074');
});

// --- directories -----------------------------------------------------------

const NESTED_CALLS = ['path_open', 'fd_write', 'fd_read', 'fd_close',
	'path_create_directory', 'path_filestat_get'];

test('a file inside a created directory opens, writes and reads back', async () => {
	const k = indexer(NESTED_CALLS);
	const body = [
		...locals(2),
		...i32(PREOPEN_FD), ...i32(DIR_PATH_AT), ...i32(DIR_PATH_LEN),
		...call(k('path_create_directory')), ...set(1),
		...openLocal(k, NESTED_AT, NESTED_LEN, OFLAG_CREAT, 0),
		...writeFd(k, 0, CONTENT_AT, 9, NW_AT),
		...get(0), ...call(k('fd_close')), ...DROP,
		...openLocal(k, NESTED_AT, NESTED_LEN, 0, 0),
		...readFd(k, 0, READ_AT, 16, NR_AT), ...DROP,
		...writeOut(k, READ_AT, 9),
		...reportLocal(1),
		...writeOut(k, REPORT, 3),
		// The directory the file was written inside is itself a directory, not
		// a file the runtime invented to make the path resolvable.
		...i32(PREOPEN_FD), ...i32(0), ...i32(DIR_PATH_AT), ...i32(DIR_PATH_LEN), ...i32(STAT_AT),
		...call(k('path_filestat_get')), ...DROP,
		...reportDigit(REPORT, STAT_AT + 16, [], LOAD8),
		...writeOut(k, REPORT, 1),
	];
	const bytes = buildModule(NESTED_CALLS, body, [at(DIR_PATH_AT, 'sub'),
		at(NESTED_AT, 'sub/inside.txt'), at(CONTENT_AT, 'nested ok')]);
	assert.equal(await run(bytes), 'nested ok0003');
});

const UNLINK_CALLS = ['path_open', 'fd_write', 'fd_close', 'path_unlink_file',
	'path_filestat_get'];

test('path_unlink_file removes a file, confirmed by a stat that says ENOENT', async () => {
	const k = indexer(UNLINK_CALLS);
	const body = [
		...locals(3),
		...openLocal(k, PATH_AT, PATH_LEN, OFLAG_CREAT | OFLAG_TRUNC, 0),
		...writeFd(k, 0, CONTENT_AT, 4, NW_AT),
		...get(0), ...call(k('fd_close')), ...DROP,
		...i32(PREOPEN_FD), ...i32(PATH_AT), ...i32(PATH_LEN),
		...call(k('path_unlink_file')), ...set(1),
		...i32(PREOPEN_FD), ...i32(0), ...i32(PATH_AT), ...i32(PATH_LEN), ...i32(STAT_AT),
		...call(k('path_filestat_get')), ...set(2),
		...reportLocal(1, REPORT),
		...reportLocal(2, REPORT + 3),
		...writeOut(k, REPORT, 6),
	];
	const bytes = buildModule(UNLINK_CALLS, body, [at(PATH_AT, 'out.txt'),
		at(CONTENT_AT, 'gone')]);
	// The unlink succeeded and the entry the guest wrote is no longer there.
	assert.equal(await run(bytes), '000044');
});

const RMDIR_CALLS = ['path_create_directory', 'path_remove_directory', 'fd_write'];

test('path_remove_directory takes an empty directory it created', async () => {
	const k = indexer(RMDIR_CALLS);
	const body = [
		...locals(3),
		...i32(PREOPEN_FD), ...i32(GONEDIR_AT), ...i32(GONEDIR_LEN),
		...call(k('path_create_directory')), ...set(1),
		...i32(PREOPEN_FD), ...i32(GONEDIR_AT), ...i32(GONEDIR_LEN),
		...call(k('path_remove_directory')), ...set(2),
		// The directory is gone, so a path inside it has no parent to resolve.
		// Were the removal a no-op this call would succeed instead.
		...i32(PREOPEN_FD), ...i32(CHILD_AT), ...i32(CHILD_LEN),
		...call(k('path_create_directory')), ...set(0),
		...reportLocal(1, REPORT),
		...reportLocal(2, REPORT + 3),
		...reportLocal(0, REPORT + 6),
		...writeOut(k, REPORT, 9),
	];
	const bytes = buildModule(RMDIR_CALLS, body, [at(GONEDIR_AT, 'gonedir'),
		at(CHILD_AT, 'gonedir/child')]);
	assert.equal(await run(bytes), '000000044');
});

// --- append ----------------------------------------------------------------

const APPEND_CALLS = ['path_open', 'fd_write', 'fd_read', 'fd_close',
	'fd_fdstat_set_flags'];

test('fd_fdstat_set_flags with append makes the next write concatenate', async () => {
	const k = indexer(APPEND_CALLS);
	const body = [
		...locals(2),
		...openLocal(k, PATH_AT, PATH_LEN, OFLAG_CREAT | OFLAG_TRUNC, 0),
		...writeFd(k, 0, CONTENT_AT, 3, NW_AT),
		...get(0), ...i32(FDFLAG_APPEND), ...call(k('fd_fdstat_set_flags')), ...set(1),
		...writeFd(k, 0, CONTENT_AT + 3, 3, NW_AT),
		...get(0), ...call(k('fd_close')), ...DROP,
		...openLocal(k, PATH_AT, PATH_LEN, 0, 0),
		...readFd(k, 0, READ_AT, 12, NR_AT), ...DROP,
		...writeOut(k, READ_AT, 6),
		...reportLocal(1),
		...writeOut(k, REPORT, 3),
	];
	const bytes = buildModule(APPEND_CALLS, body, [at(PATH_AT, 'out.txt'),
		at(CONTENT_AT, 'abcdef')]);
	// A store write leaves the descriptor's position where it started, so
	// without the append flag the second write would overwrite the first.
	assert.equal(await run(bytes), 'abcdef000');
});

// --- sched_yield -----------------------------------------------------------

const YIELD_CALLS = ['sched_yield', 'fd_write'];

test('sched_yield succeeds', async () => {
	const k = indexer(YIELD_CALLS);
	const body = [
		...locals(1),
		...call(k('sched_yield')), ...set(0),
		...reportLocal(0),
		...writeOut(k, REPORT, 3),
	];
	assert.equal(await run(buildModule(YIELD_CALLS, body)), '000');
});

// --- refused descriptors ---------------------------------------------------

const EBADF_CALLS = ['fd_seek', 'fd_tell', 'path_filestat_get', 'path_create_directory',
	'path_unlink_file', 'path_remove_directory', 'fd_fdstat_set_flags', 'fd_write'];

test('every descriptor and path call reports EBADF for a bogus descriptor', async () => {
	const k = indexer(EBADF_CALLS);
	const body = [
		...locals(1),
		...i32(BOGUS_FD), ...i64(0), ...i32(SEEK_SET), ...i32(SEEK_AT),
		...call(k('fd_seek')), ...set(0),
		...reportLocal(0, REPORT),
		...i32(BOGUS_FD), ...i32(TELL_AT), ...call(k('fd_tell')), ...set(0),
		...reportLocal(0, REPORT + 3),
		...i32(BOGUS_FD), ...i32(0), ...i32(PATH_AT), ...i32(PATH_LEN), ...i32(STAT_AT),
		...call(k('path_filestat_get')), ...set(0),
		...reportLocal(0, REPORT + 6),
		...i32(BOGUS_FD), ...i32(PATH_AT), ...i32(PATH_LEN),
		...call(k('path_create_directory')), ...set(0),
		...reportLocal(0, REPORT + 9),
		...i32(BOGUS_FD), ...i32(PATH_AT), ...i32(PATH_LEN),
		...call(k('path_unlink_file')), ...set(0),
		...reportLocal(0, REPORT + 12),
		...i32(BOGUS_FD), ...i32(PATH_AT), ...i32(PATH_LEN),
		...call(k('path_remove_directory')), ...set(0),
		...reportLocal(0, REPORT + 15),
		...i32(BOGUS_FD), ...i32(FDFLAG_APPEND), ...call(k('fd_fdstat_set_flags')), ...set(0),
		...reportLocal(0, REPORT + 18),
		...writeOut(k, REPORT, 21),
	];
	const bytes = buildModule(EBADF_CALLS, body, [at(PATH_AT, 'out.txt')]);
	assert.equal(await run(bytes), '008'.repeat(7));
});

// --- refused paths ---------------------------------------------------------

const TRAVERSAL_CALLS = ['path_open', 'path_create_directory', 'path_filestat_get', 'fd_write'];

test('a path that walks out of the root is refused by open, mkdir and stat', async () => {
	const k = indexer(TRAVERSAL_CALLS);
	const body = [
		...locals(1),
		...i32(PREOPEN_FD), ...i32(0), ...i32(ESCAPE_AT), ...i32(ESCAPE_LEN), ...i32(OFLAG_CREAT),
		...i64(-1), ...i64(-1), ...i32(0), ...i32(FD_AT), ...call(k('path_open')), ...set(0),
		...reportLocal(0, REPORT),
		...i32(PREOPEN_FD), ...i32(ESCAPE_AT), ...i32(ESCAPE_LEN),
		...call(k('path_create_directory')), ...set(0),
		...reportLocal(0, REPORT + 3),
		...i32(PREOPEN_FD), ...i32(0), ...i32(ESCAPE_AT), ...i32(ESCAPE_LEN), ...i32(STAT_AT),
		...call(k('path_filestat_get')), ...set(0),
		...reportLocal(0, REPORT + 6),
		// The descriptor and the store both work, so the three refusals above
		// are about the path rather than about a dead directory descriptor.
		...i32(PREOPEN_FD), ...i32(ESCAPE_ROOT_AT), ...i32(ESCAPE_ROOT_LEN),
		...call(k('path_create_directory')), ...set(0),
		...reportLocal(0, REPORT + 9),
		...i32(PREOPEN_FD), ...i32(0), ...i32(ESCAPE_ROOT_AT), ...i32(ESCAPE_ROOT_LEN),
		...i32(STAT_AT), ...call(k('path_filestat_get')), ...set(0),
		...reportLocal(0, REPORT + 12),
		...reportDigit(REPORT + 15, STAT_AT + 16, [], LOAD8),
		...writeOut(k, REPORT, 16),
	];
	const bytes = buildModule(TRAVERSAL_CALLS, body, [at(ESCAPE_AT, '../escape'),
		at(ESCAPE_ROOT_AT, 'escape')]);
	// 63 is EPERM, three times, then the directory the runtime did create.
	assert.equal(await run(bytes), '0630630630000003');
});

const UNMAPPED_CALLS = ['path_filestat_get', 'fd_write'];

test('path_filestat_get reports ENOENT for a path whose parent does not exist', async () => {
	const k = indexer(UNMAPPED_CALLS);
	const body = [
		...locals(1),
		...i32(PREOPEN_FD), ...i32(0), ...i32(UNMAPPED_AT), ...i32(UNMAPPED_LEN), ...i32(STAT_AT),
		...call(k('path_filestat_get')), ...set(0),
		...reportLocal(0),
		...writeOut(k, REPORT, 3),
	];
	const bytes = buildModule(UNMAPPED_CALLS, body, [at(UNMAPPED_AT, 'no/such/file')]);
	assert.equal(await run(bytes), '044');
});

// --- the output cap --------------------------------------------------------

const BULK_CALLS = ['path_open', 'fd_write', 'fd_read', 'fd_close', 'fd_seek'];

test('a file write past the output cap leaves the console cap untripped', async () => {
	const k = indexer(BULK_CALLS);
	const body = [
		...locals(1),
		...openLocal(k, BULK_PATH_AT, BULK_PATH_LEN, OFLAG_CREAT | OFLAG_TRUNC, 0),
		...writeFd(k, 0, BULK_AT, BULK_LEN, NW_AT),
		...get(0), ...i64(BULK_LEN - 4), ...i32(SEEK_SET), ...i32(SEEK_AT),
		...call(k('fd_seek')), ...DROP,
		...readFd(k, 0, READ_AT, 4, NR_AT), ...DROP,
		...get(0), ...call(k('fd_close')), ...DROP,
		...reportEqual(NW_AT, BULK_LEN, REPORT),
		...reportCount(NR_AT, REPORT + 1),
		...reportEqual(READ_AT, BULK_TAIL, REPORT + 4),
		...writeOut(k, REPORT, 5),
	];
	const bulk = new Uint8Array(BULK_LEN);
	for (let i = 0; i < BULK_LEN; i++) bulk[i] = i & 0xff;
	const bytes = buildModule(BULK_CALLS, body, [at(BULK_PATH_AT, 'bulk.bin'),
		atBytes(BULK_AT, bulk)], 18);
	const out = await run(bytes);
	// The byte counter the runtime wrote back is the whole span, the tail read
	// from it matches, and the console's only output is the report itself.
	assert.equal(out, '10041');
	assert.equal(out.length, 5, 'the console received only the report bytes');
});

