// Pins extensions/session-sqlite/src/fts-health.ts against real files: stores are
// created with SQLiteSessionStore (production schema), closed, then reopened raw.
// Corruption goes through node:sqlite directly because the @ethosagent/sqlite shim
// has no enableDefensive (FTS5 shadow tables are protected until it is off).

import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import Database from '@ethosagent/sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyIntegrity,
  deepCheckMessagesFts,
  probeMessagesFts,
  rebuildMessagesFts,
} from '../fts-health';
import { SQLiteSessionStore } from '../index';

const dirs: string[] = [];
const handles: Database.Database[] = [];

afterEach(() => {
  for (const h of handles.splice(0)) h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  estimatedCostUsd: 0,
  apiCallCount: 0,
  compactionCount: 0,
};

/** A closed on-disk sessions.db with `rows` messages (bulk-inserted raw for speed). */
async function makeDb(rows = 20): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'ethos-fts-health-'));
  dirs.push(dir);
  const path = join(dir, 'sessions.db');
  const store = new SQLiteSessionStore(path);
  const s = await store.createSession({
    key: 'cli:x',
    platform: 'cli',
    model: 'm',
    provider: 'p',
    workingDir: '/tmp',
    usage,
  });
  store.close();
  const db = new DatabaseSync(path);
  const ins = db.prepare(
    'INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?,?,?,?,?)',
  );
  db.exec('BEGIN');
  for (let i = 0; i < rows; i++) {
    ins.run(
      `m${i}`,
      s.id,
      'user',
      `hello world number ${i} lorem ipsum dolor sit`,
      `2026-01-01T00:${i}`,
    );
  }
  db.exec('COMMIT');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  return path;
}

function open(path: string, readonly = false): Database.Database {
  const db = new Database(path, { readonly });
  handles.push(db);
  return db;
}

/** Blank the FTS content blocks the way file-level damage would (F1/F2). */
function blankFtsBlocks(path: string): void {
  const raw = new DatabaseSync(path);
  // @types/node does not declare enableDefensive; the Node 24 runtime does.
  (raw as unknown as { enableDefensive(on: boolean): void }).enableDefensive(false);
  raw.exec("UPDATE messages_fts_data SET block = x'00' WHERE id > 10");
  raw.close();
}

/** Drop the delete trigger and delete rows: divergence integrity_check accepts (F4). */
function diverge(path: string): void {
  const raw = new DatabaseSync(path);
  raw.exec('DROP TRIGGER messages_ad');
  raw.exec('DELETE FROM messages WHERE rowid <= 5');
  raw.close();
}

/** Overwrite `len` bytes of one leaf page of tree `name` with `fill`. */
function smashLeaf(path: string, name: string, fill: number, from: number, len?: number): void {
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

/** The verdict the way doctor sees it: integrity_check rows joined, or the thrown message. */
function verdict(db: Database.Database): string {
  try {
    const rows = db.pragma('integrity_check') as { integrity_check: string }[];
    return rows.map((r) => r.integrity_check).join('\n');
  } catch (err) {
    return (err as Error).message;
  }
}

describe('probeMessagesFts', () => {
  it('reports zero drift on a healthy store', async () => {
    const p = probeMessagesFts(open(await makeDb(20)));
    expect(p).toEqual({
      messages: 20,
      indexedDocs: 20,
      unindexed: 0,
      dangling: 0,
      ftsPresent: true,
    });
  });

  it('counts dangling and unindexed after the delete trigger is dropped', async () => {
    const path = await makeDb(20);
    const raw = new DatabaseSync(path);
    raw.exec('DROP TRIGGER messages_ad');
    raw.exec('DROP TRIGGER messages_ai');
    raw.exec('DELETE FROM messages WHERE rowid <= 10');
    raw.exec(
      "INSERT INTO messages (id, session_id, role, content, timestamp) SELECT 'new', session_id, 'user', 'late', 't' FROM messages LIMIT 1",
    );
    raw.close();
    const p = probeMessagesFts(open(path));
    expect(p.unindexed).toBe(1);
    expect(p.dangling).toBe(10);
    expect(p.messages).toBe(11);
    expect(p.indexedDocs).toBe(20);
  });

  it('works on a readonly handle', async () => {
    const p = probeMessagesFts(open(await makeDb(5), true));
    expect(p.messages).toBe(5);
    expect(p.ftsPresent).toBe(true);
  });

  it('reports ftsPresent=false when the table is missing', async () => {
    const path = await makeDb(5);
    const raw = new DatabaseSync(path);
    raw.exec('DROP TRIGGER messages_ai');
    raw.exec('DROP TRIGGER messages_ad');
    raw.exec('DROP TRIGGER messages_au');
    raw.exec('DROP TABLE messages_fts');
    raw.close();
    expect(probeMessagesFts(open(path))).toEqual({
      messages: 5,
      indexedDocs: 0,
      unindexed: 0,
      dangling: 0,
      ftsPresent: false,
    });
  });
});

describe('deepCheckMessagesFts', () => {
  it('passes on a healthy store', async () => {
    expect(deepCheckMessagesFts(open(await makeDb(20)))).toEqual({ ok: true });
  });

  it('fails on divergence that integrity_check accepts', async () => {
    const path = await makeDb(20);
    diverge(path);
    const db = open(path);
    expect(verdict(db)).toBe('ok');
    const r = deepCheckMessagesFts(db);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/malformed/);
  });

  it('fails on a readonly handle with the write-denied message', async () => {
    const r = deepCheckMessagesFts(open(await makeDb(5), true));
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/readonly database/);
  });
});

describe('rebuildMessagesFts', () => {
  it('repairs blanked shadow blocks', async () => {
    const path = await makeDb(200);
    blankFtsBlocks(path);
    const db = open(path);
    expect(verdict(db)).toMatch(/^fts5:|\nfts5:/);
    rebuildMessagesFts(db);
    expect(verdict(db)).toBe('ok');
    expect(deepCheckMessagesFts(db).ok).toBe(true);
    db.prepare(
      "INSERT INTO messages (id, session_id, role, content, timestamp) SELECT 'again', session_id, 'user', 'x', 't' FROM messages LIMIT 1",
    ).run();
  });

  it('repairs divergence found by deepCheck', async () => {
    const path = await makeDb(20);
    diverge(path);
    const db = open(path);
    expect(deepCheckMessagesFts(db).ok).toBe(false);
    rebuildMessagesFts(db);
    expect(deepCheckMessagesFts(db)).toEqual({ ok: true });
    expect(probeMessagesFts(db)).toMatchObject({
      messages: 15,
      indexedDocs: 15,
      unindexed: 0,
      dangling: 0,
    });
  });

  it('is idempotent', async () => {
    const db = open(await makeDb(20));
    rebuildMessagesFts(db);
    rebuildMessagesFts(db);
    expect(verdict(db)).toBe('ok');
    expect(probeMessagesFts(db).indexedDocs).toBe(20);
  });
});

describe('classifyIntegrity', () => {
  it('classifies a healthy store as ok', async () => {
    const db = open(await makeDb(20));
    expect(classifyIntegrity(verdict(db), db)).toBe('ok');
  });

  it('classifies blanked FTS blocks as fts', async () => {
    const path = await makeDb(200);
    blankFtsBlocks(path);
    const db = open(path);
    expect(classifyIntegrity(verdict(db), db)).toBe('fts');
  });

  it('classifies a smashed index leaf as index, and REINDEX repairs it', async () => {
    const path = await makeDb(5000);
    smashLeaf(path, 'idx_messages_session', 0x00, 20);
    const db = open(path);
    const v = verdict(db);
    expect(v).toMatch(/^Tree \d+ page \d+ cell/m);
    expect(classifyIntegrity(v, db)).toBe('index');
    db.exec('REINDEX');
    expect(verdict(db)).toBe('ok');
  });

  it('classifies a smashed table leaf as heap, even with index lines mixed in', async () => {
    const path = await makeDb(5000);
    smashLeaf(path, 'messages', 0x00, 200, 300);
    const db = open(path);
    const v = verdict(db);
    expect(v).toMatch(/missing from index/);
    expect(classifyIntegrity(v, db)).toBe('heap');
  });

  it('classifies unrecognised text as unknown', async () => {
    const db = open(await makeDb(5));
    expect(classifyIntegrity('database disk image is malformed', db)).toBe('unknown');
    expect(classifyIntegrity('', db)).toBe('unknown');
  });

  it('classifies index message shapes without a Tree line', async () => {
    const db = open(await makeDb(5));
    expect(classifyIntegrity('row 3 missing from index idx_messages_session', db)).toBe('index');
    expect(classifyIntegrity('wrong # of entries in index idx_messages_session', db)).toBe('index');
  });
});
