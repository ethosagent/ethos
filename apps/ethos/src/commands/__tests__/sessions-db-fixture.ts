// Shared fixture for the sessions-repair / doctor FTS tests: a production-schema
// sessions.db built through SQLiteSessionStore, then damaged through node:sqlite
// directly (the @ethosagent/sqlite shim has no enableDefensive, and FTS5 shadow
// tables are protected until it is off).

import { closeSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';

const usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  estimatedCostUsd: 0,
  apiCallCount: 0,
  compactionCount: 0,
};

/** Write `<dir>/sessions.db` with `rows` messages, checkpointed and closed. */
export async function seedSessionsDb(dir: string, rows = 20): Promise<string> {
  const db = join(dir, 'sessions.db');
  const store = new SQLiteSessionStore(db);
  const s = await store.createSession({
    key: 'cli:x',
    platform: 'cli',
    model: 'm',
    provider: 'p',
    workingDir: '/tmp',
    usage,
  });
  store.close();
  const raw = new DatabaseSync(db);
  const ins = raw.prepare(
    'INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?,?,?,?,?)',
  );
  raw.exec('BEGIN');
  for (let i = 0; i < rows; i++) {
    ins.run(
      `m${i}`,
      s.id,
      'user',
      `hello world number ${i} lorem ipsum dolor sit`,
      new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
    );
  }
  raw.exec('COMMIT');
  raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  raw.close();
  return db;
}

function rawSql(db: string, fn: (d: DatabaseSync) => void): void {
  const d = new DatabaseSync(db);
  try {
    d.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    fn(d);
  } finally {
    d.close();
  }
}

/** Structural FTS damage: integrity_check reports `fts5: ...` (kind `fts`). */
export function blankFtsBlocks(db: string): void {
  rawSql(db, (d) => {
    // @types/node does not declare enableDefensive; the Node 24 runtime does.
    (d as unknown as { enableDefensive(on: boolean): void }).enableDefensive(false);
    d.exec("UPDATE messages_fts_data SET block = x'00' WHERE id > 10");
  });
}

/** Row-set divergence that integrity_check accepts: only the docsize probe sees it. */
export function divergeFts(db: string): void {
  rawSql(db, (d) => {
    d.exec('DROP TRIGGER messages_ad');
    d.exec('DELETE FROM messages WHERE rowid <= 5');
  });
}

/** Zero part of a `messages` table leaf: integrity_check reports a table-root `Tree N` (kind `heap`). */
export function smashHeap(db: string): void {
  const raw = new DatabaseSync(db);
  const leaves = raw
    .prepare(
      "SELECT pageno FROM dbstat WHERE name = 'messages' AND pagetype = 'leaf' AND aggregate = FALSE",
    )
    .all() as { pageno: number }[];
  const ps = (raw.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
  raw.close();
  const page = leaves[Math.min(3, leaves.length - 1)]?.pageno ?? 0;
  const fd = openSync(db, 'r+');
  writeSync(fd, Buffer.alloc(300, 0), 0, 300, (page - 1) * ps + 200);
  closeSync(fd);
}
