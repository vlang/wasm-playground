// Guests that model what V compiles to wasm, rather than the smallest module
// that reaches one call: a program that writes a file and reads it back, one
// that walks its argv, and one that prints its environment. Each fixture is
// assembled from raw sections so it stays honest about which imports it
// declares, holds its strings in active data segments the way a compiled module
// does, and calls each import by the index its own import section gives it.
//
// The existing suites answer "does one call behave". These answer "does the
// runtime drive a program that keeps state across calls": a loop writing into
// the store, a pointer array the guest walks itself, a seek between a write and
// the read that follows it.
//
// Run: node --test runtime_guest_test.mjs
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

// path_open declares its two rights fields as i64 and fd_seek its offset, which
// wasm hands to the host as BigInt, so the encoder has to cope with both widths.
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
// A locals vec of one entry: `n` i32 locals, which is the count and the type,
// not the type repeated per local.
const locals = (n) => [0x01, ...leb(n), I32];
const ADD = [0x6a];
const MUL = [0x6c];
const EQZ = [0x45];
const GE_S = [0x4e];
const GE_U = [0x4f];
// memory.grow in its MVP form, the reserved memory-index byte included.
const GROW = [0x40, 0x00];

// A guest loop is a void block holding a void loop. BREAK_IF(1) leaves the block
// once the counter has reached its target and BREAK(0) repeats the body.
const LOOP_OPEN = [0x02, 0x40, 0x03, 0x40];
const LOOP_CLOSE = [0x0b, 0x0b];
const BREAK = (depth) => [0x0c, ...leb(depth)];
const BREAK_IF = (depth) => [0x0d, ...leb(depth)];

// The ABI signatures of the imports a guest below can ask for.
const IMPORT_SPECS = {
	path_open: [[I32, I32, I32, I32, I32, I64, I64, I32, I32], [I32]],
	path_create_directory: [[I32, I32, I32], [I32]],
	fd_write: [[I32, I32, I32, I32], [I32]],
	fd_read: [[I32, I32, I32, I32], [I32]],
	fd_seek: [[I32, I64, I32, I32], [I32]],
	fd_close: [[I32], [I32]],
	args_sizes_get: [[I32, I32], [I32]],
	args_get: [[I32, I32], [I32]],
	environ_sizes_get: [[I32, I32], [I32]],
	environ_get: [[I32, I32], [I32]],
};

// indexer maps an import name onto the index it holds in one module's import
// section, so a body names the call it emits and a guest still declares only
// what its body calls.
const indexer = (names) => (name) => names.indexOf(name);

// The imports each guest declares, in an order deliberately unrelated to the
// order the body calls them: fd_write sits at index 0 of the file guest and the
// first call is path_create_directory, and args_get sits at index 0 of the args
// guest while the first call is args_sizes_get. The bug this catches is a host
// that binds an import by the position the guest declares it at -- one that
// zips the guest's import list against its own handler table instead of
// resolving by name. Such a host answers args_sizes_get with the second entry
// of runtime.mjs's own table, which is proc_exit, so the program would exit with
// the errno rather than print anything, and the answer never reaches a compare
// that could pass by accident.
const FILE_IMPORTS = ['fd_write', 'path_create_directory', 'fd_read', 'path_open',
	'fd_seek', 'fd_close'];
const ARGS_IMPORTS = ['args_get', 'args_sizes_get', 'fd_write'];
const ENVIRON_IMPORTS = ['environ_get', 'fd_write', 'environ_sizes_get'];

const PREOPEN_FD = 3;
const OFLAG_CREAT = 1;
const SEEK_SET = 0;
// The content the file guest emits, one chunk of four bytes per loop pass.
const CONTENT = 'ABCDEFGHIJKLMNOP';
const CHUNK = 4;

// Scratch addresses. Each guest is its own module and its own linear memory, so
// an address is only named for the role it plays inside one guest.
const IOV_AT = 64;
const DIR_AT = 2048;
const DIR_LEN = 3; // 'sub'
const PATH_AT = 2080;
const PATH_LEN = 13; // 'sub/notes.txt'
const CONTENT_AT = 2110;
const FD_AT = 4096;
const NW_AT = 4100;
const NR_AT = 4104;
const ERR_AT = 4108;
const SEEK_AT = 4116;
const READ_AT = 4224;
const COUNT_AT = 6144;
const BUF_SIZE_AT = 6148;
const NL_AT = 6160;
// The pointer array args_get and environ_get fill, and the strings behind it.
const VECTOR_AT = 8192;
const VECTOR_BUF_AT = 8320;
const REPORT = 16384;

// at pairs an address with the bytes to place there, so a guest can hand the
// runtime a path or a payload without emitting a store per byte.
const at = (offset, text) => [offset, [...new TextEncoder().encode(text)]];
const atBytes = (offset, bytes) => [offset, [...bytes]];

// buildModule assembles a module with one defined function `_start`. `datas`
// becomes an active data segment per entry. `body` must be flat -- a nested
// array would be coerced to one 0x00 byte, which lands as an `unreachable` --
// and must leave an empty stack.
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

// storeIovec points the iovec at IOV_AT at whatever `buf` and `len` compute to,
// which is what lets a loop build the descriptor it is about to call with.
function storeIovec(buf, len) {
	return [
		...i32(IOV_AT), ...buf, ...STORE32,
		...i32(IOV_AT + 4), ...len, ...STORE32,
	];
}

// chunkAt pushes the address of chunk `i` of the content, which is the base
// plus the chunk size times the write loop's counter.
function chunkAt(i) {
	return [...get(i), ...i32(CHUNK), ...MUL, ...i32(CONTENT_AT), ...ADD];
}

// readAt pushes the read buffer plus however many bytes the read loop has
// already taken, so the next read lands where the last one stopped.
function readAt(i) {
	return [...get(i), ...i32(READ_AT), ...ADD];
}

// vectorEntry pushes the pointer stored in word `i` of a vector the host
// filled: the pointer array base plus four times the walking counter.
function vectorEntry(i) {
	return [...i32(VECTOR_AT), ...get(i), ...i32(4), ...MUL, ...ADD, ...LOAD32];
}

// strByteAt pushes the byte at `ptr + n`, which is how a guest finds the NUL
// the host wrote behind a string it was given no length for.
function strByteAt(ptr, n) {
	return [...get(ptr), ...get(n), ...ADD, ...LOAD8];
}

// writeOut emits `buf` for `len` bytes to stdout, so the test can read the
// answer. The byte count out-param is address 0, which is where V points it.
function writeOut(k, buf, len) {
	return [...storeIovec(buf, len), ...i32(1), ...i32(IOV_AT), ...i32(1), ...i32(0),
		...call(k('fd_write')), ...DROP];
}

// openFile calls path_open, which returns an errno and writes the descriptor it
// handed out at FD_AT. Every helper below leaves the operand stack empty, so a
// body cannot drift into an imbalance the module rejects at instantiation.
function openFile(k, pathAt, pathLen, oflags) {
	return [...i32(PREOPEN_FD), ...i32(0), ...i32(pathAt), ...i32(pathLen), ...i32(oflags),
		...i64(-1), ...i64(-1), ...i32(0), ...i32(FD_AT),
		...call(k('path_open')), ...DROP];
}

// openLocal puts the descriptor the runtime handed out into `fdLocal`, which is
// what a body needs to read or write through it.
function openLocal(k, pathAt, pathLen, oflags, fdLocal) {
	return [...openFile(k, pathAt, pathLen, oflags), ...i32(FD_AT), ...LOAD32, ...set(fdLocal)];
}

// reportDigit writes '0' + (the value at `from`, transformed, mod 10) at `addr`.
// The mod is what keeps the result ASCII for a value above 1000.
function reportDigit(addr, from, transform, load = LOAD32) {
	return [...i32(addr), ...i32(48), ...i32(from), ...load, ...transform, ...ADD, ...STORE8];
}

// reportCount writes the low three decimal digits of the u32 at `from`.
function reportCount(from, addr = REPORT) {
	return [
		...reportDigit(addr, from, [...i32(100), [0x6d], ...i32(10), [0x70]]), // hundreds
		...reportDigit(addr + 1, from, [...i32(10), [0x6d], ...i32(10), [0x70]]), // tens
		...reportDigit(addr + 2, from, [...i32(10), [0x70]]), // units
	];
}

// reportLocal copies a local into a scratch word so reportCount can read it
// back, which keeps the digits off the value the next digit would have read.
function reportLocal(reg, addr = REPORT) {
	return [...i32(ERR_AT), ...get(reg), ...STORE32, ...reportCount(ERR_AT, addr)];
}

async function run(bytes, options) {
	const parts = [];
	await runWasm(bytes, (t) => parts.push(t), options);
	return parts.join('');
}

// printVector walks a NUL terminated string vector: one pointer word per entry
// and a null word at the end. Each entry's length has to come from the NUL the
// host wrote behind it, because the guest is given no length of its own.
function printVector(k, countLocal) {
	return [
		...LOOP_OPEN,
		...get(0), ...get(countLocal), ...GE_U, ...BREAK_IF(1),
		...vectorEntry(0), ...set(2),
		...i32(0), ...set(1),
		...LOOP_OPEN,
		...strByteAt(2, 1), ...EQZ, ...BREAK_IF(1),
		...get(1), ...i32(1), ...ADD, ...set(1),
		...BREAK(0),
		...LOOP_CLOSE,
		...storeIovec(get(2), get(1)),
		...i32(1), ...i32(IOV_AT), ...i32(1), ...i32(0), ...call(k('fd_write')), ...DROP,
		...storeIovec(i32(NL_AT), i32(1)),
		...i32(1), ...i32(IOV_AT), ...i32(1), ...i32(0), ...call(k('fd_write')), ...DROP,
		...get(0), ...i32(1), ...ADD, ...set(0),
		...BREAK(0),
		...LOOP_CLOSE,
	];
}

// guestFileModule builds the guest a compiled V program looks like on the file
// side: it makes the directory, opens a file inside it with O_CREAT, writes the
// content in chunks from a loop, seeks back to 0, reads until a read comes back
// empty and prints what it got. `chunks` is how many pieces of the content the
// write loop emits, so the expected answer moves with it. `grow` grows linear
// memory by a page before every write, which is what a guest allocator does.
function guestFileModule(chunks, { grow = false } = {}) {
	const k = indexer(FILE_IMPORTS);
	const body = [
		...locals(7), // fd, i, written, read, then three errnos
		// The preopened root starts empty, so a program that wants a file inside
		// a directory has to create it first.
		...i32(PREOPEN_FD), ...i32(DIR_AT), ...i32(DIR_LEN),
		...call(k('path_create_directory')), ...DROP,
		...openLocal(k, PATH_AT, PATH_LEN, OFLAG_CREAT, 0),
		...LOOP_OPEN,
		...get(1), ...i32(chunks), ...GE_S, ...BREAK_IF(1),
		...(grow ? [...i32(1), ...GROW, ...DROP] : []),
		...storeIovec(chunkAt(1), i32(CHUNK)),
		...get(0), ...i32(IOV_AT), ...i32(1), ...i32(NW_AT), ...call(k('fd_write')), ...DROP,
		// The guest totals what the host reported it took, rather than assume.
		...get(2), ...i32(NW_AT), ...LOAD32, ...ADD, ...set(2),
		...get(1), ...i32(1), ...ADD, ...set(1),
		...BREAK(0),
		...LOOP_CLOSE,
		...get(0), ...i64(0), ...i32(SEEK_SET), ...i32(SEEK_AT), ...call(k('fd_seek')), ...set(5),
		...LOOP_OPEN,
		...storeIovec(readAt(3), i32(CHUNK)),
		...get(0), ...i32(IOV_AT), ...i32(1), ...i32(NR_AT), ...call(k('fd_read')), ...DROP,
		...i32(NR_AT), ...LOAD32, ...EQZ, ...BREAK_IF(1),
		...get(3), ...i32(NR_AT), ...LOAD32, ...ADD, ...set(3),
		...BREAK(0),
		...LOOP_CLOSE,
		// The printed length is the count the read loop accumulated, so a short
		// read would print short rather than the whole hoped-for span.
		...writeOut(k, i32(READ_AT), get(3)),
		...reportLocal(5, REPORT),
		...reportLocal(2, REPORT + 3),
		...reportLocal(3, REPORT + 6),
		...get(0), ...call(k('fd_close')), ...set(6),
		...reportLocal(6, REPORT + 9),
		...writeOut(k, i32(REPORT), i32(12)),
	];
	return buildModule(FILE_IMPORTS, body, [at(DIR_AT, 'sub'), at(PATH_AT, 'sub/notes.txt'),
		at(CONTENT_AT, CONTENT)]);
}

// guestArgsModule asks the two-phase question about argv and prints every entry
// it was handed, so the answer is the argv the host was given and nothing else.
function guestArgsModule() {
	const k = indexer(ARGS_IMPORTS);
	const body = [
		...locals(4), // i, len, ptr, argc
		...i32(COUNT_AT), ...i32(BUF_SIZE_AT), ...call(k('args_sizes_get')), ...DROP,
		...i32(COUNT_AT), ...LOAD32, ...set(3),
		...i32(VECTOR_AT), ...i32(VECTOR_BUF_AT), ...call(k('args_get')), ...DROP,
		...printVector(k, 3),
		...reportLocal(3),
		...writeOut(k, i32(REPORT), i32(3)),
	];
	return buildModule(ARGS_IMPORTS, body, [atBytes(NL_AT, [0x0a])]);
}

// guestEnvironModule does the same for the environment, and reports what the
// sizes round of the question said alongside the strings the second round gave.
function guestEnvironModule() {
	const k = indexer(ENVIRON_IMPORTS);
	const body = [
		...locals(4), // i, len, ptr, count
		...i32(COUNT_AT), ...i32(BUF_SIZE_AT), ...call(k('environ_sizes_get')), ...DROP,
		...i32(COUNT_AT), ...LOAD32, ...set(3),
		...i32(VECTOR_AT), ...i32(VECTOR_BUF_AT), ...call(k('environ_get')), ...DROP,
		...printVector(k, 3),
		...reportLocal(3, REPORT),
		...reportCount(BUF_SIZE_AT, REPORT + 3),
		...writeOut(k, i32(REPORT), i32(6)),
	];
	return buildModule(ENVIRON_IMPORTS, body, [atBytes(NL_AT, [0x0a])]);
}

// --- the file guest --------------------------------------------------------

test('a guest that writes a file in a loop reads the same bytes back', async () => {
	// The bytes only come out if the create, the write loop, the seek and the
	// read loop all worked. The digits behind them are the seek errno, the
	// bytes the host took, the bytes it gave back and the close errno.
	const out = await run(guestFileModule(4));
	assert.equal(out, `${CONTENT}000016016000`);
});

test('a guest that grows its memory between writes stores the right bytes', async () => {
	// memory.grow detaches the buffer a cached view would be reading, so this
	// is the callable form of the re-read invariant.
	const out = await run(guestFileModule(4, { grow: true }));
	assert.equal(out, `${CONTENT}000016016000`);
});

test('a guest writing fewer chunks prints a shorter file', async () => {
	// The loop count is a real variable, and the read stops where the writes
	// stopped rather than at the end of the buffer.
	const out = await run(guestFileModule(3));
	assert.equal(out, `${CONTENT.slice(0, 12)}000012012000`);
});

// --- the argv guest --------------------------------------------------------

test('a guest that walks argv prints every argument the host handed it', async () => {
	const out = await run(guestArgsModule(), {
		argv: ['/playground/guest.wasm', 'alpha', 'beta gamma'],
	});
	assert.equal(out, '/playground/guest.wasm\nalpha\nbeta gamma\n003');
});

test('the same guest prints the one default argument', async () => {
	assert.equal(await run(guestArgsModule()), 'main.wasm\n001');
});

// --- the environ guest -----------------------------------------------------

test('a guest prints each environment entry on its own line', async () => {
	// The strings come from the pointer array environ_get filled, so a guest
	// that only trusted the sizes would print nothing at all.
	assert.equal(await run(guestEnvironModule()), 'PWD=/\nHOME=/\n002013');
});

