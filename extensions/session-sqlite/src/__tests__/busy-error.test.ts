// Plan session-db-repair Part D: a write that outlasts busy_timeout is named
// (`DB_BUSY`, path, errcode, holders), not left as a bare SqliteError.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isEthosError } from '@ethosagent/types';
import { afterEach, describe, expect, it } from 'vitest';
import { isSqliteBusy, SQLiteSessionStore, type SQLiteSessionStoreOptions } from '../index';
import { holdWriteLock } from './hold-write-lock';

const baseSession = {
  key: 'cli:busy',
  platform: 'cli',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  workingDir: '/tmp',
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    estimatedCostUsd: 0,
    apiCallCount: 0,
    compactionCount: 0,
  },
};

describe('SQLiteSessionStore DB_BUSY translation', () => {
  const dirs: string[] = [];
  const stores: SQLiteSessionStore[] = [];

  afterEach(() => {
    for (const s of stores.splice(0)) s.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function setup(opts?: SQLiteSessionStoreOptions) {
    const dir = mkdtempSync(join(tmpdir(), 'session-sqlite-dbbusy-'));
    dirs.push(dir);
    const dbPath = join(dir, 'sessions.db');
    const store = new SQLiteSessionStore(dbPath, opts);
    stores.push(store);
    // Same own-handle cast the posture tests use: shrink the wait for the test.
    (store as unknown as { db: { pragma(s: string): unknown } }).db.pragma('busy_timeout = 50');
    const session = await store.createSession(baseSession);
    return { dbPath, store, session };
  }

  async function caught(p: Promise<unknown>): Promise<unknown> {
    try {
      await p;
    } catch (err) {
      return err;
    }
    throw new Error('expected the call to reject');
  }

  it('appendMessage throws DB_BUSY with the path and errcode 5 after the timeout', async () => {
    const { dbPath, store, session } = await setup();
    const holder = await holdWriteLock(dbPath, 1500);
    const err = await caught(
      store.appendMessage({ sessionId: session.id, role: 'user', content: 'x' }),
    );
    await holder.terminate();
    expect(isEthosError(err)).toBe(true);
    const e = err as {
      code: string;
      details: { path: string; errcode: number; holders: string[] };
    };
    expect(e.code).toBe('DB_BUSY');
    expect(e.details.path).toBe(dbPath);
    expect(e.details.errcode).toBe(5);
    // The handle's real busy_timeout (50 ms here), not a hardcoded 5 s.
    expect(
      (e as unknown as { details: { waitedMs: number }; cause: string }).details.waitedMs,
    ).toBe(50);
    expect((e as unknown as { cause: string }).cause).toContain('waited 0.05s');
    expect(e.details.holders).toEqual([]);
  }, 30_000);

  it('describeHolders output appears in details.holders', async () => {
    const { dbPath, store, session } = await setup({
      describeHolders: async () => ['ethos gateway start (pid 4242)'],
    });
    const holder = await holdWriteLock(dbPath, 1500);
    const err = await caught(store.updateUsage(session.id, { inputTokens: 1 }));
    await holder.terminate();
    const e = err as { code: string; action: string; details: { holders: string[] } };
    expect(e.code).toBe('DB_BUSY');
    expect(e.details.holders).toEqual(['ethos gateway start (pid 4242)']);
    expect(e.action).toContain('ethos gateway start (pid 4242)');
  }, 30_000);

  it('a throwing describeHolders does not mask DB_BUSY', async () => {
    const { dbPath, store, session } = await setup({
      describeHolders: async () => {
        throw new Error('lsof exploded');
      },
    });
    const holder = await holdWriteLock(dbPath, 1500);
    const err = await caught(store.recordTurnStart(session.id));
    await holder.terminate();
    expect((err as { code: string }).code).toBe('DB_BUSY');
  }, 30_000);

  it('the constructor throws DB_BUSY when a peer holds the write lock during migrate', async () => {
    const { dbPath, store } = await setup();
    store.close();
    stores.splice(stores.indexOf(store), 1);
    // addColumns() takes BEGIN IMMEDIATE on every open, so a held lock blocks
    // the constructor. No busy_timeout seam: the constructor waits its full 5 s.
    const holder = await holdWriteLock(dbPath, 8000);
    let err: unknown;
    try {
      new SQLiteSessionStore(dbPath);
    } catch (e) {
      err = e;
    }
    await holder.terminate();
    expect(isEthosError(err)).toBe(true);
    const e = err as { code: string; cause: string; details: Record<string, unknown> };
    expect(e.code).toBe('DB_BUSY');
    expect(e.details).toEqual({ path: dbPath, errcode: 5, waitedMs: 5000, holders: [] });
    expect(e.cause).toContain('waited 5s');
  }, 30_000);

  it('non-busy SqliteErrors are not translated', async () => {
    const { store } = await setup();
    // FOREIGN KEY violation: the session id does not exist.
    const err = await caught(
      store.appendMessage({ sessionId: 'no-such-session', role: 'user', content: 'x' }),
    );
    expect(isEthosError(err)).toBe(false);
    expect((err as { errcode?: number }).errcode).toBeDefined();
  });

  it('isSqliteBusy matches 5, 6, 261, 517 and not 11 or 267', () => {
    const e = (errcode: number) => Object.assign(new Error('x'), { errcode });
    for (const code of [5, 6, 261, 517]) expect(isSqliteBusy(e(code))).toBe(true);
    for (const code of [11, 267]) expect(isSqliteBusy(e(code))).toBe(false);
    expect(isSqliteBusy(new Error('database is locked'))).toBe(false);
    expect(isSqliteBusy(null)).toBe(false);
  });
});
