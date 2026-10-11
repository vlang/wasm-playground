import { runWasm } from './runtime.mjs';

const send = (type, fields = {}) => self.postMessage({ type, ...fields });

// Emscripten preload failures can reject outside the compiler factory's promise.
self.addEventListener('unhandledrejection', (event) => {
	event.preventDefault();
	const detail = event.reason?.message || String(event.reason);
	send('error', {
		message: 'Could not load the V compiler assets. Rebuild with sh examples/wasm/playground/build.sh '
			+ `and serve the playground directory over HTTP. ${detail}`,
	});
});

self.onmessage = async ({ data }) => {
	if (!data || (data.type !== 'run' && data.type !== 'format')) return;
	try {
		if (data.type === 'run') await handleRun(data.source);
		else await handleFormat(data.source);
	} catch (error) {
		send('error', { message: error.message || String(error) });
	}
};

async function handleRun(source) {
	send('status', { message: 'Loading the V compiler…' });
	let createCompiler;
	try {
		({ default: createCompiler } = await import('./build/compiler.mjs'));
	} catch {
		throw new Error('Could not load the V compiler. Run sh examples/wasm/playground/build.sh in the repository, then serve the playground directory over HTTP.');
	}
	const compiler = await createCompiler({
		noInitialRun: true,
		thisProgram: '/v/v',
		locateFile: (name) => new URL(`./build/${name}`, import.meta.url).href,
		print: (text) => send('output', { text: `${text}\n` }),
		printErr: (text) => send('output', { text: `${text}\n` }),
		preRun: [(module) => {
			module.ENV.VEXE = '/v/v';
			module.ENV.VJOBS = '1';
			module.ENV.V_SKIP_VVMRC = '1';
			module.ENV.V_MACOS_V3_EMBEDDED = '1';
		}],
	});
	compiler.FS.mkdirTree('/playground');
	compiler.FS.writeFile('/v/v', '');
	compiler.FS.chdir('/v');
	compiler.FS.writeFile('/playground/main.v', source);
	send('status', { message: 'Compiling…' });
	const result = compiler.callMain([
		'-silent', '-no-parallel', '-no-memory-limit', '-nocache',
		'-b', 'wasm', '-o', '/playground/main.wasm', '/playground/main.v',
	]);
	if (result !== 0) throw new Error(`Compilation failed (exit code ${result}).`);
	const bytes = compiler.FS.readFile('/playground/main.wasm');
	send('status', { message: 'Running…' });
	let output = '';
	const flush = () => {
		if (output) send('output', { text: output });
		output = '';
	};
	try {
		await runWasm(bytes, (text) => {
			output += text;
			if (output.includes('\n') || output.length >= 4096) flush();
		});
	} finally {
		flush();
	}
	send('done');
}

// handleFormat formats source with the fmt tool build (fmt_tool.v compiled
// with Emscripten beside the compiler). The tool cannot be reached through
// the compiler driver's `fmt` subcommand: that shells out per file, which is
// ENOSYS under Emscripten. Until build/fmt.mjs is deployed the import below
// fails and the page reports it instead of hanging.
async function handleFormat(source) {
	if (!source || !source.trim()) {
		send('error', { message: 'Write a V program before formatting.' });
		return;
	}
	send('status', { message: 'Loading the formatter…' });
	let createFmt;
	try {
		({ default: createFmt } = await import('./build/fmt.mjs'));
	} catch {
		throw new Error('Could not load the V formatter. The fmt tool build is not deployed yet.');
	}
	const fmt = await createFmt({
		noInitialRun: true,
		locateFile: (name) => new URL(`./build/${name}`, import.meta.url).href,
		print: (text) => send('output', { text: `${text}\n` }),
		printErr: (text) => send('output', { text: `${text}\n` }),
	});
	fmt.FS.mkdirTree('/playground');
	fmt.FS.writeFile('/playground/format_in.v', source);
	send('status', { message: 'Formatting…' });
	const code = await fmt.callMain([]);
	if (code !== 0) {
		let message = `Formatting failed (exit code ${code}).`;
		try {
			const detail = fmt.FS.readFile('/playground/format_err.txt', 'utf8').trim();
			if (detail) message = detail;
		} catch {
			// No detail file: keep the exit-code message.
		}
		send('error', { message });
		return;
	}
	const body = fmt.FS.readFile('/playground/format_out.v', 'utf8');
	send('formatted', { body });
}
