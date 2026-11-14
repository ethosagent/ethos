// Pins sessions-repair/repair.ts and gate.ts (plan session-db-repair 5.6, 6.3).
// Databases are built with SQLiteSessionStore (production schema), closed, then
// damaged through node:sqlite directly: the @ethosagent/sqlite shim has no
// enableDefensive, and FTS5 shadow tables are protected until it is off.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EthosError } from '@ethosagent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyPath, enumerateBackupEntries } from '../../backup/scopes';
import { acquireDatabaseLockGate, DatabaseInUseError } from '../gate';
import { diagnoseSessionsDb, repairSessionsDb } from '../repair';
import {
  blankFtsBlocks,
  dirs,
  diverge,
  divergeTokens,
  holdReader,
  makeDataDir,
  ROOMY,
  rawSql,
  smashLeaf,
  stat,
  tryOpenFromWorker,
  verdict,
  workers,
} from './repair-helpers';

afterEach(async () => {
  for (const w of workers.splice(0)) await w.terminate();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
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
