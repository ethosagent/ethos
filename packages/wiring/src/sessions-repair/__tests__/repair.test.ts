// Pins sessions-repair/repair.ts and gate.ts (plan session-db-repair 5.6, 6.3).
// Databases are built with SQLiteSessionStore (production schema), closed, then
// damaged through node:sqlite directly: the @ethosagent/sqlite shim has no
// enableDefensive, and FTS5 shadow tables are protected until it is off.

import { chmodSync, copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EthosError } from '@ethosagent/types';
import { afterEach, describe, expect, it } from 'vitest';
import { diagnoseSessionsDb } from '../repair';
import {
  blankFtsBlocks,
  dirs,
  divergeTokens,
  makeDataDir,
  ROOMY,
  rawSql,
  smashLeaf,
  stat,
  workers,
} from './repair-helpers';

afterEach(async () => {
  for (const w of workers.splice(0)) await w.terminate();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

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
