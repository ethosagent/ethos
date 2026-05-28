import { resolve } from 'node:path';
import { BoundaryError } from '@ethosagent/types';
/**
 * Decorator over Storage that enforces a per-scope read/write allowlist
 * plus the Ch.5 universal always-deny floor. Used by tools-file to bound
 * a personality's filesystem reach to its own directory + cwd.
 *
 * Order of checks (any deny wins over any allow):
 *   1. always-deny — request rejected.
 *   2. allow allowlist — request rejected if no prefix matches.
 *
 * Prefixes are matched literally — there is no glob expansion. Pass paths
 * that end in `/` for directory scopes; ScopedStorage normalizes them so
 * `/a/b` does not also match `/a/bc/`.
 */
export class ScopedStorage {
  inner;
  readPrefixes;
  writePrefixes;
  denyPrefixes;
  constructor(inner, scope) {
    this.inner = inner;
    this.readPrefixes = scope.read.map(normalizePrefix);
    this.writePrefixes = scope.write.map(normalizePrefix);
    this.denyPrefixes = (scope.alwaysDeny ?? []).map(normalizePrefix);
  }
  check(rawPath, kind) {
    // Normalize the path before checking against prefixes so that `..`
    // segments cannot bypass the prefix-based allowlist.
    const path = resolve(rawPath);
    if (isPathAllowed(path, this.denyPrefixes)) {
      throw new BoundaryError(kind, path, this.denyPrefixes, 'always-deny floor');
    }
    const allowed = kind === 'read' ? this.readPrefixes : this.writePrefixes;
    if (!isPathAllowed(path, allowed)) {
      throw new BoundaryError(kind, path, allowed);
    }
  }
  async read(path) {
    this.check(path, 'read');
    return this.inner.read(path);
  }
  async readBytes(path) {
    this.check(path, 'read');
    return this.inner.readBytes(path);
  }
  async exists(path) {
    this.check(path, 'read');
    return this.inner.exists(path);
  }
  async mtime(path) {
    this.check(path, 'read');
    return this.inner.mtime(path);
  }
  async list(dir) {
    this.check(dir, 'read');
    return this.inner.list(dir);
  }
  async listEntries(dir) {
    this.check(dir, 'read');
    return this.inner.listEntries(dir);
  }
  async write(path, content, opts) {
    this.check(path, 'write');
    return this.inner.write(path, content, opts);
  }
  async append(path, content) {
    this.check(path, 'write');
    return this.inner.append(path, content);
  }
  async writeAtomic(path, content, opts) {
    this.check(path, 'write');
    return this.inner.writeAtomic(path, content, opts);
  }
  async mkdir(dir) {
    this.check(dir, 'write');
    return this.inner.mkdir(dir);
  }
  async remove(path, opts) {
    this.check(path, 'write');
    return this.inner.remove(path, opts);
  }
  async rename(from, to) {
    this.check(from, 'write');
    this.check(to, 'write');
    return this.inner.rename(from, to);
  }
  async chmod(path, mode) {
    this.check(path, 'write');
    return this.inner.chmod(path, mode);
  }
}
function normalizePrefix(prefix) {
  // A prefix matches any path where prefix is followed by '/' or end-of-string,
  // OR where the path equals the prefix exactly. We keep the prefix as-given
  // (with or without trailing slash) and handle the boundary in isPathAllowed.
  return prefix;
}
function isPathAllowed(path, prefixes) {
  for (const prefix of prefixes) {
    if (path === prefix) return true;
    const withoutSlash = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
    // Allow the directory itself (without trailing slash) — needed so
    // `mkdir(<personality-dir>)` and `list(<personality-dir>)` succeed
    // when the configured prefix has a trailing slash.
    if (path === withoutSlash) return true;
    const withSlash = `${withoutSlash}/`;
    if (path.startsWith(withSlash)) return true;
  }
  return false;
}
