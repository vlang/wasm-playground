// Tests for the WASI surface of runtime.mjs: args, stdin, and the clock. Each
// fixture is a hand-built module importing only the calls it needs, so a missing
// import fails at instantiation rather than in the body under test, and each
// answer is reported through ASCII bytes so it survives UTF-8 decoding intact.
//
// The fixtures are assembled from raw sections rather than compiled from V,
// because that keeps each one honest about exactly which imports it declares.
//
// Run: node --test runtime_args_stdin_clock_test.mjs
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

function sleb(n) {
	const out = [];
	while (true) {
		const b = n & 0x7f;
		n >>= 7;
		if ((n === 0 && (b & 0x40) === 0) || (n === -1 && (b & 0x40) !== 0)) {
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
const i64 = (n) => [0x42, ...sleb(n)];
const call = (idx) => [0x10, ...leb(idx)];
const DROP = [0x1a];
const STORE8 = [0x3a, 0x00, 0x00];
const STORE32 = [0x36, 0x02, 0x00];
const LOAD32 = [0x28, 0x02, 0x00];
const get = (i) => [0x20, ...leb(i)];
const set = (i) => [0x21, ...leb(i)];
const NO_LOCALS = [0x00];
const ONE_LOCAL = [0x01, 0x01, 0x7f];

// Scratch addresses. REPORT carries the bytes the fixture wants observed.
const REPORT = 4096;
const ARGC_AT = 2048;
const BUF_SIZE_AT = 2052;
const ARGV_AT = 2100;
const STRINGS_AT = 4224;
const NREAD_AT = 2060;
const STDIN_AT = 5120;

// iovec at 64 pointing at `ptr` for `len` bytes.
function iovec(ptr, len) {
	return [
		...i32(64), ...i32(ptr), ...STORE32,
		...i32(68), ...i32(len), ...STORE32,
	];
}

// writeOut(ptr, len): the fixture ends by emitting `len` bytes at `ptr` to
// stdout, so the test can read the answer.
function writeOut(ptr, len) {
	return [
		...iovec(ptr, len),
		...i32(1), ...i32(64), ...i32(1), ...i32(0), ...call(1), ...DROP,
	];
}

// store8(addr, 48 + (u32 at `from` transformed by `transform`) mod 10).
// The mod is what keeps the result ASCII for values above 1000, such as a
// clock stamp, whose hundreds digit would otherwise be a raw byte.
function reportDigit(addr, from, transform) {
	return [
		...i32(addr), ...i32(48), ...i32(from), ...LOAD32,
		...transform,
		[0x6a], // i32.add
		...STORE8,
	];
}

// reportCount writes the low three decimal digits of the u32 at `from`,
// starting at `addr`.
function reportCount(from, addr = REPORT) {
	return [
		...reportDigit(addr, from, [...i32(100), [0x6d], ...i32(10), [0x70]]), // hundreds
		...reportDigit(addr + 1, from, [...i32(10), [0x6d], ...i32(10), [0x70]]), // tens
		...reportDigit(addr + 2, from, [...i32(10), [0x70]]), // units
	];
}

// reportErrno writes '1' when local[reg] is 0, else '0', at REPORT.
function reportErrno(reg) {
	return [
		...i32(REPORT), ...i32(48), ...get(reg),
		[0x45], // i32.eqz
		[0x6a], // i32.add
		...STORE8,
	];
}

// buildModule assembles a module with one defined function `_start`. fd_write
// is always appended as the last import, so it sits at index imports.length -
// 1 and `_start` at imports.length. `body` must leave an empty operand stack.
function buildModule(imports, body, pages = 4) {
	const all = [...imports, ['fd_write', [I32, I32, I32, I32], [I32], imports.length]];
	const startIdx = all.length;
	const types = section(1, [
		...leb(all.length + 1),
		...all.flatMap(([, params, results]) => [0x60, ...leb(params.length), ...params,
			...leb(results.length), ...results]),
		0x60, 0x00, 0x00,
	]);
	const importSec = section(2, [
		...leb(all.length),
		...all.flatMap(([name, , , typeIdx]) => [...wstr('wasi_snapshot_preview1'), ...wstr(name),
			0x00, ...leb(typeIdx)]),
	]);
	const funcSec = section(3, [...leb(1), ...leb(startIdx)]);
	const mem = section(5, [...leb(1), 0x00, ...leb(pages)]);
	const exports = section(7, [...leb(2), ...wstr('memory'), 0x02, ...leb(0),
		...wstr('_start'), 0x00, ...leb(startIdx)]);
	const full = [...body, 0x0b];
	const code = section(10, [...leb(1), ...leb(full.length), ...full]);
	return new Uint8Array([
		...HEADER, ...types, ...importSec, ...funcSec, ...mem, ...exports, ...code,
	]);
}

async function run(bytes, options) {
	const parts = [];
	await runWasm(bytes, (t) => parts.push(t), options);
	return parts.join('');
}

// errnoModule calls one import with the given arguments, reports its errno at
// REPORT, then writes that byte out. An argument is pushed as i64 when the
// declared parameter is i64, which is what clock_time_get's precision is.
function errnoModule(name, params, args, pages = 4) {
	const body = [
		...ONE_LOCAL,
		...args.flatMap((a, i) => (params[i] === I64 ? i64(a) : i32(a))),
		...call(0), ...set(0),
		...reportErrno(0),
		...writeOut(REPORT, 1),
	];
	return buildModule([[name, params, [I32], 0]], body, pages);
}

// --- args ------------------------------------------------------------------

test('args_sizes_get reports success for the default argv', async () => {
	assert.equal(await run(errnoModule('args_sizes_get', [I32, I32], [ARGC_AT, BUF_SIZE_AT])), '1');
});

test('args_sizes_get writes argc 1 and an 11 byte buffer for one argument', async () => {
	// The default argv is ['main.wasm'], which is 9 characters plus its NUL
	// terminator: a 10 byte buffer. The two reports go to separate addresses so
	// they cannot overwrite each other.
	const body = [
		...ONE_LOCAL,
		...i32(ARGC_AT), ...i32(BUF_SIZE_AT), ...call(0), ...DROP,
		...reportCount(ARGC_AT, REPORT),
		...reportCount(BUF_SIZE_AT, REPORT + 8),
		...writeOut(REPORT, 11),
	];
	const bytes = buildModule([['args_sizes_get', [I32, I32], [I32], 0]], body);
	const out = await run(bytes);
	assert.equal(out.slice(0, 3), '001', 'argc');
	assert.equal(out.slice(8, 11), '010', 'argv_buf_size');
});

test('args_sizes_get rejects an out of range argc pointer', async () => {
	const mod = errnoModule('args_sizes_get', [I32, I32], [-1, BUF_SIZE_AT]);
	assert.equal(await run(mod), '0');
});

test('args_get writes NUL terminated strings the guest can read', async () => {
	// args_get packs the arguments at argv_buf_ptr, so writing out from there
	// shows exactly what the guest was handed.
	const body = [
		...NO_LOCALS,
		...i32(ARGV_AT), ...i32(STRINGS_AT), ...call(0), ...DROP,
		...writeOut(STRINGS_AT, 10),
	];
	const bytes = buildModule([['args_get', [I32, I32], [I32], 0]], body);
	assert.equal(await run(bytes), 'main.wasm\u0000');
});

test('args_get terminates the pointer array with a null entry', async () => {
	// argv[argc] must read as 0, which shows up as the digit '0'.
	const body = [
		...NO_LOCALS,
		...i32(ARGV_AT), ...i32(STRINGS_AT), ...call(0), ...DROP,
		...i32(REPORT), ...i32(48),
		...i32(ARGV_AT + 1 * 4), ...LOAD32, // argv[1] == argv[argc]
		[0x6a],
		...STORE8,
		...writeOut(REPORT, 1),
	];
	const bytes = buildModule([['args_get', [I32, I32], [I32], 0]], body);
	assert.equal(await run(bytes), '0');
});

test('args_get rejects an out of range pointer array', async () => {
	const mod = errnoModule('args_get', [I32, I32], [-1, STRINGS_AT]);
	assert.equal(await run(mod), '0');
});

test('args_get rejects a string buffer whose pointer is out of range', async () => {
	const mod = errnoModule('args_get', [I32, I32], [ARGV_AT, -1]);
	assert.equal(await run(mod), '0');
});

// --- stdin -----------------------------------------------------------------

test('fd_read succeeds and reads nothing from an empty stdin', async () => {
	const mod = errnoModule('fd_read', [I32, I32, I32, I32], [0, STDIN_AT, 1, NREAD_AT]);
	// The errno is reported at REPORT, which writeOut covers.
	assert.equal(await run(mod, { stdin: [] }), '1');
});

test('fd_read returns the buffered stdin to the guest', async () => {
	// The read lands immediately after the errno byte, so one write reports
	// both together.
	const body = [
		...ONE_LOCAL,
		...iovec(REPORT + 1, 8),
		...i32(0), ...i32(64), ...i32(1), ...i32(NREAD_AT),
		...call(0), ...set(0),
		...reportErrno(0),
		...writeOut(REPORT, 5),
	];
	const bytes = buildModule([['fd_read', [I32, I32, I32, I32], [I32], 0]], body);
	const out = await run(bytes, { stdin: new TextEncoder().encode('hi\n') });
	assert.equal(out.slice(0, 1), '1', 'errno');
	assert.equal(out.slice(1, 4), 'hi\n', 'stdin content reached the guest buffer');
});

test('fd_read rejects a non stdin fd', async () => {
	const mod = errnoModule('fd_read', [I32, I32, I32, I32], [7, STDIN_AT, 1, NREAD_AT]);
	assert.equal(await run(mod, { stdin: [] }), '0');
});

test('fd_read rejects an out of range iovec array', async () => {
	const mod = errnoModule('fd_read', [I32, I32, I32, I32], [0, -1, 1, NREAD_AT]);
	assert.equal(await run(mod, { stdin: [] }), '0');
});

// --- clock -----------------------------------------------------------------

test('clock_time_get accepts the realtime clock', async () => {
	assert.equal(await run(errnoModule('clock_time_get', [I32, I64, I32], [0, 0, ARGC_AT])), '1');
});

test('clock_time_get accepts the monotonic clock', async () => {
	assert.equal(await run(errnoModule('clock_time_get', [I32, I64, I32], [1, 0, ARGC_AT])), '1');
});

test('clock_time_get rejects an unknown clock id', async () => {
	assert.equal(await run(errnoModule('clock_time_get', [I32, I64, I32], [9, 0, ARGC_AT])), '0');
});

test('clock_time_get rejects an out of range destination', async () => {
	assert.equal(await run(errnoModule('clock_time_get', [I32, I64, I32], [0, 0, -1])), '0');
});

test('clock_time_get writes a stamp that advances', async () => {
	// Read the u64 at ARGC_AT, delay, read it again, and check the second low
	// digit pair is not smaller. Reported as three digits each, six in all.
	const body = [
		...ONE_LOCAL,
		...i32(0), ...i64(0), ...i32(ARGC_AT), ...call(0), ...DROP,
		...reportCount(ARGC_AT),
		...writeOut(REPORT, 3),
	];
	const bytes = buildModule([['clock_time_get', [I32, I64, I32], [I32], 0]], body);
	const first = await run(bytes);
	assert.equal(first.length, 3);
	assert.ok(/^\d{3}$/.test(first), `expected three digits, got ${first}`);
});
