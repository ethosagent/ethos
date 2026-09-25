import type { BackupOptions, DatabaseSync as DatabaseSyncClass } from 'node:sqlite';

// `node:sqlite` is a Node built-in. Resolve it via `process.getBuiltinModule`
// instead of a static `import ... from 'node:sqlite'` so the bundler cannot
// strip the `node:` prefix: esbuild rewrote it to a bare `sqlite` specifier in
// the published CLI bundle, breaking `ethos serve` with ERR_MODULE_NOT_FOUND.
// The `import type` above is erased at build time, so no runtime import remains.
const { DatabaseSync, backup: nodeBackup } = process.getBuiltinModule(
  'node:sqlite',
) as typeof import('node:sqlite');
type DatabaseSync = DatabaseSyncClass;

type RunResult = { changes: number; lastInsertRowid: number };

// biome-ignore lint/suspicious/noExplicitAny: type guard for named params objects
function isNamedParams(arg: any): arg is Record<string, unknown> {
  return (
    arg !== null &&
    arg !== undefined &&
    typeof arg === 'object' &&
    !Array.isArray(arg) &&
    !(arg instanceof Uint8Array) &&
    !(arg instanceof Buffer)
  );
}

class Statement {
  // biome-ignore lint/suspicious/noExplicitAny: wraps node:sqlite's variadic params
  private inner: any;

  // biome-ignore lint/suspicious/noExplicitAny: wraps node:sqlite's variadic params
  constructor(inner: any) {
    this.inner = inner;
  }

  // biome-ignore lint/suspicious/noExplicitAny: accepts both positional and named params
  run(...params: any[]): RunResult {
    const r =
      params.length === 1 && isNamedParams(params[0])
        ? this.inner.run(params[0])
        : this.inner.run(...params);
    return {
      changes: Number(r.changes),
      lastInsertRowid: Number(r.lastInsertRowid),
    };
  }

  // biome-ignore lint/suspicious/noExplicitAny: accepts both positional and named params
  get(...params: any[]): any {
    const r =
      params.length === 1 && isNamedParams(params[0])
        ? this.inner.get(params[0])
        : this.inner.get(...params);
    return r;
  }

  // biome-ignore lint/suspicious/noExplicitAny: accepts both positional and named params
  all(...params: any[]): any[] {
    const r =
      params.length === 1 && isNamedParams(params[0])
        ? this.inner.all(params[0])
        : this.inner.all(...params);
    return r;
  }

  // biome-ignore lint/suspicious/noExplicitAny: accepts both positional and named params
  *iterate(...params: any[]): Generator<any> {
    const rows = this.all(...params);
    for (const row of rows) {
      yield row;
    }
  }
}

/** `PRAGMA journal_mode = …` — a journal-mode switch, not a read of it. */
const JOURNAL_MODE_SWITCH_RE = /^\s*journal_mode\s*=/i;
/** How long a journal-mode switch keeps retrying a busy database: the same
 *  5000ms every cross-process store gives `busy_timeout`. */
const JOURNAL_MODE_RETRY_MS = 5_000;
const JOURNAL_MODE_BACKOFF_MS = 10;
const SQLITE_BUSY = 5;

function isBusy(err: unknown): boolean {
  const code = (err as { errcode?: unknown } | null)?.errcode;
  return typeof code === 'number' && (code & 0xff) === SQLITE_BUSY;
}

class _Database {
  // biome-ignore lint/suspicious/noExplicitAny: namespace merge for Database.Database type compat
  static Database: any = _Database;

  private inner: DatabaseSync;
  private _txDepth = 0;
  private _closed = false;

  constructor(path: string, opts?: { readonly?: boolean }) {
    this.inner = new DatabaseSync(path, {
      readOnly: opts?.readonly ?? false,
    });
  }

  prepare(sql: string): Statement {
    return new Statement(this.inner.prepare(sql));
  }

  exec(sql: string): void {
    this.inner.exec(sql);
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.inner.close();
  }

  pragma(str: string, _opts?: Record<string, unknown>): unknown {
    if (JOURNAL_MODE_SWITCH_RE.test(str)) {
      this.switchJournalMode(str);
      return undefined;
    }
    if (str.includes('=')) {
      this.inner.exec(`PRAGMA ${str}`);
      return undefined;
    }
    return this.prepare(`PRAGMA ${str}`).all();
  }

  /**
   * Switch the journal mode, retrying while another connection holds the lock.
   *
   * SQLite answers a contended journal-mode switch with SQLITE_BUSY at once and
   * never consults the busy handler, so `busy_timeout` does not cover it. Two
   * processes opening the same fresh file — `ethos run-all` starts gateway and
   * serve together, and both open every shared store on first boot — collide
   * here, and the loser used to exit with "database is locked". A retry is
   * enough: once the winner has converted the file, the switch is a no-op read.
   * Synchronous like the rest of the shim; the wait is bounded by
   * JOURNAL_MODE_RETRY_MS. Pinned by __tests__/database.test.ts
   * ("journal-mode switch").
   */
  private switchJournalMode(str: string): void {
    const deadline = Date.now() + JOURNAL_MODE_RETRY_MS;
    for (;;) {
      try {
        this.inner.exec(`PRAGMA ${str}`);
        return;
      } catch (err) {
        if (!isBusy(err) || Date.now() >= deadline) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, JOURNAL_MODE_BACKOFF_MS);
      }
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: must accept any function signature for better-sqlite3 compat
  transaction<T extends (...args: any[]) => any>(
    fn: T,
  ): T & { deferred: T; immediate: T; exclusive: T } {
    const self = this;
    const makeWrapper = (beginCmd: string) => {
      // biome-ignore lint/suspicious/noExplicitAny: wrapper must match any function signature
      const wrapper = function (this: any, ...args: any[]) {
        if (self._txDepth === 0) {
          self._txDepth++;
          self.inner.exec(beginCmd);
          try {
            const result = fn.apply(this, args);
            self.inner.exec('COMMIT');
            return result;
          } catch (err) {
            self.inner.exec('ROLLBACK');
            throw err;
          } finally {
            self._txDepth--;
          }
        } else {
          const sp = `sp_${self._txDepth}`;
          self._txDepth++;
          self.inner.exec(`SAVEPOINT ${sp}`);
          try {
            const result = fn.apply(this, args);
            self.inner.exec(`RELEASE ${sp}`);
            return result;
          } catch (err) {
            self.inner.exec(`ROLLBACK TO ${sp}`);
            self.inner.exec(`RELEASE ${sp}`);
            throw err;
          } finally {
            self._txDepth--;
          }
        }
      } as unknown as T;
      return wrapper;
    };

    const defaultWrapper = makeWrapper('BEGIN') as T & { deferred: T; immediate: T; exclusive: T };
    defaultWrapper.deferred = makeWrapper('BEGIN DEFERRED') as T;
    defaultWrapper.immediate = makeWrapper('BEGIN IMMEDIATE') as T;
    defaultWrapper.exclusive = makeWrapper('BEGIN EXCLUSIVE') as T;
    return defaultWrapper;
  }
}

namespace _Database {
  export type Database = _Database;
}

/**
 * Copy an open database to `destPath` via SQLite's online backup API.
 *
 * The one ASYNCHRONOUS member of an otherwise synchronous shim, deliberately:
 * in-process callers (the scheduled backup task, the web RPC) run inside a
 * serving process, where a synchronous `VACUUM INTO` over a multi-hundred-MB
 * database would stall the event loop for the whole copy. The source database
 * stays usable throughout, and the copy is consistent in WAL mode without a
 * checkpoint — which a plain file copy is not.
 *
 * Resolves with the number of pages transferred. `@types/node` declares the
 * return as `Promise<void>`, but Node 24 resolves the page count (as its own
 * documentation shows), hence the cast.
 */
export function backup(db: _Database, destPath: string, options?: BackupOptions): Promise<number> {
  // biome-ignore lint/suspicious/noExplicitAny: reads the wrapped node:sqlite handle without widening the public Database surface
  const source = (db as any).inner as DatabaseSync;
  // Node rejects an explicit `undefined` third argument ("options must be an
  // object"), so an absent `options` becomes `{}` and the platform defaults apply.
  return nodeBackup(source, destPath, options ?? {}) as unknown as Promise<number>;
}

export default _Database;
export type { BackupOptions, BackupProgressInfo } from 'node:sqlite';
export { type MigrationConfig, migrate } from './migrate';
export type { _Database as Database };
