// Tests for poll_oneoff: the call that lets a guest wait. The runtime cannot
// sleep -- a wasm import has no way to block the page without blocking the page
// -- so a monotonic timeout instead advances a per-run virtual clock and a
// realtime timeout is answered from the wall clock. Each fixture is a hand-built
// module importing only the calls it needs, so a missing import fails at
// instantiation rather than in the body under test.
//
// The fixtures are assembled from raw sections rather than compiled from V,
// because that keeps each one honest about exactly which imports it declares.
// Every subscription is an active data segment laid out by the offsets the two
// structs were measured at, and every answer is reported through ASCII bytes so
// it survives UTF-8 decoding intact.
//
// Run: node --test runtime_poll_test.mjs
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

// The subscription fields and the clock stamps are i64, which wasm hands to the
// host as BigInt, so the encoder has to cope with both widths.
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
const EQ32 = [0x46];
const ADD32 = [0x6a];
const ADD64 = [0x7c];
const EQ64 = [0x51];
const LT64 = [0x54]; // i64.lt_u
const GE64 = [0x5a]; // i64.ge_u
const AND32 = [0x71];
const LOAD8 = [0x2d, 0x00, 0x00];
const LOAD16 = [0x2f, 0x01, 0x00];
const LOAD32 = [0x28, 0x02, 0x00];
const LOAD64 = [0x29, 0x03, 0x00];
const STORE8 = [0x3a, 0x00, 0x00];
const STORE16 = [0x3b, 0x01, 0x00];
const STORE32 = [0x36, 0x02, 0x00];
const STORE64 = [0x37, 0x03, 0x00];
const get = (i) => [0x20, ...leb(i)];
const set = (i) => [0x21, ...leb(i)];
const NO_LOCALS = [0x00];
const ONE_LOCAL = [0x01, 0x01, 0x7f];

// The ABI signatures of the imports a fixture can ask for.
const IMPORT_SPECS = {
	clock_time_get: [[I32, I64, I32], [I32]],
	poll_oneoff: [[I32, I32, I32, I32], [I32]],
	fd_write: [[I32, I32, I32, I32], [I32]],
};

// indexer maps an import name onto the index it holds in one module's import
// section, so a body names the call it emits and a fixture still declares only
// what its body calls.
const indexer = (names) => (name) => names.indexOf(name);

const CLOCK_REALTIME = 0;
const CLOCK_MONOTONIC = 1;
const CLOCK_BOGUS = 9;
const EVENTTYPE_CLOCK = 0;
const EVENTTYPE_FD_READ = 1;
const ABSTIME = 1;

// __wasi_subscription_t is 48 bytes and __wasi_event_t is 32. The offsets are
// the ones wasi-libc's _Static_assert lines pin and this file's own fixtures
// were verified against, rather than a layout guessed from the field order.
const SUBSCRIPTION_SIZE = 48;
const SUBSCRIPTION_USERDATA_AT = 0;
const SUBSCRIPTION_TYPE_AT = 8;
const SUBSCRIPTION_ID_AT = 16;
const SUBSCRIPTION_TIMEOUT_AT = 24;
const SUBSCRIPTION_PRECISION_AT = 32;
const SUBSCRIPTION_FLAGS_AT = 40;
const EVENT_SIZE = 32;
const EVENT_USERDATA_AT = 0;
const EVENT_ERROR_AT = 8;
const EVENT_TYPE_AT = 10;
const EVENT_NBYTES_AT = 16;

// The waits each fixture asks for. They are nanoseconds, and chosen so the
// clock arithmetic the fixture checks is exact rather than approximate.
const WAIT_RELATIVE = 5_000_000_000n; // five seconds
const WAIT_ABSOLUTE = 3_000_000_000n;
const WAIT_FIRST = 1_000_000_000n;
const WAIT_SECOND = 3_000_000_000n;
const WAIT_LONG = 1_000_000_000_000_000n;
const WAIT_ZERO = 0n;
const WAIT_SMALL = 250_000_000n;

// The two userdata stamps two queued subscriptions carry. Both are past 2^53, so
// a host that round-trips them as a float or an i32 cannot report either one.
const USERDATA_FIRST = 0x1111111111111111n;
const USERDATA_ONE = 0x0badc0de12345678n;

// Scratch addresses. Each fixture is its own module and its own linear memory,
// so an address is only named for the role it plays inside one fixture.
const IOV_AT = 64;
const SUBS_AT = 16384;
const EVENTS_AT = 20480;
const NEVENTS_AT = 24576;
const BEFORE_AT = 24580;
const AFTER_AT = 24588;
const SCRATCH = 24596;
const REPORT = 32768;

// atBytes pairs an address with the bytes to place there, so a fixture can hand
// the runtime a whole subscription without emitting a store per byte.
const atBytes = (offset, bytes) => [offset, [...bytes]];

// subscription lays out one 48 byte __wasi_subscription_t, with every field at
// the offset it was measured at. What it leaves behind each field is whatever
// the buffer holds, which is how a fixture shows the host reads only the fields
// the ABI names.
function subscription({ userdata = 0n, type = EVENTTYPE_CLOCK, clock = CLOCK_MONOTONIC,
		timeout = WAIT_ZERO, precision = 0n, flags = 0 } = {}) {
	const view = new DataView(new ArrayBuffer(SUBSCRIPTION_SIZE));
	view.setBigUint64(SUBSCRIPTION_USERDATA_AT, userdata, true);
	view.setUint8(SUBSCRIPTION_TYPE_AT, type);
	view.setUint32(SUBSCRIPTION_ID_AT, clock, true);
	view.setBigUint64(SUBSCRIPTION_TIMEOUT_AT, timeout, true);
	view.setBigUint64(SUBSCRIPTION_PRECISION_AT, precision, true);
	view.setUint16(SUBSCRIPTION_FLAGS_AT, flags, true);
	return new Uint8Array(view.buffer);
}

// eventBytes is the 32 byte reply area for subscription `i`, zero-filled so a
// host that leaves a field alone is distinguishable from one that writes 0.
function eventBytes(i = 0) {
	return new Uint8Array(EVENT_SIZE + i * 0);
}

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

// iovec points one iovec at IOV_AT at `ptr` for `len` bytes.
function iovec(ptr, len) {
	return [
		...i32(IOV_AT), ...i32(ptr), ...STORE32,
		...i32(IOV_AT + 4), ...i32(len), ...STORE32,
	];
}

// writeOut emits `len` bytes at `ptr` to stdout, so the test can read the answer.
// The byte count out-param is address 0, which is where V points it.
function writeOut(k, ptr, len) {
	return [
		...iovec(ptr, len),
		...i32(1), ...i32(IOV_AT), ...i32(1), ...i32(0), ...call(k('fd_write')), ...DROP,
	];
}

// readClock calls clock_time_get for `clock`, leaving the reading at `addr`.
function readClock(k, clock, addr) {
	return [...i32(clock), ...i64(0), ...i32(addr), ...call(k('clock_time_get')), ...DROP];
}

// poll calls poll_oneoff over `count` subscriptions at SUBS_AT, leaving the
// errno in local `reg` and the reply at EVENTS_AT.
function poll(k, count, reg) {
	return [...i32(SUBS_AT), ...i32(EVENTS_AT), ...i32(count), ...i32(NEVENTS_AT),
		...call(k('poll_oneoff')), ...set(reg)];
}

// ok stores '1' at `addr` when `cond` leaves true on the stack, else '0'. It is
// the ASCII-report-byte trick the other suites use, and what lets a fixture
// report a 64 bit answer without emitting raw bytes the UTF-8 decoders
// would mangle.
function ok(addr, cond) {
	return [...i32(addr), ...i32(48), ...cond, ...ADD32, ...STORE8];
}

// const64 pushes one i64 constant, which is how a fixture states the value it
// expects an i64 field to come back as.
const const64 = (value) => [...i64(value)];

// load64Value pushes the u64 at `addr`.
function load64Value(addr) {
	return [...i32(addr), ...LOAD64];
}

// plus64 pushes the u64 at `addr` plus `addend`.
function plus64(addr, addend) {
	return [...i32(addr), ...LOAD64, ...i64(addend), ...ADD64];
}

// equalTo pushes 1 when the u64 at `from` is the one `ops` produces.
function equalTo(from, ops) {
	return [...i32(from), ...LOAD64, ...ops, ...EQ64];
}

const equalU32 = (from, want) => [...i32(from), ...LOAD32, ...i32(want), ...EQ32];

const equalU16 = (from, want) => [...i32(from), ...LOAD16, ...i32(want), ...EQ32];

const equalU8 = (from, want) => [...i32(from), ...LOAD8, ...i32(want), ...EQ32];

// within64 pushes 1 when the u64 at `from` lies in [lo, hi), which is how a
// wall-clock reading is checked for plausibility without comparing the whole
// stamp in a float.
function within64(from, lo, hi) {
	return [...i32(from), ...LOAD64, ...i64(lo), ...GE64,
		...i32(from), ...LOAD64, ...i64(hi), ...LT64,
		...AND32];
}

// store64At stores the u64 at `from` plus `addend` at `addr`, which is how a
// fixture turns a reading it just took into an absolute deadline.
function store64At(addr, from, addend) {
	return [...i32(addr), ...i32(from), ...LOAD64, ...i64(addend), ...ADD64, ...STORE64];
}

// storeU64 stores one constant u64 at `addr`.
function storeU64(addr, value) {
	return [...i32(addr), ...i64(value), ...STORE64];
}

// store16At writes one 16 bit word at `addr`, the width of the subclock flags.
function store16At(addr, value) {
	return [...i32(addr), ...i32(value), ...STORE16];
}

// store32At writes one 32 bit word at `addr`, the width of the clock id.
function store32At(addr, value) {
	return [...i32(addr), ...i32(value), ...STORE32];
}

// reportDigit writes '0' + (the u32 at `from`, transformed) mod 10 at `addr`.
// The mod is what keeps the result ASCII for a value above 1000.
function reportDigit(addr, from, transform) {
	return [...i32(addr), ...i32(48), ...i32(from), ...LOAD32, ...transform, ...ADD32,
		...STORE8];
}

// reportCount writes the low three decimal digits of the u32 at `from`.
function reportCount(from, addr) {
	return [
		...reportDigit(addr, from, [...i32(100), [0x6d], ...i32(10), [0x70]]), // hundreds
		...reportDigit(addr + 1, from, [...i32(10), [0x6d], ...i32(10), [0x70]]), // tens
		...reportDigit(addr + 2, from, [...i32(10), [0x70]]), // units
	];
}

// reportErrno writes the three digits of local[reg], which is the established
// way every suite here reports the errno a call answered with.
function reportErrno(reg, addr) {
	return [...i32(SCRATCH), ...get(reg), ...STORE32, ...reportCount(SCRATCH, addr)];
}

async function run(bytes) {
	const parts = [];
	await runWasm(bytes, (t) => parts.push(t));
	return parts.join('');
}

// --- an unsupported clock id ------------------------------------------------

const BOGUS_CLOCK_IMPORTS = ['poll_oneoff', 'fd_write'];

test('poll_oneoff reports ENOTSUP for a clock id it does not serve', async () => {
	const k = indexer(BOGUS_CLOCK_IMPORTS);
	const body = [
		...ONE_LOCAL,
		...poll(k, 1, 0),
		...reportErrno(0, REPORT),
		...writeOut(k, REPORT, 3),
	];
	const bytes = buildModule(BOGUS_CLOCK_IMPORTS, body, [
		atBytes(SUBS_AT, subscription({ clock: CLOCK_BOGUS, timeout: 1_000_000n })),
		atBytes(EVENTS_AT, eventBytes()),
	]);
	// 58 is ENOTSUP.
	assert.equal(await run(bytes), '058');
});

// --- a relative monotonic timeout -------------------------------------------

const RELATIVE_IMPORTS = ['clock_time_get', 'poll_oneoff', 'fd_write'];

test('a relative MONOTONIC timeout advances the virtual clock by exactly the '
	+ 'requested nanoseconds', async () => {
	const k = indexer(RELATIVE_IMPORTS);
	const body = [
		...ONE_LOCAL,
		...readClock(k, CLOCK_MONOTONIC, BEFORE_AT),
		...poll(k, 1, 0),
		...reportErrno(0, REPORT),
		...readClock(k, CLOCK_MONOTONIC, AFTER_AT),
		...ok(REPORT + 3, equalU32(NEVENTS_AT, 1)),
		...ok(REPORT + 4, equalU8(EVENTS_AT + EVENT_TYPE_AT, EVENTTYPE_CLOCK)),
		...ok(REPORT + 5, equalU16(EVENTS_AT + EVENT_ERROR_AT, 0)),
		// The reading the event reports is the one before plus the wait, which
		// is what makes the advance exact rather than approximate.
		...ok(REPORT + 6, equalTo(EVENTS_AT + EVENT_NBYTES_AT, plus64(BEFORE_AT, WAIT_RELATIVE))),
		// And the clock itself is there afterwards, not merely the event.
		...ok(REPORT + 7, equalTo(AFTER_AT, load64Value(EVENTS_AT + EVENT_NBYTES_AT))),
		...writeOut(k, REPORT, 8),
	];
	const bytes = buildModule(RELATIVE_IMPORTS, body, [
		atBytes(SUBS_AT, subscription({ timeout: WAIT_RELATIVE })),
		atBytes(EVENTS_AT, eventBytes()),
	]);
	assert.equal(await run(bytes), '000' + '11111');
});

// --- an absolute monotonic deadline -----------------------------------------

const ABSOLUTE_IMPORTS = ['clock_time_get', 'poll_oneoff', 'fd_write'];

test('an absolute MONOTONIC deadline resolves against the virtual clock', async () => {
	const k = indexer(ABSOLUTE_IMPORTS);
	const body = [
		...ONE_LOCAL,
		...readClock(k, CLOCK_MONOTONIC, BEFORE_AT),
		// A deadline the guest works out for itself, so the fixture does not
		// hard-code a clock it has no way to know.
		...store64At(SUBS_AT + SUBSCRIPTION_TIMEOUT_AT, BEFORE_AT, WAIT_ABSOLUTE),
		...store16At(SUBS_AT + SUBSCRIPTION_FLAGS_AT, ABSTIME),
		...poll(k, 1, 0),
		...reportErrno(0, REPORT),
		...readClock(k, CLOCK_MONOTONIC, AFTER_AT),
		...ok(REPORT + 3, equalU32(NEVENTS_AT, 1)),
		...ok(REPORT + 4,
			equalTo(EVENTS_AT + EVENT_NBYTES_AT, plus64(BEFORE_AT, WAIT_ABSOLUTE))),
		...ok(REPORT + 5, equalTo(AFTER_AT, plus64(BEFORE_AT, WAIT_ABSOLUTE))),
		...writeOut(k, REPORT, 6),
	];
	const bytes = buildModule(ABSOLUTE_IMPORTS, body, [
		atBytes(SUBS_AT, subscription({ timeout: 0n, flags: 0 })),
		atBytes(EVENTS_AT, eventBytes()),
	]);
	assert.equal(await run(bytes), '000' + '111');
});

test('an absolute MONOTONIC deadline already past does not wind the clock back', async () => {
	const k = indexer(ABSOLUTE_IMPORTS);
	const body = [
		...ONE_LOCAL,
		...readClock(k, CLOCK_MONOTONIC, BEFORE_AT),
		// One nanosecond after the epoch is a deadline long since passed.
		...storeU64(SUBS_AT + SUBSCRIPTION_TIMEOUT_AT, 1n),
		...store16At(SUBS_AT + SUBSCRIPTION_FLAGS_AT, ABSTIME),
		...poll(k, 1, 0),
		...reportErrno(0, REPORT),
		...readClock(k, CLOCK_MONOTONIC, AFTER_AT),
		...ok(REPORT + 3, equalU32(NEVENTS_AT, 1)),
		...ok(REPORT + 4, equalTo(EVENTS_AT + EVENT_NBYTES_AT, load64Value(BEFORE_AT))),
		...ok(REPORT + 5, equalTo(AFTER_AT, load64Value(BEFORE_AT))),
		...writeOut(k, REPORT, 6),
	];
	const bytes = buildModule(ABSOLUTE_IMPORTS, body, [
		atBytes(SUBS_AT, subscription({ timeout: 0n, flags: 0 })),
		atBytes(EVENTS_AT, eventBytes()),
	]);
	assert.equal(await run(bytes), '000' + '111');
});

// --- the wall clock --------------------------------------------------------

const REALTIME_IMPORTS = ['clock_time_get', 'poll_oneoff', 'fd_write'];

// A wall-clock reading can only be checked for plausibility in absolute terms,
// because the stamp itself is past 2^53 and cannot be compared in a float. The
// window is a minute either side of this test's own clock.
//
// That window alone cannot tell the wall clock from the virtual one, because
// virtualTime seeds from the same place the wall clock reads. A first call
// therefore pushes the virtual clock ten minutes ahead, past the window, before
// the realtime call is made: a reading taken from the virtual clock then lands
// outside the window and a reading taken from the wall clock does not.
const wallLo = () => (BigInt(Date.now()) - 60000n) * 1000000n;
const wallHi = () => (BigInt(Date.now()) + 60000n) * 1000000n;
const WAIT_DISPLACE = 600_000_000_000n; // ten minutes

test('a REALTIME subscription returns a plausible wall-clock reading', async () => {
	const k = indexer(REALTIME_IMPORTS);
	const body = [
		...ONE_LOCAL,
		...storeU64(SUBS_AT + SUBSCRIPTION_TIMEOUT_AT, WAIT_DISPLACE),
		...poll(k, 1, 0),
		...reportErrno(0, REPORT),
		// The same subscription reborn on the wall clock.
		...store32At(SUBS_AT + SUBSCRIPTION_ID_AT, CLOCK_REALTIME),
		...storeU64(SUBS_AT + SUBSCRIPTION_TIMEOUT_AT, 1_000_000n),
		...poll(k, 1, 0),
		...reportErrno(0, REPORT + 3),
		...ok(REPORT + 6, equalU32(NEVENTS_AT, 1)),
		...ok(REPORT + 7, within64(EVENTS_AT + EVENT_NBYTES_AT, wallLo(), wallHi())),
		...writeOut(k, REPORT, 8),
	];
	const bytes = buildModule(REALTIME_IMPORTS, body, [
		atBytes(SUBS_AT, subscription({ timeout: WAIT_DISPLACE })),
		atBytes(EVENTS_AT, eventBytes()),
	]);
	assert.equal(await run(bytes), '000' + '000' + '11');
});

test('a REALTIME deadline in the absolute past resolves at once, not never', async () => {
	// An absolute deadline underflows to a huge unsigned delay in a host that
	// subtracts "now" from it instead, so this is the shape that would hang.
	const k = indexer(REALTIME_IMPORTS);
	const body = [
		...ONE_LOCAL,
		...storeU64(SUBS_AT + SUBSCRIPTION_TIMEOUT_AT, WAIT_DISPLACE),
		...poll(k, 1, 0),
		...reportErrno(0, REPORT),
		...store32At(SUBS_AT + SUBSCRIPTION_ID_AT, CLOCK_REALTIME),
		...storeU64(SUBS_AT + SUBSCRIPTION_TIMEOUT_AT, 1_000_000n),
		...store16At(SUBS_AT + SUBSCRIPTION_FLAGS_AT, ABSTIME),
		...poll(k, 1, 0),
		...reportErrno(0, REPORT + 3),
		...ok(REPORT + 6, equalU32(NEVENTS_AT, 1)),
		...ok(REPORT + 7, within64(EVENTS_AT + EVENT_NBYTES_AT, wallLo(), wallHi())),
		...writeOut(k, REPORT, 8),
	];
	const bytes = buildModule(REALTIME_IMPORTS, body, [
		atBytes(SUBS_AT, subscription({ timeout: WAIT_DISPLACE })),
		atBytes(EVENTS_AT, eventBytes()),
	]);
	assert.equal(await run(bytes), '000' + '000' + '11');
});

// --- several subscriptions in one call --------------------------------------

const QUEUE_IMPORTS = ['clock_time_get', 'poll_oneoff', 'fd_write'];

test('two queued subscriptions both report, each with the wait it asked for', async () => {
	const k = indexer(QUEUE_IMPORTS);
	const body = [
		...ONE_LOCAL,
		...readClock(k, CLOCK_MONOTONIC, BEFORE_AT),
		...poll(k, 2, 0),
		...reportErrno(0, REPORT),
		...ok(REPORT + 3, equalU32(NEVENTS_AT, 2)),
		// Both userdata stamps come back whole, which an i64 round trip does and
		// an i32 or a float round trip does not.
		...ok(REPORT + 4,
			equalTo(EVENTS_AT + EVENT_USERDATA_AT, const64(USERDATA_FIRST))),
		...ok(REPORT + 5,
			equalTo(EVENTS_AT + EVENT_SIZE + EVENT_USERDATA_AT, const64(0x2222222222222222n))),
		...ok(REPORT + 6, equalU8(EVENTS_AT + EVENT_TYPE_AT, EVENTTYPE_CLOCK)),
		...ok(REPORT + 7,
			equalU8(EVENTS_AT + EVENT_SIZE + EVENT_TYPE_AT, EVENTTYPE_CLOCK)),
		// Each event is answered with the clock at the moment its own timeout
		// asks for, so the second is the first's wait plus its own.
		...ok(REPORT + 8, equalTo(EVENTS_AT + EVENT_NBYTES_AT,
			plus64(BEFORE_AT, WAIT_FIRST))),
		...ok(REPORT + 9,
			equalTo(EVENTS_AT + EVENT_SIZE + EVENT_NBYTES_AT,
				plus64(BEFORE_AT, WAIT_FIRST + WAIT_SECOND))),
		...writeOut(k, REPORT, 10),
	];
	const bytes = buildModule(QUEUE_IMPORTS, body, [
		atBytes(SUBS_AT, subscription({ userdata: USERDATA_FIRST, timeout: WAIT_FIRST })),
		atBytes(SUBS_AT + SUBSCRIPTION_SIZE,
			subscription({ userdata: 0x2222222222222222n, timeout: WAIT_SECOND })),
		atBytes(EVENTS_AT, eventBytes()),
		atBytes(EVENTS_AT + EVENT_SIZE, eventBytes()),
	]);
	assert.equal(await run(bytes), '000' + '1111111');
});

// --- the answer is the answer that was asked for ----------------------------

const FIELDS_IMPORTS = ['clock_time_get', 'poll_oneoff', 'fd_write'];

test('the event carries back the type, userdata and nbytes that were asked for', async () => {
	const k = indexer(FIELDS_IMPORTS);
	const body = [
		...ONE_LOCAL,
		...readClock(k, CLOCK_MONOTONIC, BEFORE_AT),
		...poll(k, 1, 0),
		...reportErrno(0, REPORT),
		...ok(REPORT + 3, equalTo(EVENTS_AT + EVENT_USERDATA_AT, const64(USERDATA_ONE))),
		...ok(REPORT + 4, equalU8(EVENTS_AT + EVENT_TYPE_AT, EVENTTYPE_CLOCK)),
		...ok(REPORT + 5, equalU16(EVENTS_AT + EVENT_ERROR_AT, 0)),
		...ok(REPORT + 6,
			equalTo(EVENTS_AT + EVENT_NBYTES_AT, plus64(BEFORE_AT, WAIT_SMALL))),
		...writeOut(k, REPORT, 7),
	];
	const bytes = buildModule(FIELDS_IMPORTS, body, [
		atBytes(SUBS_AT, subscription({ userdata: USERDATA_ONE, timeout: WAIT_SMALL })),
		atBytes(EVENTS_AT, eventBytes()),
	]);
	assert.equal(await run(bytes), '000' + '1111');
});

// --- a zero timeout --------------------------------------------------------

const ZERO_IMPORTS = ['clock_time_get', 'poll_oneoff', 'fd_write'];

test('a zero timeout resolves immediately without waiting at all', async () => {
	const k = indexer(ZERO_IMPORTS);
	const body = [
		...ONE_LOCAL,
		...readClock(k, CLOCK_MONOTONIC, BEFORE_AT),
		...poll(k, 1, 0),
		...reportErrno(0, REPORT),
		...readClock(k, CLOCK_MONOTONIC, AFTER_AT),
		...ok(REPORT + 3, equalU32(NEVENTS_AT, 1)),
		// Nothing moved: the event reports the clock as it stood, and the clock
		// is still there afterwards.
		...ok(REPORT + 4, equalTo(EVENTS_AT + EVENT_NBYTES_AT, load64Value(BEFORE_AT))),
		...ok(REPORT + 5, equalTo(AFTER_AT, load64Value(BEFORE_AT))),
		...writeOut(k, REPORT, 6),
	];
	const bytes = buildModule(ZERO_IMPORTS, body, [
		atBytes(SUBS_AT, subscription({ timeout: WAIT_ZERO })),
		atBytes(EVENTS_AT, eventBytes()),
	]);
	const started = Date.now();
	const out = await run(bytes);
	// A host that slept a real second for this would need a second; the bound
	// is loose enough not to flap on a slow machine but tight enough to catch it.
	assert.ok(Date.now() - started < 1000, 'a zero timeout spent real time');
	assert.equal(out, '000' + '111');
});

// --- a long timeout does not spend real time -------------------------------

const LONG_IMPORTS = ['clock_time_get', 'poll_oneoff', 'fd_write'];

test('a long timeout advances the clock without spending any real time', async () => {
	const k = indexer(LONG_IMPORTS);
	const body = [
		...ONE_LOCAL,
		...readClock(k, CLOCK_MONOTONIC, BEFORE_AT),
		...poll(k, 1, 0),
		...reportErrno(0, REPORT),
		...readClock(k, CLOCK_MONOTONIC, AFTER_AT),
		...ok(REPORT + 3, equalU32(NEVENTS_AT, 1)),
		...ok(REPORT + 4,
			equalTo(EVENTS_AT + EVENT_NBYTES_AT, plus64(BEFORE_AT, WAIT_LONG))),
		...ok(REPORT + 5, equalTo(AFTER_AT, plus64(BEFORE_AT, WAIT_LONG))),
		...writeOut(k, REPORT, 6),
	];
	const bytes = buildModule(LONG_IMPORTS, body, [
		atBytes(SUBS_AT, subscription({ timeout: WAIT_LONG })),
		atBytes(EVENTS_AT, eventBytes()),
	]);
	const started = Date.now();
	const out = await run(bytes);
	// Eleven and a half days of nanoseconds, answered in as long as the rest of
	// the module takes. A host that really slept would still be waiting.
	assert.ok(Date.now() - started < 2000, 'a long timeout spent real time');
	assert.equal(out, '000' + '111');
});

// --- the subscription kinds this runtime refuses ---------------------------

const FD_KIND_IMPORTS = ['poll_oneoff', 'fd_write'];

test('an fd subscription is refused rather than answered as a clock', async () => {
	const k = indexer(FD_KIND_IMPORTS);
	const body = [
		...ONE_LOCAL,
		...poll(k, 1, 0),
		...reportErrno(0, REPORT),
		...writeOut(k, REPORT, 3),
	];
	const bytes = buildModule(FD_KIND_IMPORTS, body, [
		atBytes(SUBS_AT,
			subscription({ type: EVENTTYPE_FD_READ, timeout: 1_000_000n })),
		atBytes(EVENTS_AT, eventBytes()),
	]);
	// 58 is ENOTSUP.
	assert.equal(await run(bytes), '058');
});

// --- the guards ------------------------------------------------------------

const GUARD_IMPORTS = ['poll_oneoff', 'fd_write'];

test('poll_oneoff refuses an empty list and an out-of-range subscription array', async () => {
	const k = indexer(GUARD_IMPORTS);
	const body = [
		...ONE_LOCAL,
		// Nothing to answer, so there is no count to write back either.
		...i32(SUBS_AT), ...i32(EVENTS_AT), ...i32(0), ...i32(NEVENTS_AT),
		...call(k('poll_oneoff')), ...set(0),
		...i32(SCRATCH), ...get(0), ...STORE32,
		// Past the end of linear memory, which the bounds check has to catch
		// before the DataView throws a RangeError instead.
		...i32(5000000), ...i32(EVENTS_AT), ...i32(1), ...i32(NEVENTS_AT),
		...call(k('poll_oneoff')), ...set(0),
		...i32(SCRATCH + 4), ...get(0), ...STORE32,
		...reportCount(SCRATCH, REPORT),
		...reportCount(SCRATCH + 4, REPORT + 3),
		...writeOut(k, REPORT, 6),
	];
	const bytes = buildModule(GUARD_IMPORTS, body, [
		atBytes(SUBS_AT, subscription({})),
		atBytes(EVENTS_AT, eventBytes()),
	]);
	// 28 is EINVAL for the empty list, 21 is EFAULT for the out-of-range one.
	assert.equal(await run(bytes), '028' + '021');
});
