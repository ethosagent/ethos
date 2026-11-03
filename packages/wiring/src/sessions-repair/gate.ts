// The exclusive lock gate: "is anything using this database right now?", answered
// by SQLite itself. Extracted from backup/restore.ts `lockDatabase` so restore and
// `ethos sessions repair` share one implementation of the sequence (plan D9).
//
// `restore.ts` documents what the hold does and does not cover (the inode caveat);
// the same text applies here. The caller owns the returned handle and closes it.
//
// Raw `node:fs` (`existsSync`) is the documented packages/wiring carve-out.

import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import Database from '@ethosagent/sqlite';

/** Another process has the database open, so the exclusive gate was refused. */
export class DatabaseInUseError extends Error {
  readonly path: string;
  /** SQLite's own message (for example "database is locked"). */
  readonly lockError: string;

  constructor(path: string, lockError: string) {
    super(`${basename(path)} is in use by another process`);
    this.name = 'DatabaseInUseError';
    this.path = path;
    this.lockError = lockError;
  }
}

/** SQLITE_BUSY (5) / SQLITE_LOCKED (6) or an extended code of either. */
function isBusyOrLocked(err: unknown): boolean {
  const code = (err as { errcode?: unknown } | null)?.errcode;
  return typeof code === 'number' && ((code & 0xff) === 5 || (code & 0xff) === 6);
}

/**
 * Take an exclusive lock on a live database, or throw {@link DatabaseInUseError}
 * when another process holds it (any other open failure is rethrown raw).
 *
 * `locking_mode = EXCLUSIVE` followed by a write transaction is the check that
 * works in WAL mode: a plain `BEGIN IMMEDIATE` only conflicts with another WRITER,
 * while an idle reader (`ethos chat` at a prompt) is exactly what this must catch.
 * Under exclusive locking SQLite needs sole ownership of the WAL index, which any
 * open connection denies it. The returned connection IS the lock: it is held until
 * the caller closes it, and a late opener is refused meanwhile.
 *
 * Returns `null` when there is no such file. Pinned by
 * `__tests__/repair.test.ts` ("apply refuses when a peer connection is open",
 * "a late opener is refused while apply runs") and by the restore tests
 * (`backup/__tests__/restore-*.test.ts`).
 */
export function acquireDatabaseLockGate(dbPath: string): Database.Database | null {
  if (!existsSync(dbPath)) return null;
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath);
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    db.exec('BEGIN IMMEDIATE');
    db.exec('COMMIT');
    return db;
  } catch (err) {
    db?.close();
    // Only busy/locked means "in use"; anything else (NOTADB, CANTOPEN, EACCES) is
    // not a contention verdict and propagates raw so callers do not hunt holders.
    if (isBusyOrLocked(err)) {
      throw new DatabaseInUseError(dbPath, err instanceof Error ? err.message : String(err));
    }
    throw err;
  }
}
