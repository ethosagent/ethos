// Pins sessions-repair/repair.ts and gate.ts (plan session-db-repair 5.6, 6.3).
// Databases are built with SQLiteSessionStore (production schema), closed, then
// damaged through node:sqlite directly: the @ethosagent/sqlite shim has no
// enableDefensive, and FTS5 shadow tables are protected until it is off.

import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import Database from '@ethosagent/sqlite';
import { EthosError } from '@ethosagent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyPath, enumerateBackupEntries } from '../../backup/scopes';
import { acquireDatabaseLockGate, DatabaseInUseError } from '../gate';
import { diagnoseSessionsDb, repairSessionsDb } from '../repair';

const dirs: string[] = [];
const workers: Worker[] = [];

afterEach(async () => {
  for (const w of workers.splice(0)) await w.terminate();
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

/** A data dir holding a closed, checkpointed sessions.db with `rows` messages. */
/**
 * `indexShape` writes short non-ISO timestamps: the index-damage constructions only
 * surface as `Tree N ...` lines (rather than a thrown "malformed") with that key
 * shape. Those rows are NOT valid timestamps, so row-scan assertions never use it.
 */
async function makeDataDir(rows = 20, indexShape = false): Promise<{ dir: string; db: string }> {
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

function rawSql<T>(db: string, fn: (d: DatabaseSync) => T): T {
  const d = new DatabaseSync(db);
  try {
    d.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return fn(d);
  } finally {
    d.close();
  }
}

function blankFtsBlocks(db: string): void {
  rawSql(db, (d) => {
    // @types/node does not declare enableDefensive; the Node 24 runtime does.
    (d as unknown as { enableDefensive(on: boolean): void }).enableDefensive(false);
    d.exec("UPDATE messages_fts_data SET block = x'00' WHERE id > 10");
  });
}

/** Row-set divergence: integrity_check accepts it, the docsize probe sees it. */
function diverge(db: string): void {
  rawSql(db, (d) => {
    d.exec('DROP TRIGGER messages_ad');
    d.exec('DELETE FROM messages WHERE rowid <= 5');
  });
}

/** Token-level divergence only the rank=1 check sees: same row set, stale tokens. */
function divergeTokens(db: string): void {
  rawSql(db, (d) => {
    d.exec('DROP TRIGGER messages_au');
    d.exec("UPDATE messages SET content = 'completely different words here' WHERE rowid <= 5");
  });
}

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

function verdict(path: string): string {
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
async function holdReader(db: string): Promise<{ release: () => Promise<void> }> {
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
function tryOpenFromWorker(db: string): Promise<string | null> {
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

const stat = (p: string) => {
  const s = statSync(p);
  return { bytes: readFileSync(p).toString('base64'), mtimeMs: s.mtimeMs };
};

const ROOMY = () => ({ bavail: 1e12, bsize: 1 });

describe('diagnoseSessionsDb', () => {
  it('check mode writes nothing (mtime and bytes unchanged)', async () => {
    const { dir, db } = await makeDataDir();
    blankFtsBlocks(db);
    const before = stat(db);
    const report = await diagnoseSessionsDb(dir, { deep: true });
    expect(report.classification).toBe('fts');
    expect(report.applied).toBeNull();
    expect(stat(db)).toEqual(before);
    expect(existsSync(join(dir, '.pre-repair'))).toBe(false);
  });

  it('a healthy file reports ok with the documented shape', async () => {
    const { dir } = await makeDataDir(20);
    const r = await diagnoseSessionsDb(dir);
    expect(r).toMatchObject({
      ok: true,
      database: 'sessions.db',
      exists: true,
      classification: 'ok',
      integrity: { ok: true },
      fts: { messages: 20, indexedDocs: 20, unindexed: 0, dangling: 0, deep: null },
      plan: [],
      applied: null,
    });
    expect(r.rows).toMatchObject({
      badMetadata: 0,
      badToolCalls: 0,
      badContentBlocks: 0,
      badTimestamps: 0,
    });
  });

  it('a missing file reports exists:false without creating it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sessions-repair-'));
    dirs.push(dir);
    const r = await diagnoseSessionsDb(dir);
    expect(r).toMatchObject({ ok: true, exists: false });
    expect(existsSync(join(dir, 'sessions.db'))).toBe(false);
  });

  it('fts-damaged file is classified fts and the plan is rebuild_fts', async () => {
    const { dir, db } = await makeDataDir(200);
    blankFtsBlocks(db);
    const r = await diagnoseSessionsDb(dir);
    expect(r).toMatchObject({ ok: false, classification: 'fts', plan: ['rebuild_fts'] });
    expect(r.integrity.detail).toMatch(/fts5/);
  });

  it('index-corrupted file is classified index with a reindex plan', async () => {
    const { dir, db } = await makeDataDir(5000, true);
    smashLeaf(db, 'idx_messages_session', 0x00, 20);
    const r = await diagnoseSessionsDb(dir);
    expect(r.classification).toBe('index');
    expect(r.plan).toEqual(['reindex']);
  });

  it('heap-corrupted file is classified heap with an empty plan', async () => {
    const { dir, db } = await makeDataDir(5000);
    smashLeaf(db, 'messages', 0x00, 200, 300);
    const r = await diagnoseSessionsDb(dir);
    expect(r.classification).toBe('heap');
    expect(r.plan).toEqual([]);
  });

  it('deep finds divergence the shallow check accepts', async () => {
    const { dir, db } = await makeDataDir(20);
    divergeTokens(db);
    const shallow = await diagnoseSessionsDb(dir);
    expect(shallow.classification).toBe('ok');
    expect(shallow.integrity.ok).toBe(true);
    const deep = await diagnoseSessionsDb(dir, { deep: true });
    expect(deep.fts.deep?.ok).toBe(false);
    expect(deep.classification).toBe('fts');
    expect(deep.plan).toEqual(['rebuild_fts']);
  });

  it('deep leaves the live file untouched and deletes its copy', async () => {
    const { dir, db } = await makeDataDir(20);
    const tmpBefore = readdirSync(tmpdir()).filter((n) => n.startsWith('ethos-sessions-deep-'));
    const before = stat(db);
    const r = await diagnoseSessionsDb(dir, { deep: true });
    expect(r.fts.deep).toEqual({ ok: true });
    expect(stat(db)).toEqual(before);
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith('ethos-sessions-deep-'))).toEqual(
      tmpBefore,
    );
  });

  it('a failed deep-check copy is not FTS damage', async () => {
    const { dir } = await makeDataDir(20);
    const r = await diagnoseSessionsDb(dir, {
      deep: true,
      statfs: ROOMY,
      copyDb: async () => {
        throw new Error('ENOSPC: no space left on device');
      },
    });
    expect(r.classification).toBe('ok');
    expect(r.plan).toEqual([]);
    expect(r.fts.deep).toBeNull();
    expect(r.warnings.join('\n')).toContain('deep check could not run');
    expect(r.ok).toBe(true);
  });

  it('check mode on a WAL file in a read-only directory reports instead of throwing', async () => {
    const { db } = await makeDataDir(5);
    // A hot -wal with no -shm, in a directory SQLite cannot create the -shm in.
    const w = new DatabaseSync(db);
    w.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
    w.exec(
      "INSERT INTO sessions (id,key,platform,model,provider,working_dir,created_at,updated_at) VALUES ('s2','k2','cli','m','p','/', '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",
    );
    const ro = mkdtempSync(join(tmpdir(), 'sessions-repair-ro-'));
    dirs.push(ro);
    copyFileSync(db, join(ro, 'sessions.db'));
    copyFileSync(`${db}-wal`, join(ro, 'sessions.db-wal'));
    w.close();
    chmodSync(ro, 0o555);
    try {
      const r = await diagnoseSessionsDb(ro);
      expect(r.exists).toBe(true);
      // The readonly open succeeds lazily; the first read fails with CANTOPEN and
      // integrityVerdict turns it into a report (observed: "unable to open database file").
      expect(r.classification).toBe('unknown');
      expect(r.integrity.ok).toBe(false);
      expect(r.integrity.detail).toBeTruthy();
    } finally {
      chmodSync(ro, 0o755);
    }
  });

  it('deep refuses with too little free space in the temp dir', async () => {
    const { dir } = await makeDataDir(20);
    await expect(
      diagnoseSessionsDb(dir, { deep: true, statfs: () => ({ bavail: 0, bsize: 4096 }) }),
    ).rejects.toBeInstanceOf(EthosError);
  });
});

describe('row scan', () => {
  it('counts bad JSON columns and timestamps and lists the first ids', async () => {
    const { dir, db } = await makeDataDir(12);
    const sid = rawSql(
      db,
      (d) => (d.prepare('SELECT id FROM sessions').get() as { id: string }).id,
    );
    rawSql(db, (d) => {
      d.prepare('UPDATE sessions SET metadata = ? WHERE id = ?').run('{bad', sid);
      d.prepare("UPDATE messages SET tool_calls = '[oops' WHERE id IN ('m0','m1')").run();
      d.prepare("UPDATE messages SET content_blocks = 'nope' WHERE id = 'm2'").run();
      d.prepare("UPDATE messages SET timestamp = 'garbage' WHERE id IN ('m3','m4','m5')").run();
      d.prepare("UPDATE sessions SET updated_at = 'garbage' WHERE id = ?").run(sid);
    });
    const r = await diagnoseSessionsDb(dir);
    expect(r.rows).toMatchObject({
      badMetadata: 1,
      badToolCalls: 2,
      badContentBlocks: 1,
      badTimestamps: 4,
    });
    expect(r.rows.sampleIds.metadata).toEqual([sid]);
    expect(r.rows.sampleIds.toolCalls.sort()).toEqual(['m0', 'm1']);
    expect(r.rows.sampleIds.timestamps).toContain(`sessions:${sid}`);
    expect(r.rows.sampleIds.timestamps).toContain('messages:m3');
    // bad rows are findings but not an integrity class, and nothing is planned (D11)
    expect(r).toMatchObject({ ok: false, classification: 'ok', plan: [] });
  });

  it('caps the sampled ids at 10', async () => {
    const { dir, db } = await makeDataDir(30);
    rawSql(db, (d) => d.exec("UPDATE messages SET tool_calls = '[oops'"));
    const r = await diagnoseSessionsDb(dir);
    expect(r.rows.badToolCalls).toBe(30);
    expect(r.rows.sampleIds.toolCalls).toHaveLength(10);
  });

  it('NULL columns are not bad rows', async () => {
    const { dir } = await makeDataDir(5);
    expect((await diagnoseSessionsDb(dir)).rows.badToolCalls).toBe(0);
  });
});

describe('repairSessionsDb', () => {
  it('fts-damaged file is classified fts and apply rebuilds it, verified true', async () => {
    const { dir, db } = await makeDataDir(200);
    blankFtsBlocks(db);
    const r = await repairSessionsDb(dir, { statfs: ROOMY });
    expect(r.classification).toBe('fts');
    expect(r.applied).toMatchObject({ actions: ['rebuild_fts'], verified: true });
    expect(r.ok).toBe(true);
    expect(verdict(db)).toBe('ok');
    const after = await diagnoseSessionsDb(dir, { deep: true });
    expect(after.fts.deep).toEqual({ ok: true });
    expect(after.fts.indexedDocs).toBe(200);
  });

  it('apply repairs the divergence case the shallow integrity check accepts', async () => {
    const { dir, db } = await makeDataDir(20);
    divergeTokens(db);
    const r = await repairSessionsDb(dir, { deep: true, statfs: ROOMY });
    expect(r.applied).toMatchObject({ actions: ['rebuild_fts'], verified: true });
    expect((await diagnoseSessionsDb(dir, { deep: true })).fts.deep).toEqual({ ok: true });
  });

  it('apply repairs row-set drift', async () => {
    const { dir, db } = await makeDataDir(20);
    diverge(db);
    const r = await repairSessionsDb(dir, { statfs: ROOMY });
    expect(r.applied).toMatchObject({ actions: ['rebuild_fts'], verified: true });
    expect(r.fts).toMatchObject({ dangling: 5 }); // findings are the pre-repair state
    expect(await diagnoseSessionsDb(dir)).toMatchObject({
      ok: true,
      fts: { dangling: 0, indexedDocs: 15 },
    });
  });

  it('index-corrupted file is classified index and REINDEX verifies', async () => {
    const { dir, db } = await makeDataDir(5000, true);
    smashLeaf(db, 'idx_messages_session', 0x00, 20);
    const r = await repairSessionsDb(dir, { statfs: ROOMY });
    expect(r.classification).toBe('index');
    expect(r.applied).toMatchObject({ actions: ['reindex'], verified: true });
    expect(verdict(db)).toBe('ok');
    expect(
      rawSql(db, (d) => (d.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }).n),
    ).toBe(5000);
  });

  it('heap-corrupted file is classified heap and apply does nothing', async () => {
    const { dir, db } = await makeDataDir(5000);
    smashLeaf(db, 'messages', 0x00, 200, 300);
    const before = stat(db);
    const r = await repairSessionsDb(dir, { statfs: ROOMY });
    expect(r.classification).toBe('heap');
    expect(r.ok).toBe(false);
    expect(r.applied).toMatchObject({
      actions: [],
      copy: null,
      verified: false,
      unrepairable: true,
    });
    expect(stat(db)).toEqual(before);
    expect(existsSync(join(dir, '.pre-repair'))).toBe(false);
  });

  it('apply on a healthy file changes nothing and takes no copy', async () => {
    const { dir, db } = await makeDataDir(20);
    const before = stat(db);
    const r = await repairSessionsDb(dir, { statfs: ROOMY });
    expect(r.applied).toMatchObject({ actions: [], copy: null, verified: true });
    expect(stat(db)).toEqual(before);
    expect(existsSync(join(dir, '.pre-repair'))).toBe(false);
  });

  it('apply refuses when a peer connection is open', async () => {
    const { dir, db } = await makeDataDir(200);
    blankFtsBlocks(db);
    const before = stat(db);
    const peer = await holdReader(db);
    let err: unknown;
    try {
      await repairSessionsDb(dir, {
        statfs: ROOMY,
        describeHolders: async () => ['processes with sessions.db open: node (pid 5150)'],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EthosError);
    const e = err as EthosError;
    expect(e.code).toBe('DB_BUSY');
    expect(e.action).toContain('pid 5150');
    expect(e.action).toContain('ethos run-all');
    expect(e.details).toMatchObject({
      holders: ['processes with sessions.db open: node (pid 5150)'],
    });
    expect(existsSync(join(dir, '.pre-repair'))).toBe(false);
    await peer.release();
    expect(stat(db)).toEqual(before);
  });

  it('apply reuses the prior row scan and deep check', async () => {
    const { dir, db } = await makeDataDir(20);
    blankFtsBlocks(db);
    const sentinelRows = {
      badMetadata: 7,
      badToolCalls: 0,
      badContentBlocks: 0,
      badTimestamps: 0,
      sampleIds: { metadata: ['sentinel'], toolCalls: [], contentBlocks: [], timestamps: [] },
    };
    const copyDb = vi.fn(async () => undefined);
    const r = await repairSessionsDb(dir, {
      deep: true,
      statfs: ROOMY,
      copyDb,
      prior: { rows: sentinelRows, deep: { ok: false, detail: 'prior' } },
    });
    // The sentinel scan comes back verbatim (not rescanned) and no second deep copy ran.
    expect(r.rows).toEqual(sentinelRows);
    expect(r.fts.deep).toEqual({ ok: false, detail: 'prior' });
    expect(copyDb).not.toHaveBeenCalled();
    expect(r.applied?.verified).toBe(true);
  });

  it('a garbage (non-sqlite) sessions.db is DB_CORRUPT, not DB_BUSY', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sessions-repair-garbage-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'sessions.db'), Buffer.alloc(8192, 0x41));
    const err = await repairSessionsDb(dir, { statfs: ROOMY }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EthosError);
    expect((err as EthosError).code).not.toBe('DB_BUSY');
    expect((err as EthosError).code).toBe('DB_CORRUPT');
  });

  it('a throwing describeHolders does not mask DB_BUSY', async () => {
    const { dir, db } = await makeDataDir(20);
    const peer = await holdReader(db);
    await expect(
      repairSessionsDb(dir, {
        describeHolders: async () => {
          throw new Error('lsof exploded');
        },
      }),
    ).rejects.toMatchObject({ code: 'DB_BUSY' });
    await peer.release();
  });

  it('apply takes a verbatim pre-repair copy before changing anything', async () => {
    const { dir, db } = await makeDataDir(200);
    blankFtsBlocks(db);
    const r = await repairSessionsDb(dir, { statfs: ROOMY });
    const copy = r.applied?.copy;
    expect(copy).toBeTruthy();
    expect(copy?.startsWith(join(dir, '.pre-repair'))).toBe(true);
    // the copy keeps the damage: it is a faithful rollback point, not a repaired file
    expect(verdict(copy as string)).toMatch(/fts5/);
    expect(verdict(db)).toBe('ok');
    expect(
      rawSql(
        copy as string,
        (d) => (d.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }).n,
      ),
    ).toBe(200);
  });

  it('apply refuses with too little free space', async () => {
    const { dir, db } = await makeDataDir(200);
    blankFtsBlocks(db);
    const before = stat(db);
    await expect(
      repairSessionsDb(dir, { statfs: () => ({ bavail: 1, bsize: 4096 }) }),
    ).rejects.toMatchObject({ code: 'INTERNAL', cause: expect.stringContaining('free space') });
    expect(stat(db)).toEqual(before);
    expect(existsSync(join(dir, '.pre-repair'))).toBe(false);
  });

  it('a statfs that throws fails open with a warning', async () => {
    const { dir, db } = await makeDataDir(200);
    blankFtsBlocks(db);
    const r = await repairSessionsDb(dir, {
      statfs: () => {
        throw new Error('ENOSYS');
      },
    });
    expect(r.applied?.verified).toBe(true);
    expect(r.warnings.join('\n')).toMatch(/free-space check could not run: ENOSYS/);
  });

  it('a newer user_version is refused', async () => {
    const { dir, db } = await makeDataDir(20);
    rawSql(db, (d) => d.exec('PRAGMA user_version = 99'));
    const before = stat(db);
    await expect(repairSessionsDb(dir, { statfs: ROOMY })).rejects.toMatchObject({
      code: 'IMPORT_NEWER_SCHEMA',
    });
    expect(stat(db)).toEqual(before);
  });

  it('a late opener is refused while apply runs', async () => {
    const { dir, db } = await makeDataDir(200);
    blankFtsBlocks(db);
    const openerErrors: (string | null)[] = [];
    const r = await repairSessionsDb(dir, {
      statfs: ROOMY,
      onProgress: async (stage) => {
        if (stage === 'gate-acquired' || stage === 'pre-repair-copy') {
          openerErrors.push(await tryOpenFromWorker(db));
        }
      },
    });
    expect(r.applied?.verified).toBe(true);
    expect(openerErrors).toHaveLength(2);
    for (const e of openerErrors) expect(e).toMatch(/locked/);
    // once apply returns, the gate is released and the file opens again
    expect(await tryOpenFromWorker(db)).toBeNull();
  });
});

describe('acquireDatabaseLockGate', () => {
  it('returns null for an absent file, a handle that holds the lock, and a typed error when contended', async () => {
    const { dir, db } = await makeDataDir(5);
    expect(acquireDatabaseLockGate(join(dir, 'nope.db'))).toBeNull();
    const gate = acquireDatabaseLockGate(db);
    expect(gate).not.toBeNull();
    try {
      expect(() => acquireDatabaseLockGate(db)).toThrow(DatabaseInUseError);
    } finally {
      gate?.close();
    }
    const again = acquireDatabaseLockGate(db);
    expect(again).not.toBeNull();
    again?.close();
  });
});

describe('.pre-repair', () => {
  it('.pre-repair is not classified into any backup scope', async () => {
    expect(classifyPath('.pre-repair/2026-10-18T09-14-00-000Z-abc123/sessions.db')).toEqual({
      scope: null,
      unclassifiedDatabase: false,
    });
    // end to end: a real pre-repair copy is invisible to the backup walk
    const { dir, db } = await makeDataDir(200);
    blankFtsBlocks(db);
    await repairSessionsDb(dir, { statfs: ROOMY });
    expect(existsSync(join(dir, '.pre-repair'))).toBe(true);
    const walked = enumerateBackupEntries(dir, ['identity', 'state', 'telemetry']);
    expect(walked.entries.map((e) => e.path).filter((p) => p.includes('.pre-repair'))).toEqual([]);
    expect(walked.unclassifiedDatabases).toEqual([]);
  });
});
