import { DatabaseSync } from 'node:sqlite';

type RunResult = { changes: number; lastInsertRowid: number };

function isNamedParams(arg: unknown): arg is Record<string, unknown> {
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
  private inner: ReturnType<DatabaseSync['prepare']>;

  constructor(inner: ReturnType<DatabaseSync['prepare']>) {
    this.inner = inner;
  }

  run(...params: unknown[]): RunResult {
    const r = params.length === 1 && isNamedParams(params[0])
      ? this.inner.run(params[0] as Record<string, unknown>)
      : this.inner.run(...params);
    return {
      changes: Number(r.changes),
      lastInsertRowid: Number(r.lastInsertRowid),
    };
  }

  get(...params: unknown[]): Record<string, unknown> | undefined {
    const r = params.length === 1 && isNamedParams(params[0])
      ? this.inner.get(params[0] as Record<string, unknown>)
      : this.inner.get(...params);
    return r as Record<string, unknown> | undefined;
  }

  all(...params: unknown[]): Record<string, unknown>[] {
    const r = params.length === 1 && isNamedParams(params[0])
      ? this.inner.all(params[0] as Record<string, unknown>)
      : this.inner.all(...params);
    return r as Record<string, unknown>[];
  }

  *iterate(...params: unknown[]): Generator<Record<string, unknown>> {
    const rows = this.all(...params);
    for (const row of rows) {
      yield row;
    }
  }
}

class Database {
  static Database = Database;

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
    if (str.includes('=')) {
      this.inner.exec('PRAGMA ' + str);
      return undefined;
    }
    return this.prepare('PRAGMA ' + str).all();
  }

  transaction<T extends (...args: unknown[]) => unknown>(fn: T): T & { deferred: T; immediate: T; exclusive: T } {
    const self = this;
    const makeWrapper = (beginCmd: string) => {
      const wrapper = function (this: unknown, ...args: unknown[]) {
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

export default Database;
export type { Database };
