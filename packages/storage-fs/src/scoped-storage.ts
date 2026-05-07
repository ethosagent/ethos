import {
  BoundaryError,
  type Storage,
  type StorageDirEntry,
  type StorageRemoveOptions,
  type StorageWriteOptions,
} from '@ethosagent/types';

export interface ScopedStorageScope {
  /** Absolute path prefixes that may be read. */
  read: readonly string[];
  /** Absolute path prefixes that may be written / mutated. */
  write: readonly string[];
  /**
   * Ch.5 — universal always-deny prefixes. Match these and the request
   * fails regardless of allow rules. This is the floor: a personality
   * config that lists `~/` in `allow` still cannot read `~/.ssh`. Lives
   * in code (default list provided by the wiring layer); user can extend
   * but cannot remove built-in entries.
   */
  alwaysDeny?: readonly string[];
}

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
export class ScopedStorage implements Storage {
  private readonly readPrefixes: string[];
  private readonly writePrefixes: string[];
  private readonly denyPrefixes: string[];

  constructor(
    private readonly inner: Storage,
    scope: ScopedStorageScope,
  ) {
    this.readPrefixes = scope.read.map(normalizePrefix);
    this.writePrefixes = scope.write.map(normalizePrefix);
    this.denyPrefixes = (scope.alwaysDeny ?? []).map(normalizePrefix);
  }

  private check(path: string, kind: 'read' | 'write'): void {
    if (isPathAllowed(path, this.denyPrefixes)) {
      throw new BoundaryError(kind, path, this.denyPrefixes, 'always-deny floor');
    }
    const allowed = kind === 'read' ? this.readPrefixes : this.writePrefixes;
    if (!isPathAllowed(path, allowed)) {
      throw new BoundaryError(kind, path, allowed);
    }
  }

  async read(path: string): Promise<string | null> {
    this.check(path, 'read');
    return this.inner.read(path);
  }

  async exists(path: string): Promise<boolean> {
    this.check(path, 'read');
    return this.inner.exists(path);
  }

  async mtime(path: string): Promise<number | null> {
    this.check(path, 'read');
    return this.inner.mtime(path);
  }

  async list(dir: string): Promise<string[]> {
    this.check(dir, 'read');
    return this.inner.list(dir);
  }

  async listEntries(dir: string): Promise<StorageDirEntry[]> {
    this.check(dir, 'read');
    return this.inner.listEntries(dir);
  }

  async write(path: string, content: string, opts?: StorageWriteOptions): Promise<void> {
    this.check(path, 'write');
    return this.inner.write(path, content, opts);
  }

  async append(path: string, content: string): Promise<void> {
    this.check(path, 'write');
    return this.inner.append(path, content);
  }

  async writeAtomic(path: string, content: string, opts?: StorageWriteOptions): Promise<void> {
    this.check(path, 'write');
    return this.inner.writeAtomic(path, content, opts);
  }

  async mkdir(dir: string): Promise<void> {
    this.check(dir, 'write');
    return this.inner.mkdir(dir);
  }

  async remove(path: string, opts?: StorageRemoveOptions): Promise<void> {
    this.check(path, 'write');
    return this.inner.remove(path, opts);
  }

  async rename(from: string, to: string): Promise<void> {
    this.check(from, 'write');
    this.check(to, 'write');
    return this.inner.rename(from, to);
  }
}

function normalizePrefix(prefix: string): string {
  // A prefix matches any path where prefix is followed by '/' or end-of-string,
  // OR where the path equals the prefix exactly. We keep the prefix as-given
  // (with or without trailing slash) and handle the boundary in isPathAllowed.
  return prefix;
}

function isPathAllowed(path: string, prefixes: readonly string[]): boolean {
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
