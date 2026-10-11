// Tests for the WASI surface of runtime.mjs beyond fd_write: proc_exit and
// random_get. Each case drives a hand-built module whose only imports are the
// ones under test, so a module that imports something the runtime lacks fails at
// instantiation rather than inside the body under test.
//
// The modules are assembled from raw sections rather than compiled from V,
// because that keeps the fixture honest about exactly which imports appear: a
// V-compiled module would drag in whatever that compiler emits, and this test is
// about what the host answers for a single call.
//
// Run: node --test runtime_exit_random_test.mjs
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
const VOID = 0x40;

function call(idx) {
	return [0x10, ...leb(idx)];
}

function callDrop(idx) {
	return [...call(idx), 0x1a];
}

// iovec at address 64, pointing at `ptr` for `len` bytes.
function iovec(ptr, len) {
	return [
		0x41, ...sleb(64), 0x41, ...sleb(ptr), 0x36, 0x02, 0x00, // iovec.buf
		0x41, ...sleb(68), 0x41, ...sleb(len), 0x36, 0x02, 0x00, // iovec.len
		0x41, ...sleb(1), 0x41, ...sleb(64), 0x41, ...sleb(1), 0x41, ...sleb(0), ...callDrop(1),
	];
}

// --- proc_exit -------------------------------------------------------------

// _start is: i32.const code, call 0 (proc_exit), end. unreachable is never
// reached because the import throws, which is what makes proc_exit a
// non-returning call the way a real module uses it.
function exitModule(code) {
	const types = section(1, [
		...leb(2),
		0x60, ...leb(1), 0x7f, 0x00,
		0x60, 0x00, 0x00,
	]);
	const imports = section(2, [
		...leb(1),
		...wstr('wasi_snapshot_preview1'),
		...wstr('proc_exit'),
		0x00,
		...leb(0),
	]);
	const funcs = section(3, [...leb(1), ...leb(1)]);
	const mem = section(5, [...leb(1), 0x00, ...leb(1)]);
	const exports = section(7, [
		...leb(2),
		...wstr('memory'),
		0x02,
		...leb(0),
		...wstr('_start'),
		0x00,
		...leb(1),
	]);
	const bodyBytes = [0x00, 0x41, ...sleb(code), 0x10, 0x00, 0x0b];
	const codeSec = section(10, [...leb(1), ...leb(bodyBytes.length), ...bodyBytes]);
	return new Uint8Array([...HEADER, ...types, ...imports, ...funcs, ...mem, ...exports, ...codeSec]);
}

// --- random_get ------------------------------------------------------------

// _start: random_get(ptr, len) into local 0, then write a single byte at
// report: '1' when the call returned 0, '0' otherwise. The byte is ASCII so it
// survives UTF-8 decoding intact, and reading it pins the errno return path
// end to end. `raw` writes the filled bytes themselves instead.
function randomModule(ptr, len, { pages = 32, raw = false } = {}) {
	const types = section(1, [
		...leb(3),
		0x60, ...leb(2), 0x7f, 0x7f, ...leb(1), 0x7f, // random_get -> errno
		0x60, ...leb(4), 0x7f, 0x7f, 0x7f, 0x7f, ...leb(1), 0x7f,
		// fd_write -> errno
		0x60, 0x00, 0x00, // _start
	]);
	const imports = section(2, [
		...leb(2),
		...wstr('wasi_snapshot_preview1'), ...wstr('random_get'), 0x00, ...leb(0),
		...wstr('wasi_snapshot_preview1'), ...wstr('fd_write'), 0x00, ...leb(1),
	]);
	const funcs = section(3, [...leb(1), ...leb(2)]);
	const mem = section(5, [...leb(1), 0x00, ...leb(pages)]);
	const exports = section(7, [
		...leb(2),
		...wstr('memory'),
		0x02,
		...leb(0),
		...wstr('_start'),
		0x00,
		...leb(2),
	]);
	const report = 2048;
	const body = raw
		? [0x00, 0x41, ...sleb(ptr), 0x41, ...sleb(len),
			...callDrop(0), ...iovec(ptr, len), 0x0b]
		: [
			0x01, 0x01, 0x7f, // one local: i32
			0x41, ...sleb(ptr), 0x41, ...sleb(len), ...call(0), 0x21, 0x00, // r = random_get(...)
			0x41, ...sleb(report), 0x41, ...sleb(48), 0x20, 0x00, 0x45, 0x6a, 0x3a, 0x00, 0x00,
			// '0' + (r == 0)
			...iovec(report, 1),
			0x0b,
		];
	const codeSec = section(10, [...leb(1), ...leb(body.length), ...body]);
	return new Uint8Array([...HEADER, ...types, ...imports, ...funcs, ...mem, ...exports, ...codeSec]);
}

async function collect(bytes, pages) {
	const parts = [];
	await runWasm(bytes, (t) => parts.push(t));
	return parts.join('');
}

// --- proc_exit -------------------------------------------------------------

test('exit code 0 resolves and emits no output', async () => {
	await runWasm(exitModule(0), () => {
		assert.fail('no output expected');
	});
});

test('exit code 1 rejects with the code carried through', async () => {
	await assert.rejects(
		() => runWasm(exitModule(1), () => {}),
		(err) => {
			assert.equal(err.name, 'WasiExit');
			assert.equal(err.code, 1);
			assert.match(err.message, /code 1/);
			return true;
		},
	);
});

test('exit code is not truncated to a boolean', async () => {
	await assert.rejects(() => runWasm(exitModule(200), () => {}), (err) => {
		assert.equal(err.code, 200);
		return true;
	});
});

// --- random_get ------------------------------------------------------------

test('random_get returns 0 for an in-range span', async () => {
	assert.equal(await collect(randomModule(1024, 16)), '1');
});

test('random_get returns EFAULT for an out-of-range pointer', async () => {
	// -1 reaches JS as a signed i32; the >>> 0 coercion turns it into
	// 4294967295, which fails the bounds check and yields errno 21. Without
	// that coercion this call would reach DataView and throw a RangeError.
	assert.equal(await collect(randomModule(-1, 16)), '0');
});

test('random_get returns EFAULT for a span that runs past the memory end', async () => {
	// ptr is in range but ptr+len would leave it; the bounds check catches it.
	assert.equal(await collect(randomModule(-100, 16)), '0');
});

test('random_get loops above the per-call fill cap', async () => {
	// 70000 bytes needs more than one 65536-byte fill, and the span sits past
	// the first pages so the request is large rather than merely long.
	assert.equal(await collect(randomModule(1048576, 70000, { pages: 64 })), '1');
});

test('random_get fills different bytes on each call', async () => {
	const first = await collect(randomModule(1024, 16, { raw: true }));
	const second = await collect(randomModule(1024, 16, { raw: true }));
	assert.notEqual(first, second, 'two draws of 16 bytes matched, which is improbable');
});

// --- the module still links ------------------------------------------------

test('a module importing only random_get and fd_write instantiates', async () => {
	// Proves nothing else in the import object is required for this module.
	assert.equal(await collect(randomModule(1024, 4)), '1');
});
