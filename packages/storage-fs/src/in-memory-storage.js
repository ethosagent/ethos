import { dirname } from 'node:path';
/**
 * In-memory Storage implementation for tests. Mirrors fs semantics closely:
 *
 *  - read/exists/mtime return null for missing paths.
 *  - write requires the parent directory to exist (throws ENOENT otherwise) —
 *    matches fs.writeFile and forces tests to mkdir first, just like prod.
 *  - mkdir is always recursive; no-op on existing dirs; throws on file conflict.
 *  - remove without recursive throws on missing paths and on non-empty dirs.
 *  - writeAtomic round-trips through a temp key, identical to fs flow.
 *
 * mtime ticks forward on every write so cache-by-mtime patterns work in tests
 * without sleeping.
 */
export class InMemoryStorage {
  // Absolute path → node
  nodes = new Map();
  // Recorded directory modes (chmod against a directory). Tracked
  // separately because directory entries are implicit in the Map.
  dirModes = new Map();
  clock = 0;
  // Treat the filesystem root as always existing so consumers don't need to
  // mkdir('/') before writing to a file at the root.
  isRootLike(path) {
    return path === '/' || /^[A-Za-z]:[\\/]?$/.test(path);
  }
  nextMtime() {
    this.clock += 1;
    return this.clock;
  }
  getNode(path) {
    return this.nodes.get(path);
  }
  requireParentDir(path) {
    const parent = dirname(path);
    if (parent === path) return;
    if (this.isRootLike(parent)) return;
    const node = this.nodes.get(parent);
    if (!node) {
      const err = new Error(`ENOENT: no such file or directory, open '${path}'`);
      err.code = 'ENOENT';
      throw err;
    }
    if (node.type !== 'dir') {
      const err = new Error(`ENOTDIR: not a directory, open '${path}'`);
      err.code = 'ENOTDIR';
      throw err;
    }
  }
  async read(path) {
    const node = this.getNode(path);
    if (!node) return null;
    if (node.type === 'dir') {
      const err = new Error(`EISDIR: illegal operation on a directory, read '${path}'`);
      err.code = 'EISDIR';
      throw err;
    }
    return typeof node.content === 'string'
      ? node.content
      : new TextDecoder('utf-8').decode(node.content);
  }
  async readBytes(path) {
    const node = this.getNode(path);
    if (!node) return null;
    if (node.type === 'dir') {
      const err = new Error(`EISDIR: illegal operation on a directory, read '${path}'`);
      err.code = 'EISDIR';
      throw err;
    }
    // String-stored content round-trips through utf-8; binary-stored content
    // is returned verbatim. Mirrors the asymmetry in `write`.
    return typeof node.content === 'string' ? new TextEncoder().encode(node.content) : node.content;
  }
  async exists(path) {
    return this.nodes.has(path);
  }
  async mtime(path) {
    const node = this.getNode(path);
    return node ? node.mtimeMs : null;
  }
  async list(dir) {
    const node = this.getNode(dir);
    if (!node) return [];
    if (node.type !== 'dir') {
      const err = new Error(`ENOTDIR: not a directory, scandir '${dir}'`);
      err.code = 'ENOTDIR';
      throw err;
    }
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    const names = [];
    for (const key of this.nodes.keys()) {
      if (key === dir) continue;
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest.includes('/')) continue;
      names.push(rest);
    }
    return names.sort();
  }
  async listEntries(dir) {
    const names = await this.list(dir);
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    return names.map((name) => {
      const node = this.nodes.get(prefix + name);
      return { name, isDir: node?.type === 'dir' };
    });
  }
  async write(path, content, opts) {
    const existing = this.nodes.get(path);
    if (existing && existing.type === 'dir') {
      const err = new Error(`EISDIR: illegal operation on a directory, write '${path}'`);
      err.code = 'EISDIR';
      throw err;
    }
    this.requireParentDir(path);
    const node = {
      type: 'file',
      content,
      mtimeMs: this.nextMtime(),
    };
    if (opts?.mode !== undefined) node.mode = opts.mode;
    this.nodes.set(path, node);
  }
  async writeAtomic(path, content, opts) {
    // Same observable end-state as write — atomicity is a property of the
    // backing store; the in-memory map is single-step by definition.
    await this.write(path, content, opts);
  }
  async append(path, content) {
    const existing = this.nodes.get(path);
    if (existing && existing.type === 'dir') {
      const err = new Error(`EISDIR: illegal operation on a directory, append '${path}'`);
      err.code = 'EISDIR';
      throw err;
    }
    if (!existing) {
      // appendFile creates the file if missing — match that semantics.
      this.requireParentDir(path);
      this.nodes.set(path, {
        type: 'file',
        content,
        mtimeMs: this.nextMtime(),
      });
      return;
    }
    // Append is utf-8 only: mixing a string append onto raw bytes
    // would silently lossy-decode invalid sequences as U+FFFD. Throw
    // instead so test fakes catch the same mistake FsStorage would —
    // FsStorage.append takes a `string` and writes utf-8; if the file
    // on disk is binary, the bytes get concatenated verbatim and the
    // file is corrupt either way. Use writeAtomic for binary blobs.
    if (typeof existing.content !== 'string') {
      const err = new Error(
        `EINVAL: cannot append text to a binary file '${path}'. Use writeAtomic for binary content.`,
      );
      err.code = 'EINVAL';
      throw err;
    }
    this.nodes.set(path, {
      ...existing,
      content: existing.content + content,
      mtimeMs: this.nextMtime(),
    });
  }
  async mkdir(dir) {
    if (this.isRootLike(dir)) return;
    const existing = this.nodes.get(dir);
    if (existing) {
      if (existing.type === 'dir') return;
      const err = new Error(`EEXIST: file already exists, mkdir '${dir}'`);
      err.code = 'EEXIST';
      throw err;
    }
    // Recursively create parents.
    const parent = dirname(dir);
    if (parent !== dir && !this.isRootLike(parent) && !this.nodes.has(parent)) {
      await this.mkdir(parent);
    }
    this.nodes.set(dir, { type: 'dir', mtimeMs: this.nextMtime() });
  }
  async remove(path, opts) {
    const node = this.nodes.get(path);
    if (!node) {
      const err = new Error(`ENOENT: no such file or directory, remove '${path}'`);
      err.code = 'ENOENT';
      throw err;
    }
    if (node.type === 'file') {
      this.nodes.delete(path);
      return;
    }
    // Directory.
    const prefix = path.endsWith('/') ? path : `${path}/`;
    const children = [];
    for (const key of this.nodes.keys()) {
      if (key !== path && key.startsWith(prefix)) children.push(key);
    }
    if (children.length > 0 && opts?.recursive !== true) {
      const err = new Error(`ENOTEMPTY: directory not empty, remove '${path}'`);
      err.code = 'ENOTEMPTY';
      throw err;
    }
    for (const key of children) this.nodes.delete(key);
    this.nodes.delete(path);
  }
  async rename(from, to) {
    const node = this.nodes.get(from);
    if (!node) {
      const err = new Error(`ENOENT: no such file or directory, rename '${from}' -> '${to}'`);
      err.code = 'ENOENT';
      throw err;
    }
    this.requireParentDir(to);
    if (node.type === 'file') {
      const target = this.nodes.get(to);
      if (target?.type === 'dir') {
        const err = new Error(`EISDIR: cannot rename file onto directory, '${from}' -> '${to}'`);
        err.code = 'EISDIR';
        throw err;
      }
      this.nodes.delete(from);
      this.nodes.set(to, { ...node, mtimeMs: this.nextMtime() });
      return;
    }
    // Directory rename — move the directory itself plus every descendant.
    const targetExisting = this.nodes.get(to);
    if (targetExisting) {
      const err = new Error(`EEXIST: target exists, rename '${from}' -> '${to}'`);
      err.code = 'EEXIST';
      throw err;
    }
    const fromPrefix = from.endsWith('/') ? from : `${from}/`;
    const moves = [[from, to]];
    for (const key of this.nodes.keys()) {
      if (key !== from && key.startsWith(fromPrefix)) {
        moves.push([key, to + key.slice(from.length)]);
      }
    }
    for (const [src, dst] of moves) {
      const n = this.nodes.get(src);
      if (!n) continue;
      this.nodes.delete(src);
      this.nodes.set(dst, { ...n, mtimeMs: this.nextMtime() });
    }
  }
  async chmod(path, mode) {
    const node = this.nodes.get(path);
    if (!node) {
      const err = new Error(`ENOENT: no such file or directory, chmod '${path}'`);
      err.code = 'ENOENT';
      throw err;
    }
    if (node.type === 'file') {
      this.nodes.set(path, { ...node, mode });
    } else {
      // Track directory mode in a side-channel so tests can assert it.
      this.dirModes.set(path, mode);
    }
  }
  // --- Test helpers -----------------------------------------------------
  /** Return the recorded mode for a directory (undefined if no mode was set). */
  getDirMode(path) {
    return this.dirModes.get(path);
  }
  /** Synchronous existence check. Not on the Storage interface (which is
   *  async-only) — exists as a concrete-class method for the `hasSecret`
   *  use case in PluginApiImpl. */
  existsSync(path) {
    return this.nodes.has(path);
  }
  /** Drop all state. Useful for `beforeEach` resets without re-instantiating. */
  reset() {
    this.nodes.clear();
    this.dirModes.clear();
    this.clock = 0;
  }
  /** Return the recorded mode for a file (undefined if no mode was set). */
  getMode(path) {
    const node = this.nodes.get(path);
    if (!node || node.type !== 'file') return undefined;
    return node.mode;
  }
}
