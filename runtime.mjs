// WASI runtime for V programs compiled to wasm.
//
// The V wasm backend imports `wasi_snapshot_preview1` functions on demand: the
// driver emits an import only for a call that is actually reachable, so a
// program that never calls exit() carries no proc_exit import. Extra keys in
// this object are therefore harmless, and each is implemented here.
//
// Invariants that every function below must keep:
//
//   - `memory.buffer` is re-read on each call. The guest allocator grows
//     memory, which detaches the previous ArrayBuffer, so a cached view would
//     read and write a detached buffer.
//   - Every i32 parameter is coerced with `>>> 0` before any bounds check. WASM
//     i32 arrives in JS signed, so an out-of-range pointer is negative; without
//     the coercion it reaches the DataView and throws a RangeError instead of
//     returning WASI EFAULT.
//   - `inBounds` is written so it never computes `ptr + size`, which would wrap.
//   - Every i64 parameter arrives in JS as a BigInt and every i64 written back
//     goes out through `setBigUint64`. Mixing the two widths is how a value
//     above 2^32 silently truncates.
//   - Linear address 0 is writable. The backend stores its fd_write byte count
//     there, so a NULL-pointer guard would break V-generated modules.
//   - Validate everything before performing any visible side effect.
//
// The descriptor layout follows the WASI convention: 0-2 are the console, 3 is
// the single preopened directory, and path_open hands out 4 and above. Those
// descriptors are backed by an in-memory store built per runWasm call, so what
// one program writes is invisible to the next. Directories are entries in the
// same store, which is why the path_* calls check a leading component exists
// before they touch anything.

export class WasiExit extends Error {
	constructor(code) {
		super(`the program called exit with code ${code}`);
		this.name = 'WasiExit';
		this.code = code;
	}
}

// WASI errno values used below.
const EBADF = 8;
const EEXIST = 20;
const EFAULT = 21;
const EINVAL = 28;
const EISDIR = 31;
const ENOENT = 44;
const ENOTDIR = 54;
const ENOTEMPTY = 55;
const EPERM = 63;
const ESPIPE = 68;

// random_get fills at most this many bytes per call; the WASI spec caps a
// single call, so larger requests are served as several fill calls.
const random_fill_max = 65536;

// The default argv. V's own wasi_api fixture asserts argc >= 1, so a host with
// no arguments at all would read as a failure rather than as a plain program.
const default_argv = ['main.wasm'];

// The environment a guest is told about. It is one fixed array that is never
// mutated, so environ_sizes_get and environ_get answer about the same two
// entries whatever order the guest asks in.
const default_environ = ['PWD=/', 'HOME=/'];

// Realtime and monotonic are the two clock ids worth supporting; the CPU-time
// ids describe a thread this runtime does not model.
const CLOCK_REALTIME = 0;
const CLOCK_MONOTONIC = 1;

// __WASI_WHENCE_*: where fd_seek counts its offset from.
const WHENCE_SET = 0;
const WHENCE_CUR = 1;
const WHENCE_END = 2;

// 0-2 are the console, 3 is the preopened root, and every file descriptor the
// runtime hands out is 4 or above.
const STDERR_FD = 2;
const PREOPEN_FD = 3;
const FIRST_FILE_FD = 4;
const PREOPEN_NAME = '/';

// __WASI_PREOPENTYPE_DIR, the only prestat kind there is here. The struct is
// the tag byte padded out to the u32 that follows it, so the tag goes at +0 and
// the name length at +4.
const PRESTAT_SIZE = 8;
const PRESTAT_TAG_DIR = 0;

// __WASI_FILETYPE_*: the byte that lets a guest tell a console descriptor from
// a stored file.
const FILETYPE_CHAR_DEVICE = 2;
const FILETYPE_DIRECTORY = 3;
const FILETYPE_REGULAR_FILE = 4;

// The two shapes of a store entry. A directory has no bytes; a file owns a copy
// of its own.
const NODE_DIR = 'dir';
const NODE_FILE = 'file';

// __wasi_filestat_t: dev and ino as two u64s, the filetype byte at +16, then
// nlink, size, atim, mtim and ctim. The byte leaves seven bytes of padding, so
// nlink sits at +24 and size at +32.
const FILESTAT_SIZE = 64;
const FILESTAT_NLINK_AT = 24;
const FILESTAT_SIZE_AT = 32;
const FILESTAT_ATIM_AT = 40;
const FILESTAT_MTIM_AT = 48;
const FILESTAT_CTIM_AT = 56;

// __WASI_OFLAGS_* and __WASI_FDFLAGS_*, the two flag words of path_open.
const OFLAG_CREAT = 1;
const OFLAG_TRUNC = 8;
const FDFLAG_APPEND = 1;

// fdstat is filetype, fdflags, then the two i64 rights fields.
const FDSTAT_SIZE = 24;

// guest exposes the guest's linear memory for one import call.
function guest(instance) {
	const memory = instance.exports.memory.buffer;
	const view = new DataView(memory);
	const inBounds = (ptr, size) => ptr <= memory.byteLength && size <= memory.byteLength - ptr;
	return { view, inBounds };
}

// readIovecs parses the iovec array the guest built: 8 bytes per entry, with a
// u32 LE buffer pointer then a u32 LE length. Every pointer is validated before
// the caller acts on it.
function readIovecs(g, iovs, count) {
	const out = [];
	for (let i = 0; i < count; i++) {
		const at = iovs + i * 8;
		if (!g.inBounds(at, 8)) return null;
		out.push({
			buf: g.view.getUint32(at, true),
			len: g.view.getUint32(at + 4, true),
		});
	}
	for (const io of out) {
		if (!g.inBounds(io.buf, io.len)) return null;
	}
	return out;
}

// writeGuest writes the little-endian u32 the WASI ABI uses for sizes and
// counts, tolerating an out-param of 0 because V names address 0 for its
// fd_write byte count.
function writeU32(g, ptr, value) {
	g.view.setUint32(ptr >>> 0, value >>> 0, true);
}

// encodeList encodes a whole string vector, which is what both half of the
// args and the environ questions are answered from.
function encodeList(list) {
	return list.map((entry) => new TextEncoder().encode(entry));
}

// vectorBuffer is the byte count the encoded entries need: each string plus
// its NUL terminator.
function vectorBuffer(encoded) {
	return encoded.reduce((n, e) => n + e.length + 1, 0);
}

// vectorSizes writes the count and the buffer size, the first half of the
// two-phase shape args_sizes_get and environ_sizes_get share.
function vectorSizes(g, count_ptr, buf_size_ptr, encoded) {
	writeU32(g, count_ptr, encoded.length);
	writeU32(g, buf_size_ptr, vectorBuffer(encoded));
}

// vectorList lays the entries out end to end and points one word of the
// pointer array at each, the last word being 0 as the terminator.
function vectorList(g, ptr, buf_ptr, encoded) {
	let at = buf_ptr;
	for (let i = 0; i < encoded.length; i++) {
		writeU32(g, ptr + i * 4, at);
		const bytes = encoded[i];
		new Uint8Array(g.view.buffer, at, bytes.length).set(bytes);
		g.view.setUint8(at + bytes.length, 0);
		at += bytes.length + 1;
	}
	writeU32(g, ptr + encoded.length * 4, 0);
}

// iovecBytes validates the iovec array and returns the byte ranges it names.
// A write to the console and a write to a stored file share this, so both
// refuse a bad iovec before either touches the guest.
function iovecBytes(g, iovs, count) {
	const iovecs = readIovecs(g, iovs, count);
	if (iovecs === null) return null;
	return {
		total: iovecs.reduce((n, io) => n + io.len, 0),
		parts: iovecs.map((io) => new Uint8Array(g.view.buffer, io.buf, io.len)),
	};
}

// guestPath maps a guest path onto a key of the backing store, or returns the
// errno that explains why it cannot. The store is flat, so a path that names a
// parent directory or an absolute location is refused instead of resolved: a
// playground has no directory tree to walk out of.
function guestPath(g, path_ptr, path_len) {
	if (!g.inBounds(path_ptr, path_len)) return { errno: EFAULT };
	const raw = new TextDecoder().decode(new Uint8Array(g.view.buffer, path_ptr, path_len));
	// A trailing slash would make 'a' and 'a/' two different keys, and paths
	// arrive with one from wasilibc's own normalisation.
	let path = raw.startsWith('./') ? raw.slice(2) : raw;
	while (path.endsWith('/')) path = path.slice(0, -1);
	if (path === '') return { errno: EINVAL };
	if (path.startsWith('/') || path.split('/').includes('..')) return { errno: EPERM };
	return { path };
}

// storeParent returns the errno that stops `path` being reachable, or null when
// it is. The root always exists, so only a path with a component before its
// last one has a parent to check.
function storeParent(store, path) {
	const cut = path.lastIndexOf('/');
	if (cut <= 0) return null;
	const parent = store.get(path.slice(0, cut));
	if (parent === undefined) return ENOENT;
	if (parent.kind !== NODE_DIR) return ENOTDIR;
	return null;
}

// storePath is the entry point every path_* call goes through: guestPath
// refuses traversal and absolute paths, storeParent refuses a leading component
// that is missing or is not a directory.
function storePath(g, path_ptr, path_len, store) {
	const opened = guestPath(g, path_ptr, path_len);
	if (opened.errno !== undefined) return opened;
	const errno = storeParent(store, opened.path);
	if (errno !== null) return { errno };
	return opened;
}

// nowMs is the millisecond stamp a node's times are kept in, which filestat
// widens to the nanoseconds the ABI reports.
function nowMs() {
	return Date.now();
}

// newNode makes the empty file a path_open with O_CREAT stores.
function newNode() {
	return { kind: NODE_FILE, bytes: new Uint8Array(0), mtime: nowMs() };
}

// appendBytes concatenates `parts` onto a node's bytes and returns the new
// length. A new array is built each time rather than appended in place, because
// the store owns its bytes: aliasing the guest's memory would leave a file
// reading a detached buffer once the guest grows that memory.
function appendBytes(node, parts) {
	const before = node.bytes;
	const size = parts.reduce((n, p) => n + p.length, 0);
	const grown = new Uint8Array(before.length + size);
	grown.set(before, 0);
	let at = before.length;
	for (const part of parts) {
		grown.set(part, at);
		at += part.length;
	}
	node.bytes = grown;
	node.mtime = nowMs();
	return grown.length;
}

// writeFilestat fills a __wasi_filestat_t from a store node. Only three fields
// mean anything here, so the rest stay zero: an invented device or inode number
// is something a guest could act on.
function writeFilestat(g, ptr, node) {
	const stamp = BigInt(node.mtime) * 1000000n;
	g.view.setBigUint64(ptr, 0n, true);
	g.view.setBigUint64(ptr + 8, 0n, true);
	// The filetype byte plus the seven bytes of padding behind it, written as
	// one word so a guest that reads a u16 sees the type and nothing else.
	const filetype = node.kind === NODE_DIR ? FILETYPE_DIRECTORY : FILETYPE_REGULAR_FILE;
	g.view.setBigUint64(ptr + 16, BigInt(filetype), true);
	g.view.setBigUint64(ptr + FILESTAT_NLINK_AT, 1n, true);
	g.view.setBigUint64(ptr + FILESTAT_SIZE_AT,
		BigInt(node.kind === NODE_DIR ? 0 : node.bytes.length), true);
	g.view.setBigUint64(ptr + FILESTAT_ATIM_AT, stamp, true);
	g.view.setBigUint64(ptr + FILESTAT_MTIM_AT, stamp, true);
	g.view.setBigUint64(ptr + FILESTAT_CTIM_AT, stamp, true);
}

export async function runWasm(bytes, onOutput, options = {}) {
	const argv = options.argv ?? default_argv;
	const stdin = options.stdin ?? [];

	const decoders = new Map([[1, new TextDecoder()], [2, new TextDecoder()]]);
	let instance;
	let outputBytes = 0;
	let stdinPos = 0;
	const store = new Map();
	const openFiles = new Map();
	let nextFileFd = FIRST_FILE_FD;
	const imports = {
		wasi_snapshot_preview1: {
			fd_write(fd, iovs, count, written) {
				const file = openFiles.get(fd);
				if (file === undefined && !decoders.has(fd)) return EBADF;
				const g = guest(instance);
				iovs >>>= 0;
				count >>>= 0;
				written >>>= 0;
				if (!g.inBounds(written, 4)) return EFAULT;
				const data = iovecBytes(g, iovs, count);
				if (data === null) return EFAULT;
				if (file !== undefined) {
					// An append descriptor writes at the end whatever its
					// cursor says, which is what append mode means.
					if ((file.flags & FDFLAG_APPEND) !== 0) file.pos = file.node.bytes.length;
					appendBytes(file.node, data.parts);
					writeU32(g, written, data.total);
					return 0;
				}
				// Only the console is metered: the cap exists to stop a program
				// from drowning the page, and a file write is invisible there.
				outputBytes += data.total;
				if (outputBytes > 1024 * 1024) {
					throw new Error('Output exceeded 1 MiB. Stop or shorten the program.');
				}
				for (const part of data.parts) {
					const text = decoders.get(fd).decode(part, { stream: true });
					if (text) onOutput(text);
				}
				writeU32(g, written, data.total);
				return 0;
			},
			// Without this the module cannot be linked at all when a panic or
			// an exit() is reachable, because the backend emits the import for
			// both and WebAssembly fails on a missing import. Throwing unwinds
			// _start; runWasm turns code 0 into success and anything else into
			// an error, so a panic message written just before still surfaces.
			proc_exit(rval) {
				throw new WasiExit(rval | 0);
			},
			random_get(buf, buf_len) {
				const g = guest(instance);
				buf >>>= 0;
				buf_len >>>= 0;
				if (!g.inBounds(buf, buf_len)) return EFAULT;
				const bytes = new Uint8Array(g.view.buffer, buf, buf_len);
				let filled = 0;
				while (filled < buf_len) {
					const can = Math.min(random_fill_max, buf_len - filled);
					crypto.getRandomValues(bytes.subarray(filled, filled + can));
					filled += can;
				}
				return 0;
			},
			// Both halves answer from one immutable snapshot of argv, so a
			// program that queries the sizes and then asks for the pointers
			// cannot observe a list that changed underneath it.
			args_sizes_get(argc_ptr, argv_buf_size_ptr) {
				const g = guest(instance);
				argc_ptr >>>= 0;
				argv_buf_size_ptr >>>= 0;
				if (!g.inBounds(argc_ptr, 4) || !g.inBounds(argv_buf_size_ptr, 4)) return EFAULT;
				vectorSizes(g, argc_ptr, argv_buf_size_ptr, encodeList(argv));
				return 0;
			},
			args_get(argv_ptr, argv_buf_ptr) {
				const g = guest(instance);
				argv_ptr >>>= 0;
				argv_buf_ptr >>>= 0;
				const encoded = encodeList(argv);
				// argc + 1 pointers, the last one 0 as the terminator.
				if (!g.inBounds(argv_ptr, (argv.length + 1) * 4)) return EFAULT;
				if (!g.inBounds(argv_buf_ptr, vectorBuffer(encoded))) return EFAULT;
				vectorList(g, argv_ptr, argv_buf_ptr, encoded);
				return 0;
			},
			// The environment is a fixed set, so both halves answer from the one
			// array environ_sizes_get counts: a guest that asks for the sizes
			// and then for the strings sees a single list.
			environ_sizes_get(count_ptr, buf_size_ptr) {
				const g = guest(instance);
				count_ptr >>>= 0;
				buf_size_ptr >>>= 0;
				if (!g.inBounds(count_ptr, 4) || !g.inBounds(buf_size_ptr, 4)) return EFAULT;
				vectorSizes(g, count_ptr, buf_size_ptr, encodeList(default_environ));
				return 0;
			},
			environ_get(environ_ptr, environ_buf_ptr) {
				const g = guest(instance);
				environ_ptr >>>= 0;
				environ_buf_ptr >>>= 0;
				const encoded = encodeList(default_environ);
				if (!g.inBounds(environ_ptr, (encoded.length + 1) * 4)) return EFAULT;
				if (!g.inBounds(environ_buf_ptr, vectorBuffer(encoded))) return EFAULT;
				vectorList(g, environ_ptr, environ_buf_ptr, encoded);
				return 0;
			},
			// Stdin only, unless path_open has handed out a descriptor. The
			// stdin stream has to be drained from memory before _start runs,
			// because _start is one synchronous call and cannot wait for a
			// postMessage. The two sources differ only in where their bytes live
			// and which counter they advance, so they share one copy loop.
			fd_read(fd, iovs, iovs_len, nread) {
				const file = openFiles.get(fd);
				if (fd !== 0 && file === undefined) return EBADF;
				const g = guest(instance);
				iovs >>>= 0;
				iovs_len >>>= 0;
				nread >>>= 0;
				if (!g.inBounds(nread, 4)) return EFAULT;
				const iovecs = readIovecs(g, iovs, iovs_len);
				if (iovecs === null) return EFAULT;
				const src = file === undefined ? stdin : file.node.bytes;
				let pos = file === undefined ? stdinPos : file.pos;
				let read = 0;
				for (const io of iovecs) {
					const can = Math.min(io.len, src.length - pos);
					if (can > 0) {
						new Uint8Array(g.view.buffer, io.buf, can).set(src.subarray(pos, pos + can));
						pos += can;
						read += can;
					}
					if (pos >= src.length) break;
				}
				if (file === undefined) stdinPos = pos;
				else file.pos = pos;
				writeU32(g, nread, read);
				return 0;
			},
			// fd_seek and fd_tell answer in i64, so the offset arrives as BigInt
			// and is written back the same way; that is the same rule
			// clock_time_get and path_open's rights fields already follow. A
			// seek past the end is allowed and reads nothing, the way a real
			// file behaves.
			fd_seek(fd, offset, whence, newoffset_ptr) {
				const g = guest(instance);
				fd >>>= 0;
				whence >>>= 0;
				newoffset_ptr >>>= 0;
				if (!g.inBounds(newoffset_ptr, 8)) return EFAULT;
				if (fd <= STDERR_FD) return ESPIPE;
				const file = openFiles.get(fd);
				if (file === undefined) return fd === PREOPEN_FD ? EISDIR : EBADF;
				const length = BigInt(file.node.bytes.length);
				const from = whence === WHENCE_SET ? 0n
					: whence === WHENCE_CUR ? BigInt(file.pos)
					: whence === WHENCE_END ? length
					: null;
				if (from === null) return EINVAL;
				const want = from + offset;
				if (want < 0n) return EINVAL;
				file.pos = Number(want);
				g.view.setBigUint64(newoffset_ptr, want, true);
				return 0;
			},
			fd_tell(fd, offset_ptr) {
				const g = guest(instance);
				fd >>>= 0;
				offset_ptr >>>= 0;
				if (!g.inBounds(offset_ptr, 8)) return EFAULT;
				if (fd <= STDERR_FD) return ESPIPE;
				const file = openFiles.get(fd);
				if (file === undefined) return fd === PREOPEN_FD ? EISDIR : EBADF;
				g.view.setBigUint64(offset_ptr, BigInt(file.pos), true);
				return 0;
			},
			// The preopen is what lets a guest discover the root at all: without
			// it wasilibc cannot resolve a single relative path.
			fd_prestat_get(fd, prestat_ptr) {
				if (fd !== PREOPEN_FD) return EBADF;
				const g = guest(instance);
				prestat_ptr >>>= 0;
				if (!g.inBounds(prestat_ptr, PRESTAT_SIZE)) return EFAULT;
				g.view.setUint8(prestat_ptr, PRESTAT_TAG_DIR);
				g.view.setUint32(prestat_ptr + 4, PREOPEN_NAME.length, true);
				return 0;
			},
			fd_prestat_dir_name(fd, path_ptr, path_len) {
				if (fd !== PREOPEN_FD) return EBADF;
				const g = guest(instance);
				path_ptr >>>= 0;
				path_len >>>= 0;
				if (!g.inBounds(path_ptr, path_len)) return EFAULT;
				const name = new TextEncoder().encode(PREOPEN_NAME);
				if (path_len !== name.length) return EINVAL;
				new Uint8Array(g.view.buffer, path_ptr, path_len).set(name);
				return 0;
			},
			// dirflags are ignored: there are no links in the store to follow,
			// so a path names the entry itself. The rights fields arrive as
			// BigInt because the ABI declares them i64, and are advisory here.
			path_open(dirfd, dirflags, path_ptr, path_len, oflags, fs_rights_base,
			fs_rights_inheriting, fdflags, opened_fd_ptr) {
				if (dirfd !== PREOPEN_FD) return EBADF;
				const g = guest(instance);
				path_ptr >>>= 0;
				path_len >>>= 0;
				opened_fd_ptr >>>= 0;
				if (!g.inBounds(opened_fd_ptr, 4)) return EFAULT;
				const opened = storePath(g, path_ptr, path_len, store);
				if (opened.errno !== undefined) return opened.errno;
				const node = store.get(opened.path);
				// The entry is emptied in place rather than replaced, so a
				// descriptor already open on it keeps pointing at the same bytes
				// the entry holds.
				if (node !== undefined && node.kind === NODE_DIR) return EISDIR;
				if (node === undefined && (oflags & OFLAG_CREAT) === 0) return ENOENT;
				if (node === undefined) store.set(opened.path, newNode());
				else if ((oflags & OFLAG_TRUNC) !== 0) {
					node.bytes = new Uint8Array(0);
					node.mtime = nowMs();
				}
				const entry = store.get(opened.path);
				const fd = nextFileFd++;
				openFiles.set(fd, {
					node: entry,
					pos: (fdflags & FDFLAG_APPEND) !== 0 ? entry.bytes.length : 0,
					flags: fdflags,
				});
				writeU32(g, opened_fd_ptr, fd);
				return 0;
			},
			// path_filestat_get answers about a path rather than a descriptor, so
			// it goes through the same path check path_open does.
			path_filestat_get(dirfd, flags, path_ptr, path_len, stat_ptr) {
				if (dirfd !== PREOPEN_FD) return EBADF;
				const g = guest(instance);
				path_ptr >>>= 0;
				path_len >>>= 0;
				stat_ptr >>>= 0;
				if (!g.inBounds(stat_ptr, FILESTAT_SIZE)) return EFAULT;
				const opened = storePath(g, path_ptr, path_len, store);
				if (opened.errno !== undefined) return opened.errno;
				const node = store.get(opened.path);
				if (node === undefined) return ENOENT;
				writeFilestat(g, stat_ptr, node);
				return 0;
			},
			path_create_directory(dirfd, path_ptr, path_len) {
				if (dirfd !== PREOPEN_FD) return EBADF;
				const g = guest(instance);
				path_ptr >>>= 0;
				path_len >>>= 0;
				const opened = storePath(g, path_ptr, path_len, store);
				if (opened.errno !== undefined) return opened.errno;
				if (store.has(opened.path)) return EEXIST;
				store.set(opened.path, { kind: NODE_DIR, mtime: nowMs() });
				return 0;
			},
			path_unlink_file(dirfd, path_ptr, path_len) {
				if (dirfd !== PREOPEN_FD) return EBADF;
				const g = guest(instance);
				path_ptr >>>= 0;
				path_len >>>= 0;
				const opened = storePath(g, path_ptr, path_len, store);
				if (opened.errno !== undefined) return opened.errno;
				const node = store.get(opened.path);
				if (node === undefined) return ENOENT;
				if (node.kind === NODE_DIR) return EISDIR;
				store.delete(opened.path);
				return 0;
			},
			path_remove_directory(dirfd, path_ptr, path_len) {
				if (dirfd !== PREOPEN_FD) return EBADF;
				const g = guest(instance);
				path_ptr >>>= 0;
				path_len >>>= 0;
				const opened = storePath(g, path_ptr, path_len, store);
				if (opened.errno !== undefined) return opened.errno;
				const node = store.get(opened.path);
				if (node === undefined) return ENOENT;
				if (node.kind !== NODE_DIR) return ENOTDIR;
				for (const key of store.keys()) {
					if (key.startsWith(`${opened.path}/`)) return ENOTEMPTY;
				}
				store.delete(opened.path);
				return 0;
			},
			fd_close(fd) {
				fd >>>= 0;
				// The console and the preopen are handed to the guest at startup,
				// so closing one is a no-op rather than an error.
				if (fd <= PREOPEN_FD) return 0;
				if (!openFiles.delete(fd)) return EBADF;
				return 0;
			},
			fd_fdstat_get(fd, stat_ptr) {
				const g = guest(instance);
				fd >>>= 0;
				stat_ptr >>>= 0;
				if (!g.inBounds(stat_ptr, FDSTAT_SIZE)) return EFAULT;
				const file = openFiles.get(fd);
				// The flags the descriptor carries, so a guest that sets append
				// can read back that it did. The console and the preopen have
				// none to report.
				const fdflags = file === undefined ? 0 : file.flags;
				if (file === undefined) {
					if (fd <= STDERR_FD) {
						g.view.setUint8(stat_ptr, FILETYPE_CHAR_DEVICE);
					} else if (fd === PREOPEN_FD) {
						g.view.setUint8(stat_ptr, FILETYPE_DIRECTORY);
					} else {
						return EBADF;
					}
				} else {
					g.view.setUint8(stat_ptr, FILETYPE_REGULAR_FILE);
				}
				// Rights stay zero: the store models append and read, and
				// nothing it cannot honour.
				g.view.setUint16(stat_ptr + 2, fdflags, true);
				g.view.setBigUint64(stat_ptr + 8, 0n, true);
				g.view.setBigUint64(stat_ptr + 16, 0n, true);
				return 0;
			},
			// A descriptor's flags live on the descriptor, so setting append on
			// one open file leaves every other description of the same path
			// alone. Bits the store does not model are kept but ignored: a guest
			// that asks for DSYNC or NONBLOCK is answered rather than refused.
			fd_fdstat_set_flags(fd, fdflags) {
				fd >>>= 0;
				fdflags >>>= 0;
				// The console has no position to be append about, and the preopen
				// is not a file at all.
				if (fd <= STDERR_FD) return 0;
				const file = openFiles.get(fd);
				if (file === undefined) return fd === PREOPEN_FD ? EISDIR : EBADF;
				file.flags = fdflags;
				return 0;
			},
			// Nothing to yield to: the playground runs one program at a time.
			// The import exists so a program that calls it still links.
			sched_yield() {
				return 0;
			},
			clock_time_get(clock_id, precision, time_ptr) {
				const g = guest(instance);
				time_ptr >>>= 0;
				if (!g.inBounds(time_ptr, 8)) return EFAULT;
				if (clock_id === CLOCK_REALTIME) {
					const ns = BigInt(Math.round(Date.now() * 1e6));
					g.view.setBigUint64(time_ptr, ns, true);
					return 0;
				}
				if (clock_id === CLOCK_MONOTONIC) {
					const ns = BigInt(Math.round(performance.timeOrigin * 1e6 + performance.now() * 1e6));
					g.view.setBigUint64(time_ptr, ns, true);
					return 0;
				}
				return EINVAL;
			},
		},
	};
	({ instance } = await WebAssembly.instantiate(bytes, imports));
	if (!(instance.exports.memory instanceof WebAssembly.Memory)
		|| typeof instance.exports._start !== 'function') {
		throw new Error('The compiled program must export memory and a _start function.');
	}
	try {
		instance.exports._start();
	} catch (error) {
		// A clean exit is not a failure; anything else was already reported as
		// output or is a genuine trap.
		if (error instanceof WasiExit && error.code === 0) {
			return;
		}
		throw error;
	}
	for (const decoder of decoders.values()) {
		const text = decoder.decode();
		if (text) onOutput(text);
	}
}