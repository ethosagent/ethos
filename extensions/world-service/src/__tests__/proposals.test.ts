import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from '@ethosagent/sqlite';
import type { WorldId } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ProposeInput,
  type ServiceStoreOptions,
  SQLiteWorldServiceStore,
  serviceDbPath,
} from '../service-store';

const W: WorldId = 'world:acme';
const DAY = 24 * 60 * 60 * 1000;

function input(over: Partial<ProposeInput> = {}): ProposeInput {
  return {
    world: W,
    kind: 'assert',
    payload: { fact: 'Ravi owns billing' },
    summary: 'Ravi owns billing',
    sourceRef: 'chat:1',
    proposedBy: 'engineer',
    ...over,
  };
}

describe('proposals and the conflicts inbox', () => {
  let dir: string;
  let t: number;
  let store: SQLiteWorldServiceStore;
  const open = (opts: ServiceStoreOptions = {}) =>
    new SQLiteWorldServiceStore(serviceDbPath(dir), { now: () => new Date(t), ...opts });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'world-proposals-'));
    t = Date.UTC(2026, 10, 28, 12, 0, 0);
    store = open();
  });
  afterEach(() => {
    store.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('same payload twice → one pending row', () => {
    const a = store.propose(input());
    // a different proposer, summary and key order is still the same payload
    const b = store.propose(
      input({ proposedBy: 'other', summary: 'again', payload: { fact: 'Ravi owns billing' } }),
    );
    expect(a).toMatchObject({ created: true });
    expect(b).toMatchObject({ created: false });
    if (!('id' in a) || !('id' in b)) throw new Error('expected ids');
    expect(b.id).toBe(a.id);
    expect(store.countProposals(W)).toBe(1);
    // key order in the payload does not matter
    const c = store.propose(input({ payload: { b: 1, a: 2 } }));
    const d = store.propose(input({ payload: { a: 2, b: 1 } }));
    expect(d).toMatchObject({ created: false });
    expect('id' in c && 'id' in d && c.id === d.id).toBe(true);
    // the same payload in another world is a different proposal
    expect(store.propose(input({ world: 'world:other' }))).toMatchObject({ created: true });
  });

  it('rejected fingerprint is not re-proposed', () => {
    const a = store.propose(input());
    if (!('id' in a)) throw new Error('expected an id');
    const decided = store.decide(a.id, 'rejected', 'me', 'wrong');
    expect(decided).toMatchObject({ status: 'rejected', decidedBy: 'me', reason: 'wrong' });

    expect(store.propose(input())).toEqual({ refused: 'tombstoned' });
    expect(store.countProposals(W)).toBe(0);
    expect(store.hasTombstone(W, a.fingerprint)).toBe(true);
    // an accepted proposal leaves no tombstone
    const b = store.propose(input({ payload: { other: 1 } }));
    if (!('id' in b)) throw new Error('expected an id');
    store.decide(b.id, 'accepted', 'me');
    expect(store.hasTombstone(W, b.fingerprint)).toBe(false);
    // a decided proposal cannot be decided again
    expect(store.decide(b.id, 'rejected', 'me')).toBeNull();
  });

  it('cap expires the oldest', () => {
    store.dispose();
    store = open({ cap: 3 });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      t += 1000;
      const r = store.propose(input({ payload: { n: i } }));
      if (!('id' in r)) throw new Error('expected an id');
      ids.push(r.id);
    }
    expect(store.countProposals(W)).toBe(3);
    expect(store.get(ids[0] as string)).toMatchObject({ status: 'expired' });
    expect(store.get(ids[3] as string)).toMatchObject({ status: 'pending' });
    // another world has its own cap
    store.propose(input({ world: 'world:other' }));
    expect(store.countProposals(W)).toBe(3);
  });

  it('ttl expires stale pending proposals', () => {
    store.dispose();
    store = open({ ttlDays: 30 });
    const old = store.propose(input({ payload: { n: 'old' } }));
    t += 31 * DAY;
    const fresh = store.propose(input({ payload: { n: 'fresh' } }));
    if (!('id' in old) || !('id' in fresh)) throw new Error('expected ids');
    expect(store.get(old.id)).toMatchObject({ status: 'expired' });
    expect(store.inbox(W).map((p) => p.id)).toEqual([fresh.id]);
    // an expired proposal can be proposed again (expiry is not a tombstone)
    expect(store.propose(input({ payload: { n: 'old' } }))).toMatchObject({ created: true });
  });

  it('inbox lists conflicts first, then by created_at, rowid', () => {
    // three non-conflicts in the same instant, then a later conflict
    const a = store.propose(input({ payload: { n: 'a' } }));
    const b = store.propose(input({ payload: { n: 'b' } }));
    t += 1000;
    const c = store.propose(input({ payload: { n: 'c' } }));
    t += 1000;
    const x = store.propose(input({ payload: { n: 'x' }, conflictWith: 'r-live-1' }));
    for (const r of [a, b, c, x]) if (!('id' in r)) throw new Error('expected ids');
    const ids = [a, b, c, x].map((r) => ('id' in r ? r.id : ''));

    const inbox = store.inbox(W);
    expect(inbox.map((p) => p.id)).toEqual([ids[3], ids[0], ids[1], ids[2]]);
    expect(inbox[0]?.conflictWith).toBe('r-live-1');
    // rowid is selected explicitly and breaks the created_at tie
    expect(typeof inbox[1]?.rowid).toBe('number');
    expect((inbox[1]?.rowid ?? 0) < (inbox[2]?.rowid ?? 0)).toBe(true);
    expect(inbox[1]?.createdAt).toBe(inbox[2]?.createdAt);
    // the inbox only holds pending rows
    store.decide(ids[3] as string, 'accepted', 'me');
    expect(store.inbox(W).map((p) => p.id)).toEqual([ids[0], ids[1], ids[2]]);
  });

  it('batch_id groups a first-build or shared-world batch', () => {
    for (let i = 0; i < 3; i++) {
      store.propose(input({ payload: { n: i }, batchId: 'build-1' }));
    }
    store.propose(input({ payload: { n: 'solo' } }));
    const batch = store.inbox(W, { batchId: 'build-1' });
    expect(batch).toHaveLength(3);
    expect(batch.every((p) => p.batchId === 'build-1')).toBe(true);
    expect(store.inbox(W)).toHaveLength(4);
    // the unique pending index is what makes dedup race-free
    const db = (store as unknown as { db: Database.Database }).db;
    const idx = db
      .prepare(`SELECT sql FROM sqlite_master WHERE name = 'idx_proposals_pending_fp'`)
      .get() as { sql: string };
    expect(idx.sql).toMatch(/UNIQUE/);
  });

  it('a decision survives a reopen', () => {
    const a = store.propose(input());
    if (!('id' in a)) throw new Error('expected an id');
    store.decide(a.id, 'rejected', 'me');
    store.dispose();
    store = open();
    expect(store.propose(input())).toEqual({ refused: 'tombstoned' });
  });
});
