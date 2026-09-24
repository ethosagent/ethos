import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from '@ethosagent/sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INBOUND_SPOOL_SCHEMA_VERSION, type SpoolAccept, SQLiteInboundSpool } from '../index';

function row(overrides: Partial<SpoolAccept> = {}): SpoolAccept {
  return {
    platform: 'telegram',
    botKey: 'bot-a',
    chatId: 'chat-1',
    messageId: 'm-1',
    laneKey: 'telegram:bot-a:chat-1',
    payload: JSON.stringify({ text: 'hello' }),
    ...overrides,
  };
}

describe('SQLiteInboundSpool — accept', () => {
  it('a second accept with the same key returns fresh: false and keeps one row', () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const first = spool.accept(row());
    const second = spool.accept(row({ payload: '{"text":"retry"}' }));
    expect(first.fresh).toBe(true);
    expect(second).toEqual({ id: first.id, fresh: false });
    expect(spool.stats().received).toBe(1);
    // The original payload stands — a platform retry never rewrites a spooled row.
    expect(spool.get(first.id)?.payload).toBe(JSON.stringify({ text: 'hello' }));
  });

  it('normalizes an empty threadId to no thread', () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const { id } = spool.accept(row({ threadId: '' }));
    expect(spool.get(id)?.threadId).toBeUndefined();
  });
});

describe('SQLiteInboundSpool — state transitions', () => {
  let spool: SQLiteInboundSpool;
  beforeEach(() => {
    spool = new SQLiteInboundSpool(':memory:');
  });

  it('received → processing → done, counting one attempt and nulling the payload', () => {
    const { id } = spool.accept(row());
    expect(spool.markProcessing(id, 'p1')).toBe(true);
    expect(spool.get(id)).toMatchObject({ status: 'processing', attempts: 1, claimedBy: 'p1' });
    // Only a `received` row can start.
    expect(spool.markProcessing(id, 'p1')).toBe(false);
    spool.markDone(id);
    expect(spool.get(id)).toMatchObject({ status: 'done', payload: '{}' });
  });

  it('processing → received on a failure under the cap, and → dead on the third', () => {
    const { id } = spool.accept(row());
    spool.markProcessing(id, 'p1');
    expect(spool.markFailed(id, 'boom 1', 3)).toBe('received');
    // The claim is kept, so the same process does not re-list it this boot.
    expect(spool.get(id)).toMatchObject({
      status: 'received',
      claimedBy: 'p1',
      lastError: 'boom 1',
    });
    expect(spool.listReplayable(['bot-a'])).toHaveLength(0);

    spool.recoverOrphans('p2');
    spool.markProcessing(id, 'p2');
    expect(spool.markFailed(id, 'boom 2', 3)).toBe('received');
    spool.recoverOrphans('p3');
    spool.markProcessing(id, 'p3');
    expect(spool.markFailed(id, 'boom 3', 3)).toBe('dead');
    expect(spool.get(id)).toMatchObject({ status: 'dead', attempts: 3, lastError: 'boom 3' });
    expect(spool.listDead().map((r) => r.id)).toEqual([id]);
  });

  it('requeue resets attempts and releases the claim; discard closes the row', () => {
    const a = spool.accept(row({ messageId: 'a' })).id;
    const b = spool.accept(row({ messageId: 'b' })).id;
    for (const id of [a, b]) {
      spool.markProcessing(id, 'p1');
      spool.markFailed(id, 'x', 1);
    }
    expect(spool.requeue(a)).toBe(true);
    expect(spool.get(a)).toMatchObject({ status: 'received', attempts: 0 });
    expect(spool.get(a)?.claimedBy).toBeUndefined();
    expect(spool.discard(b)).toBe(true);
    expect(spool.get(b)).toMatchObject({ status: 'done', lastError: 'discarded', payload: '{}' });
    // Only dead rows move.
    expect(spool.requeue(a)).toBe(false);
    expect(spool.discard(a)).toBe(false);
  });

  it('releaseOnShutdown refunds the attempt and releases the claim', () => {
    const { id } = spool.accept(row());
    spool.markProcessing(id, 'p1');
    spool.releaseOnShutdown(id);
    expect(spool.get(id)).toMatchObject({ status: 'received', attempts: 0 });
    expect(spool.listReplayable(['bot-a']).map((r) => r.id)).toEqual([id]);
  });

  it('markDead only takes an unclaimed received row', () => {
    const a = spool.accept(row({ messageId: 'a' })).id;
    const b = spool.accept(row({ messageId: 'b', claimedBy: 'p1' })).id;
    expect(spool.markDead(a, 'stale')).toBe(true);
    expect(spool.markDead(b, 'stale')).toBe(false);
    expect(spool.get(a)).toMatchObject({ status: 'dead', lastError: 'stale' });
  });
});

// Plan openclaw-9.5-adoption D5: a turn that started a tool is never replayed.
describe('SQLiteInboundSpool — tool started / interrupted', () => {
  let t: number;
  let spool: SQLiteInboundSpool;
  beforeEach(() => {
    t = 1_000;
    spool = new SQLiteInboundSpool(':memory:', { now: () => t });
  });

  it('markToolStarted stamps a processing row once, and nothing else', () => {
    const { id } = spool.accept(row());
    spool.markToolStarted(id);
    expect(spool.get(id)?.toolStartedAt).toBeUndefined();
    spool.markProcessing(id, 'p1');
    spool.markToolStarted(id);
    t = 2_000;
    spool.markToolStarted(id);
    expect(spool.get(id)?.toolStartedAt).toBe(1_000);
  });

  it('markFailed on a tool-started row → interrupted with the claim released; at the cap → dead', () => {
    const a = spool.accept(row({ messageId: 'a' })).id;
    spool.markProcessing(a, 'p1');
    spool.markToolStarted(a);
    expect(spool.markFailed(a, 'boom', 3)).toBe('interrupted');
    expect(spool.get(a)).toMatchObject({ status: 'interrupted', lastError: 'boom' });
    expect(spool.get(a)?.claimedBy).toBeUndefined();
    expect(spool.listReplayable(['bot-a'])).toHaveLength(0);

    const b = spool.accept(row({ messageId: 'b' })).id;
    spool.markProcessing(b, 'p1');
    spool.markToolStarted(b);
    expect(spool.markFailed(b, 'boom', 1)).toBe('dead');
  });

  it('markInterrupted, findInterrupted inside the window, listInterrupted and stats', () => {
    const { id } = spool.accept(row());
    spool.markProcessing(id, 'p1');
    expect(spool.markInterrupted(id, 'shutdown')).toBe(true);
    expect(spool.markInterrupted(id, 'again')).toBe(false);
    expect(spool.findInterrupted('telegram:bot-a:chat-1', 500)?.id).toBe(id);
    expect(spool.findInterrupted('telegram:bot-a:chat-1', 1_001)).toBeNull();
    expect(spool.findInterrupted('telegram:bot-a:other', 0)).toBeNull();
    expect(spool.listInterrupted().map((r) => r.id)).toEqual([id]);
    expect(spool.stats()).toMatchObject({ interrupted: 1, processing: 0 });
  });

  it('retryInterrupted closes the row and spools its payload fresh, exactly once', () => {
    const { id } = spool.accept(row({ payload: '{"text":"pay the invoice"}' }));
    spool.markProcessing(id, 'p1');
    spool.markToolStarted(id);
    spool.markInterrupted(id, 'crash');
    const fresh = spool.retryInterrupted(id, 'p2');
    expect(fresh).toBeTypeOf('string');
    expect(spool.get(id)).toMatchObject({ status: 'done', payload: '{}', lastError: 'retried' });
    const next = spool.get(fresh ?? '');
    expect(next).toMatchObject({
      status: 'received',
      attempts: 0,
      claimedBy: 'p2',
      laneKey: 'telegram:bot-a:chat-1',
      messageId: `retry:${id}`,
      payload: '{"text":"pay the invoice"}',
    });
    expect(next?.toolStartedAt).toBeUndefined();
    expect(spool.retryInterrupted(id, 'p3')).toBeNull();
  });

  it('requeue and discard take an interrupted row; requeue clears the tool start', () => {
    const a = spool.accept(row({ messageId: 'a' })).id;
    const b = spool.accept(row({ messageId: 'b' })).id;
    for (const id of [a, b]) {
      spool.markProcessing(id, 'p1');
      spool.markToolStarted(id);
      spool.markInterrupted(id, 'crash');
    }
    expect(spool.requeue(a)).toBe(true);
    expect(spool.get(a)).toMatchObject({ status: 'received', attempts: 0 });
    expect(spool.get(a)?.toolStartedAt).toBeUndefined();
    expect(spool.discard(b)).toBe(true);
    expect(spool.get(b)).toMatchObject({ status: 'done', lastError: 'discarded' });
  });

  it('pruneDead removes interrupted rows past the cutoff too', () => {
    const { id } = spool.accept(row());
    spool.markInterrupted(id, 'crash');
    t = 9_000;
    expect(spool.pruneDead(5_000)).toBe(1);
    expect(spool.get(id)).toBeNull();
  });

  it('accept records the kind and the reviewed job', () => {
    const { id } = spool.accept(
      row({ messageId: 'wake:job-1', kind: 'wake_review', reviewJobId: 'job-1' }),
    );
    expect(spool.get(id)).toMatchObject({ kind: 'wake_review', reviewJobId: 'job-1' });
    expect(spool.get(spool.accept(row({ messageId: 'plain' })).id)?.kind).toBe('inbound');
  });
});

describe('SQLiteInboundSpool — listReplayable', () => {
  it('filters by botKey and orders by lane, received_at, then rowid', () => {
    // A frozen clock: every row shares one received_at, so only the rowid
    // tie-break can keep insertion order (CLAUDE.md, same-timestamp inserts).
    const spool = new SQLiteInboundSpool(':memory:', { now: () => 1_000 });
    spool.accept(row({ messageId: 'b1', laneKey: 'lane-b' }));
    spool.accept(row({ messageId: 'a1', laneKey: 'lane-a' }));
    spool.accept(row({ messageId: 'b2', laneKey: 'lane-b' }));
    spool.accept(row({ messageId: 'a2', laneKey: 'lane-a' }));
    spool.accept(row({ messageId: 'c1', laneKey: 'lane-c', botKey: 'bot-c' }));
    spool.accept(row({ messageId: 'a3', laneKey: 'lane-a' }));

    expect(spool.listReplayable(['bot-a']).map((r) => r.messageId)).toEqual([
      'a1',
      'a2',
      'a3',
      'b1',
      'b2',
    ]);
    expect(spool.listReplayable([])).toEqual([]);
    expect(spool.listOrphaned(['bot-a']).map((r) => r.messageId)).toEqual(['c1']);
  });

  it('orders by received_at before rowid within a lane', () => {
    let t = 2_000;
    const spool = new SQLiteInboundSpool(':memory:', { now: () => t });
    spool.accept(row({ messageId: 'late' }));
    t = 1_000;
    spool.accept(row({ messageId: 'early' }));
    expect(spool.listReplayable(['bot-a']).map((r) => r.messageId)).toEqual(['early', 'late']);
  });

  it('excludes claimed rows', () => {
    const spool = new SQLiteInboundSpool(':memory:');
    spool.accept(row({ messageId: 'mine', claimedBy: 'p1' }));
    spool.accept(row({ messageId: 'free' }));
    expect(spool.listReplayable(['bot-a']).map((r) => r.messageId)).toEqual(['free']);
  });
});

describe('SQLiteInboundSpool — on disk', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'inbound-spool-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('claim is exclusive across two store instances on one file', () => {
    const path = join(dir, 'nested', 'inbound-spool.db');
    const one = new SQLiteInboundSpool(path);
    const two = new SQLiteInboundSpool(path);
    try {
      const { id } = one.accept(row());
      expect(one.claim(id, 'p1')).toBe(true);
      expect(two.claim(id, 'p2')).toBe(false);
      expect(two.get(id)?.claimedBy).toBe('p1');
    } finally {
      one.close();
      two.close();
    }
  });

  it('migrates a v1 file to the current schema: rows kept, read as inbound with no tool start', () => {
    const path = join(dir, 'inbound-spool.db');
    const v1 = new Database(path);
    v1.exec(`CREATE TABLE inbound_spool (
      id TEXT PRIMARY KEY, platform TEXT NOT NULL, bot_key TEXT NOT NULL, chat_id TEXT NOT NULL,
      thread_id TEXT, message_id TEXT NOT NULL, lane_key TEXT NOT NULL, payload TEXT NOT NULL,
      status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      received_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, claimed_by TEXT,
      UNIQUE (platform, bot_key, chat_id, message_id)) STRICT`);
    v1.prepare(
      `INSERT INTO inbound_spool VALUES ('old', 'telegram', 'bot-a', 'chat-1', NULL, 'm-old',
       'telegram:bot-a:chat-1', '{"text":"hi"}', 'received', 0, NULL, 1, 1, NULL)`,
    ).run();
    v1.pragma('user_version = 1');
    v1.close();

    const spool = new SQLiteInboundSpool(path);
    try {
      expect(spool.get('old')).toMatchObject({ status: 'received', kind: 'inbound' });
      expect(spool.get('old')?.toolStartedAt).toBeUndefined();
      const version = (
        spool as unknown as { db: { pragma(s: string): Array<{ user_version: number }> } }
      ).db.pragma('user_version');
      expect(version[0]?.user_version).toBe(INBOUND_SPOOL_SCHEMA_VERSION);
      // The v2 columns are writable on the migrated table.
      spool.markProcessing('old', 'p1');
      spool.markToolStarted('old');
      expect(spool.get('old')?.toolStartedAt).toBeTypeOf('number');
    } finally {
      spool.close();
    }
  });

  it('migrates a v2 file to v3: rows kept unlinked, absorbed_into writable', () => {
    const path = join(dir, 'inbound-spool.db');
    const v2 = new Database(path);
    v2.exec(`CREATE TABLE inbound_spool (
      id TEXT PRIMARY KEY, platform TEXT NOT NULL, bot_key TEXT NOT NULL, chat_id TEXT NOT NULL,
      thread_id TEXT, message_id TEXT NOT NULL, lane_key TEXT NOT NULL, payload TEXT NOT NULL,
      status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      received_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, claimed_by TEXT,
      tool_started_at INTEGER, kind TEXT NOT NULL DEFAULT 'inbound', review_job_id TEXT,
      UNIQUE (platform, bot_key, chat_id, message_id)) STRICT`);
    v2.prepare(
      `INSERT INTO inbound_spool (id, platform, bot_key, chat_id, message_id, lane_key, payload,
       status, received_at, updated_at)
       VALUES ('p', 'telegram', 'bot-a', 'chat-1', 'm-p', 'telegram:bot-a:chat-1',
       '{"text":"hi"}', 'processing', 1, 1),
       ('s', 'telegram', 'bot-a', 'chat-1', 'm-s', 'telegram:bot-a:chat-1',
       '{"text":"steer"}', 'received', 2, 2)`,
    ).run();
    v2.pragma('user_version = 2');
    v2.close();

    const spool = new SQLiteInboundSpool(path);
    try {
      expect(spool.get('s')?.absorbedInto).toBeUndefined();
      const version = (
        spool as unknown as { db: { pragma(s: string): Array<{ user_version: number }> } }
      ).db.pragma('user_version');
      expect(version[0]?.user_version).toBe(3);
      expect(spool.markAbsorbed('s', 'p')).toBe(true);
      expect(spool.get('s')?.absorbedInto).toBe('p');
    } finally {
      spool.close();
    }
  });

  it('survives reopening (idempotent migration)', () => {
    const path = join(dir, 'inbound-spool.db');
    const first = new SQLiteInboundSpool(path);
    const { id } = first.accept(row());
    first.close();
    const second = new SQLiteInboundSpool(path);
    try {
      expect(second.get(id)?.status).toBe('received');
    } finally {
      second.close();
    }
  });
});

describe('SQLiteInboundSpool — recoverOrphans', () => {
  it('moves only processing rows (and foreign claims), never done or dead', () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const processing = spool.accept(row({ messageId: 'p' })).id;
    spool.markProcessing(processing, 'dead-process');
    const done = spool.accept(row({ messageId: 'd' })).id;
    spool.markDone(done);
    const dead = spool.accept(row({ messageId: 'x' })).id;
    spool.markProcessing(dead, 'dead-process');
    spool.markFailed(dead, 'poison', 1);
    const foreignClaim = spool.accept(row({ messageId: 'f', claimedBy: 'dead-process' })).id;
    const ownLive = spool.accept(row({ messageId: 'own' })).id;
    spool.markProcessing(ownLive, 'me');

    expect(spool.recoverOrphans('me')).toBe(1);
    expect(spool.get(processing)).toMatchObject({ status: 'received', attempts: 1 });
    expect(spool.get(processing)?.claimedBy).toBeUndefined();
    expect(spool.get(foreignClaim)?.claimedBy).toBeUndefined();
    expect(spool.get(done)?.status).toBe('done');
    expect(spool.get(dead)?.status).toBe('dead');
    // This process's own live turn is left alone.
    expect(spool.get(ownLive)).toMatchObject({ status: 'processing', claimedBy: 'me' });
  });
});

describe('SQLiteInboundSpool — retention', () => {
  it('pruneDone never touches received or processing rows', () => {
    let t = 1_000;
    const spool = new SQLiteInboundSpool(':memory:', { now: () => t });
    const received = spool.accept(row({ messageId: 'r' })).id;
    const processing = spool.accept(row({ messageId: 'p' })).id;
    spool.markProcessing(processing, 'p1');
    const done = spool.accept(row({ messageId: 'd' })).id;
    spool.markDone(done);
    t = 10_000;
    expect(spool.pruneDone(5_000)).toBe(1);
    expect(spool.get(done)).toBeNull();
    expect(spool.get(received)?.status).toBe('received');
    expect(spool.get(processing)?.status).toBe('processing');
  });

  it('pruneDead removes only dead rows past the cutoff', () => {
    let t = 1_000;
    const spool = new SQLiteInboundSpool(':memory:', { now: () => t });
    const old = spool.accept(row({ messageId: 'old' })).id;
    spool.markDead(old, 'stale');
    t = 9_000;
    const fresh = spool.accept(row({ messageId: 'fresh' })).id;
    spool.markDead(fresh, 'stale');
    expect(spool.pruneDead(5_000)).toBe(1);
    expect(spool.get(old)).toBeNull();
    expect(spool.get(fresh)?.status).toBe('dead');
  });
});

/** Reads `PRAGMA synchronous` off the store's OWN handle — it is a
 *  per-connection setting. 2 = FULL, 1 = NORMAL. */
function syncPragma(store: unknown): number {
  const rows = (store as { db: { pragma(s: string): unknown } }).db.pragma('synchronous');
  return (rows as Array<{ synchronous: number }>)[0]?.synchronous ?? -1;
}

describe('SQLiteInboundSpool — durability posture', () => {
  it('runs at synchronous = FULL', () => {
    // NOT a candidate for NORMAL. A `received` row is a message the user sent
    // and was never answered; a power cut rolling it back is the failure this
    // store exists to prevent. Two commits per inbound message around an LLM
    // turn that takes seconds — the fsync is not what anyone waits on.
    const spool = new SQLiteInboundSpool(':memory:');
    expect(syncPragma(spool)).toBe(2);
  });

  it('sets busy_timeout = 5000', () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const rows = (spool as unknown as { db: { pragma(s: string): unknown } }).db.pragma(
      'busy_timeout',
    ) as Array<Record<string, number>>;
    expect(Object.values(rows[0] ?? {})[0]).toBe(5000);
  });
});

// Schema v3: a steer row folded into a running turn shares that turn's fate.
describe('SQLiteInboundSpool — absorbed steer rows', () => {
  function primaryAndSteer(spool: SQLiteInboundSpool): { primary: string; steer: string } {
    const primary = spool.accept(row({ messageId: 'm-p', claimedBy: 'p1' })).id;
    spool.markProcessing(primary, 'p1');
    const steer = spool.accept(
      row({ messageId: 'm-s', claimedBy: 'p1', payload: '{"text":"steer"}' }),
    ).id;
    expect(spool.markAbsorbed(steer, primary)).toBe(true);
    return { primary, steer };
  }

  it('links only a received row into an owed primary', () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const { primary, steer } = primaryAndSteer(spool);
    expect(spool.get(steer)?.absorbedInto).toBe(primary);
    const late = spool.accept(row({ messageId: 'm-late' })).id;
    spool.markDone(primary);
    // A primary that already finished cannot carry anything any more.
    expect(spool.markAbsorbed(late, primary)).toBe(false);
    expect(spool.markAbsorbed(late, late)).toBe(false);
  });

  it('done, interrupted, dead and discard are written to the absorbed row too', () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const a = primaryAndSteer(spool);
    spool.markDone(a.primary);
    expect(spool.get(a.steer)).toMatchObject({ status: 'done', payload: '{}' });

    const b = new SQLiteInboundSpool(':memory:');
    const x = primaryAndSteer(b);
    b.markToolStarted(x.primary);
    expect(b.markInterrupted(x.primary, 'crash')).toBe(true);
    expect(b.get(x.steer)).toMatchObject({ status: 'interrupted' });
    expect(b.get(x.steer)?.claimedBy).toBeUndefined();
    expect(b.discard(x.primary)).toBe(true);
    expect(b.get(x.steer)).toMatchObject({ status: 'done', lastError: 'discarded' });

    const c = new SQLiteInboundSpool(':memory:');
    const y = primaryAndSteer(c);
    expect(c.markFailed(y.primary, 'boom', 1)).toBe('dead');
    expect(c.get(y.steer)?.status).toBe('dead');
  });

  it('a failure that returns the primary to received leaves the steer linked and owed', () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const { primary, steer } = primaryAndSteer(spool);
    expect(spool.markFailed(primary, 'boom', 3)).toBe('received');
    expect(spool.get(steer)).toMatchObject({ status: 'received', absorbedInto: primary });
    spool.recoverOrphans('p2');
    // Never replayed on its own while the primary is owed; listed under it.
    expect(spool.listReplayable(['bot-a']).map((r) => r.id)).toEqual([primary]);
    expect(spool.listAbsorbed(primary).map((r) => r.id)).toEqual([steer]);
  });

  it('an absorbed row whose primary is gone replays as itself', () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const { primary, steer } = primaryAndSteer(spool);
    const db = (spool as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } })
      .db;
    db.prepare('DELETE FROM inbound_spool WHERE id = ?').run(primary);
    spool.recoverOrphans('p2');
    expect(spool.listReplayable(['bot-a']).map((r) => r.id)).toEqual([steer]);
  });

  it('retry closes the absorbed rows and runs the folded payload under one fresh row', () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const { primary, steer } = primaryAndSteer(spool);
    spool.markToolStarted(primary);
    spool.markInterrupted(primary, 'crash');
    // The absorbed row is not a `retry` target of its own.
    expect(spool.findInterrupted('telegram:bot-a:chat-1', 0)?.id).toBe(primary);
    const fresh = spool.retryInterrupted(primary, 'p2', '{"text":"hello\\n\\nsteer"}');
    expect(fresh).not.toBeNull();
    expect(spool.get(steer)).toMatchObject({ status: 'done', lastError: 'retried' });
    expect(spool.get(fresh ?? '')?.payload).toBe('{"text":"hello\\n\\nsteer"}');
  });

  it('a replayed primary absorbed into another turn hands its absorbed rows over', () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const q = spool.accept(row({ messageId: 'm-q', claimedBy: 'p1' })).id;
    spool.markProcessing(q, 'p1');
    const { primary, steer } = primaryAndSteer(spool);
    spool.releaseOnShutdown(primary);
    expect(spool.markAbsorbed(primary, q)).toBe(true);
    expect(spool.get(steer)?.absorbedInto).toBe(q);
    expect(spool.listAbsorbed(q).map((r) => r.id)).toEqual([primary, steer]);
  });

  it('requeue brings a primary back with its absorbed rows; an absorbed row alone is unlinked', () => {
    const spool = new SQLiteInboundSpool(':memory:');
    const { primary, steer } = primaryAndSteer(spool);
    spool.markFailed(primary, 'boom', 1);
    expect(spool.requeue(primary)).toBe(true);
    expect(spool.get(steer)).toMatchObject({ status: 'received', absorbedInto: primary });

    const other = new SQLiteInboundSpool(':memory:');
    const z = primaryAndSteer(other);
    other.markFailed(z.primary, 'boom', 1);
    expect(other.requeue(z.steer)).toBe(true);
    expect(other.get(z.steer)?.absorbedInto).toBeUndefined();
    expect(other.get(z.primary)?.status).toBe('dead');
  });
});
