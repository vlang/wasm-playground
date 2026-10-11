// Protocol tests for the worker.js format leg using a stubbed fmt build: no
// Emscripten, no compiler download. The test copies the real worker.js plus
// runtime.mjs into a scratch dir next to a fake build/fmt.mjs, so what runs
// is the shipped file, not a copy frozen in this test. The run leg is covered
// upstream against the real build; only format is stubbed here.
//
// Run: node --test worker_format_test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const here = dirname(fileURLToPath(import.meta.url));

// The stub mimics the fmt Emscripten module the way MODULARIZE+EXPORT_ES6
// exposes it: default-exported factory, FS.writeFile/readFile, async
// callMain with an exit code. It dispatches on input content so success and
// failure paths need no reconfiguration.
const stubFmt = `
const files = new Map();
export default async function createFmt(opts) {
	return {
		FS: {
			mkdirTree() {},
			writeFile: (p, c) => { files.set(p, String(c)); },
			readFile: (p) => {
				if (!files.has(p)) throw new Error('ENOENT: ' + p);
				return files.get(p);
			},
		},
		callMain: async () => {
			const src = files.get('/playground/format_in.v') || '';
			if (src.includes('broken(')) {
				files.set('/playground/format_err.txt', 'main.v:2:12: unexpected eof');
				return 1;
			}
			files.set('/playground/format_out.v', src);
			return 0;
		},
	};
}
`;

// worker_threads has parentPort, not self. The shim maps the worker's
// browser API onto it before the real worker.js runs. The dynamic import of
// ./build/fmt.mjs resolves against this scratch dir, where the stub lives.
const wrapper = `
import { parentPort } from 'node:worker_threads';
globalThis.self = {
	postMessage: (msg) => parentPort.postMessage(msg),
	addEventListener: () => {},
};
Object.defineProperty(globalThis.self, 'onmessage', {
	configurable: true,
	set(fn) { parentPort.on('message', (m) => fn({ data: m })); },
});
await import('./worker.js');
`;

function stage() {
	const dir = mkdtempSync(join(tmpdir(), 'playground-format-'));
	copyFileSync(join(here, 'worker.js'), join(dir, 'worker.js'));
	copyFileSync(join(here, 'runtime.mjs'), join(dir, 'runtime.mjs'));
	mkdirSync(join(dir, 'build'));
	writeFileSync(join(dir, 'build', 'fmt.mjs'), stubFmt);
	writeFileSync(join(dir, 'wrapper.mjs'), wrapper);
	return dir;
}

function runCase(message, { terminal = ['formatted', 'error'], timeoutMs = 15000 } = {}) {
	return new Promise((resolve, reject) => {
		const dir = stage();
		const worker = new Worker(join(dir, 'wrapper.mjs'), { type: 'module' });
		const seen = [];
		const timer = setTimeout(() => {
			worker.terminate();
			reject(new Error(`no terminal message within ${timeoutMs}ms; saw: ${JSON.stringify(seen)}`));
		}, timeoutMs);
		worker.on('message', (msg) => {
			seen.push(msg);
			if (msg && terminal.includes(msg.type)) {
				clearTimeout(timer);
				worker.terminate().then(() => resolve(seen));
			}
		});
		worker.on('error', (err) => {
			clearTimeout(timer);
			reject(err);
		});
		worker.postMessage(message);
	});
}

test('format success round-trips the body', async () => {
	const src = 'module main\nfn main() {\nprintln(1)\n}\n';
	const seen = await runCase({ type: 'format', source: src });
	const end = seen[seen.length - 1];
	assert.equal(end.type, 'formatted');
	assert.equal(end.body, src);
	assert.ok(seen.some((m) => m.type === 'status'), 'expected status updates');
});

test('format failure surfaces the detail message', async () => {
	const seen = await runCase({ type: 'format', source: 'module main\nfn broken( {' });
	const end = seen[seen.length - 1];
	assert.equal(end.type, 'error');
	assert.match(end.message, /unexpected eof/);
});

test('empty source is rejected without loading anything', async () => {
	const seen = await runCase({ type: 'format', source: '  \n' });
	const end = seen[seen.length - 1];
	assert.equal(end.type, 'error');
	assert.match(end.message, /before formatting/);
	assert.ok(!seen.some((m) => m.type === 'status'), 'no load should start');
});

test('unknown message types are ignored', async () => {
	const dir = stage();
	const worker = new Worker(join(dir, 'wrapper.mjs'), { type: 'module' });
	let heard = false;
	worker.on('message', () => {
		heard = true;
	});
	worker.postMessage({ type: 'definitely-not-real' });
	await new Promise((r) => setTimeout(r, 600));
	await worker.terminate();
	assert.equal(heard, false);
});
