import { closeSync, mkdtempSync, openSync, readFileSync, statSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import Database from '@ethosagent/sqlite';

export const dirs: string[] = [];
export const workers: Worker[] = [];

export const usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  estimatedCostUsd: 0,
  apiCallCount: 0,
  compactionCount: 0,
};

/** A data dir holding a closed, checkpointed sessions.db with `rows` messages. */
/**
 * `indexShape` writes short non-ISO timestamps: the index-damage constructions only
 * surface as `Tree N ...` lines (rather than a thrown "malformed") with that key
 * shape. Those rows are NOT valid timestamps, so row-scan assertions never use it.
 */
export async function makeDataDir(
  rows = 20,
  indexShape = false,
): Promise<{ dir: string; db: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'sessions-repair-'));
  dirs.push(dir);
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
      indexShape ? `2026-01-01T00:${i}` : new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
    );
  }
  raw.exec('COMMIT');
  raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  raw.close();
  return { dir, db };
}

export function rawSql<T>(db: string, fn: (d: DatabaseSync) => T): T {
  const d = new DatabaseSync(db);
  try {
    d.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return fn(d);
  } finally {
    d.close();
  }
}

export function blankFtsBlocks(db: string): void {
  rawSql(db, (d) => {
    // @types/node does not declare enableDefensive; the Node 24 runtime does.
    (d as unknown as { enableDefensive(on: boolean): void }).enableDefensive(false);
    d.exec("UPDATE messages_fts_data SET block = x'00' WHERE id > 10");
  });
}

/** Row-set divergence: integrity_check accepts it, the docsize probe sees it. */
export function diverge(db: string): void {
  rawSql(db, (d) => {
    d.exec('DROP TRIGGER messages_ad');
    d.exec('DELETE FROM messages WHERE rowid <= 5');
  });
}

/** Token-level divergence only the rank=1 check sees: same row set, stale tokens. */
export function divergeTokens(db: string): void {
  rawSql(db, (d) => {
    d.exec('DROP TRIGGER messages_au');
    d.exec("UPDATE messages SET content = 'completely different words here' WHERE rowid <= 5");
  });
}

export function smashLeaf(
  path: string,
  name: string,
  fill: number,
  from: number,
  len?: number,
): void {
  const raw = new DatabaseSync(path);
  const leaves = raw
    .prepare("SELECT pageno FROM dbstat WHERE name = ? AND pagetype = 'leaf' AND aggregate = FALSE")
    .all(name) as { pageno: number }[];
  const ps = (raw.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
  raw.close();
  const page = leaves[Math.min(3, leaves.length - 1)]?.pageno ?? 0;
  const fd = openSync(path, 'r+');
  const n = len ?? ps - from;
  writeSync(fd, Buffer.alloc(n, fill), 0, n, (page - 1) * ps + from);
  closeSync(fd);
}

export function verdict(path: string): string {
  const d = new Database(path);
  try {
    return (d.pragma('integrity_check') as { integrity_check: string }[])
      .map((r) => r.integrity_check)
      .join('\n');
  } catch (err) {
    return (err as Error).message;
  } finally {
    d.close();
  }
}

/** A worker thread holding an open reader connection until `release()`. */
export async function holdReader(db: string): Promise<{ release: () => Promise<void> }> {
  const w = new Worker(
    `const { DatabaseSync } = require('node:sqlite');
     const { workerData, parentPort } = require('node:worker_threads');
     const db = new DatabaseSync(workerData.db);
     db.prepare('SELECT count(*) FROM messages').get();
     parentPort.postMessage('open');
     parentPort.once('message', () => { db.close(); parentPort.postMessage('closed'); });`,
    { eval: true, workerData: { db } },
  );
  workers.push(w);
  await new Promise<void>((resolve, reject) => {
    w.once('message', () => resolve());
    w.once('error', reject);
  });
  return {
    release: () =>
      new Promise<void>((resolve) => {
        w.once('message', () => resolve());
        w.postMessage('go');
      }),
  };
}

/** Try to open and read the db from a worker thread; resolves with the error text or null. */
export function tryOpenFromWorker(db: string): Promise<string | null> {
  const w = new Worker(
    `const { DatabaseSync } = require('node:sqlite');
     const { workerData, parentPort } = require('node:worker_threads');
     try {
       const db = new DatabaseSync(workerData.db);
       db.prepare('SELECT count(*) FROM messages').get();
       db.close();
       parentPort.postMessage(null);
     } catch (e) { parentPort.postMessage(String(e.message)); }`,
    { eval: true, workerData: { db } },
  );
  workers.push(w);
  return new Promise((resolve, reject) => {
    w.once('message', resolve);
    w.once('error', reject);
  });
}

export const stat = (p: string) => {
  const s = statSync(p);
  return { bytes: readFileSync(p).toString('base64'), mtimeMs: s.mtimeMs };
};

export const ROOMY = () => ({ bavail: 1e12, bsize: 1 });
