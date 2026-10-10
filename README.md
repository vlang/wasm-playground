# V WebAssembly playground

Run V programs locally in your browser at <https://vlang.github.io/wasm-playground/>.
Compilation and execution take place in a Web Worker. No compilation server is needed.

This repository contains the static site and generated compiler assets deployed by GitHub Pages.
The playground implementation lives in
[vlang/v](https://github.com/vlang/v/tree/e6634b0d45/examples/wasm/playground).

## Supported programs

Try Hello world, Integer loop, or Fibonacci, or edit the source and press Run.
Ctrl+Enter or Cmd+Enter also runs the program. Stop interrupts compilation or execution.

The direct WebAssembly backend currently supports primitive numbers, booleans, functions,
conditionals, loops, and printing string literals or integers. Strings stored in variables,
arrays, maps, structs, and general standard library programs are not yet supported.

The first run downloads the compiler assets. Later runs can reuse the browser's HTTP cache.

## Formatting

The Format button formats the editor source without leaving the browser. The
worker sends `{type:'format', source}` and reports back `{type:'formatted',
body}` or `{type:'error', message}`, using a fmt tool build
(`build/fmt.mjs`) beside the compiler build. The tool formats via
`v.format_text`, which needs no subprocess, unlike the `v fmt` driver.

`build/fmt.mjs` is not deployed yet: until it is, Format reports that the
formatter assets are missing instead of hanging. Regenerate it with the fmt
tool build and copy it next to the compiler assets, then update
`build-info.json`.

The format protocol is pinned by `worker_format_test.mjs`, which runs against
the shipped worker with a stubbed fmt build:

    node --test worker_format_test.mjs

## WASI surface

`runtime.mjs` provides the WASI imports the backend emits. Beyond `fd_write`,
for stdout and stderr:

- `proc_exit`, which the backend emits whenever `panic` or `exit` is reachable.
  Without it a module that panics cannot be linked at all, so the visitor sees
  a link error instead of the panic message. The import throws a `WasiExit`
  that `runWasm` catches; exit code 0 is a success and any other code is
  reported as an error. The host implementation may be used by other hosts, so
  the thrown type is exported rather than kept internal.
- `random_get`, filled from `crypto.getRandomValues`. The WASI spec caps a
  single call, so larger requests are served as several fills.
- `args_sizes_get` and `args_get`, answered from one immutable snapshot of the
  argv so a program that queries the sizes and then asks for the pointers
  cannot observe a list that changed underneath it. `runWasm` takes an `argv`
  option and defaults it to `['main.wasm']`, because V's own wasi fixture
  asserts `argc >= 1`.
- `fd_read`, which drains a buffered stdin held by the caller. The stream has
  to be in memory before `_start` runs, since `_start` is one synchronous call
  and cannot wait for a postMessage. Stdin stays input-only: other descriptors
  return `EBADF`.
- `clock_time_get` for `REALTIME` and `MONOTONIC`, writing nanoseconds as a
  little-endian u64. The `precision` argument is an i64, so this is the first
  call taking a BigInt parameter. The two CPU-time clocks are refused with
  `EINVAL`, because the runtime models no thread.

Each fixture in `runtime_exit_random_test.mjs` and
`runtime_args_stdin_clock_test.mjs` is a hand-built module importing only the
calls under test, so a module importing something the runtime lacks fails at
instantiation rather than in the body under test:

    node --test runtime_args_stdin_clock_test.mjs
    node --test runtime_exit_random_test.mjs

    node --test runtime_exit_random_test.mjs

## Rebuild and publish

The deployed V source commit is `e6634b0d45a25d65683de87337858347337759cb` (PR #29741).
`build-info.json` records the Emscripten version and the deployed asset hashes.

Follow the upstream
[build instructions](https://github.com/vlang/v/blob/e6634b0d45/examples/wasm/playground/README.md)
at that commit to regenerate the compiler assets.

Copy `index.html`, `playground.js`, `worker.js`, `runtime.mjs`, and the generated
`build/compiler.mjs`, `build/compiler.wasm`, and `build/compiler.data` into this repository.
Update `build-info.json`, retain `.nojekyll`, and push to `main`.
The `Deploy playground` workflow publishes the static site to GitHub Pages.
It uses a GitHub-hosted runner by default. Manual deployments can specify a different
runner label when a temporary deployment runner is available.

Before publishing, run the upstream Node runtime tests and check the page in a browser.
