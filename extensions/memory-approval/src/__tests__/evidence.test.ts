// Evidence-gated promotion (plan openclaw-9.5-adoption item 3, D22): the
// pending queue merges re-proposals of one fact-hash, records the distinct
// sessions that extracted it, orders by that count, and — as a capture-only
// queue — promotes an entry at N sessions through the ordinary approve path.
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  EVIDENCE_APPROVER,
  MAX_EVIDENCE_SESSIONS,
  PendingMemoryStore,
  type PendingMemoryStoreOptions,
  TombstoneStore,
} from '../store';
import type { PendingEntry, ProposeInput } from '../types';

const DATA_DIR = '/data';
const SCOPE = 'personality:default';
const PENDING_PATH = '/data/personalities/default/memory-pending.jsonl';

function capture(hash: string, sessionId: string, text = `fact ${hash}`): ProposeInput {
  return {
    scopeId: SCOPE,
    update: { action: 'add', key: 'MEMORY.md', content: `\n- ${text}` },
    source: 'capture',
    factHash: hash,
    sessionId,
    sessionKey: `cli:${sessionId}`,
  };
}

describe('PendingMemoryStore — recurrence evidence', () => {
  let storage: InMemoryStorage;
  let tombstones: TombstoneStore;
  let approvals: Array<{ entry: PendingEntry; approvedBy: string }>;

  beforeEach(() => {
    storage = new InMemoryStorage();
    tombstones = new TombstoneStore({ storage, dataDir: DATA_DIR });
    approvals = [];
  });

  function makeStore(opts: Partial<PendingMemoryStoreOptions> = {}): PendingMemoryStore {
    return new PendingMemoryStore({
      storage,
      dataDir: DATA_DIR,
      tombstones,
      apply: async (entry, approvedBy) => void approvals.push({ entry, approvedBy }),
      ...opts,
    });
  }

  it('the same fact from the same session twice is one entry with one session of evidence', async () => {
    const store = makeStore({ evidenceSessions: 3 });
    await store.propose(capture('h1', 's1'));
    await store.propose(capture('h1', 's1'));

    const pending = await store.list(SCOPE);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.evidenceSessions).toEqual(['s1']);
  });

  it('three sessions extracting one fact is one entry with three sessions of evidence', async () => {
    let clock = 1_000;
    const store = makeStore({ evidenceSessions: 5, now: () => clock });
    await store.propose(capture('h1', 's1'));
    clock = 2_000;
    await store.propose(capture('h1', 's2'));
    clock = 3_000;
    await store.propose(capture('h1', 's3'));

    const pending = await store.list(SCOPE);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.evidenceSessions).toEqual(['s1', 's2', 's3']);
    // proposedAt is the TTL anchor and never moves; lastSeenAt does.
    expect(pending[0]?.proposedAt).toBe(1_000);
    expect(pending[0]?.lastSeenAt).toBe(3_000);
  });

  it('caps the recorded sessions at MAX_EVIDENCE_SESSIONS', async () => {
    const store = makeStore({ evidenceSessions: 3 });
    for (let i = 0; i < MAX_EVIDENCE_SESSIONS + 4; i++) await store.propose(capture('h1', `s${i}`));
    const [entry] = await store.list(SCOPE);
    expect(entry?.evidenceSessions).toHaveLength(MAX_EVIDENCE_SESSIONS);
  });

  it('entries without a factHash never merge', async () => {
    const store = makeStore({ evidenceSessions: 3 });
    const freeform: ProposeInput = {
      scopeId: SCOPE,
      update: { action: 'add', key: 'MEMORY.md', content: '\n- same text' },
      source: 'dream',
      sessionId: 's1',
    };
    await store.propose(freeform);
    await store.propose({ ...freeform, sessionId: 's2' });

    const pending = await store.list(SCOPE);
    expect(pending).toHaveLength(2);
    // Nothing evidence-related is recorded on a hashless entry.
    for (const e of pending) {
      expect(e.evidenceSessions).toBeUndefined();
      expect(e.lastSeenAt).toBeUndefined();
    }
  });

  it('N=0 appends a duplicate per proposal, and the queue file bytes match a store built without the option', async () => {
    const ids = ['id-1', 'id-2', 'id-3'];
    const seq = () => {
      let t = 5_000;
      return () => t++;
    };
    async function run(opts: Partial<PendingMemoryStoreOptions>): Promise<string | null> {
      storage = new InMemoryStorage();
      tombstones = new TombstoneStore({ storage, dataDir: DATA_DIR });
      const store = makeStore({ now: seq(), ...opts });
      for (const [i, s] of ['s1', 's2', 's3'].entries()) {
        const entry = await store.propose(capture('h1', s));
        // Pin the uuid so two runs are comparable byte-for-byte.
        const raw = (await storage.read(PENDING_PATH)) ?? '';
        await storage.writeAtomic(PENDING_PATH, raw.replace(entry.id, ids[i] ?? ''));
      }
      return storage.read(PENDING_PATH);
    }

    const without = await run({});
    const zero = await run({ evidenceSessions: 0 });
    expect(zero).toBe(without);
    expect(zero?.trim().split('\n')).toHaveLength(3);
    expect(zero).not.toContain('evidenceSessions');
    expect(zero).not.toContain('lastSeenAt');
  });

  it('an entry queued before evidence was on counts its own session when it merges', async () => {
    const legacy = makeStore();
    await legacy.propose(capture('h1', 's1'));
    const store = makeStore({ evidenceSessions: 3 });
    await store.propose(capture('h1', 's2'));
    const pending = await store.list(SCOPE);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.evidenceSessions).toEqual(['s1', 's2']);
  });

  it('orders the queue by evidence count, then oldest first', async () => {
    let clock = 1_000;
    const store = makeStore({ evidenceSessions: 5, now: () => clock++ });
    await store.propose(capture('a', 's1')); // 1 session, oldest
    await store.propose(capture('b', 's1')); // 3 sessions
    await store.propose(capture('c', 's1')); // 1 session, newer than a
    await store.propose(capture('d', 's1')); // 2 sessions
    await store.propose(capture('b', 's2'));
    await store.propose(capture('b', 's3'));
    await store.propose(capture('d', 's2'));

    const order = (await store.list(SCOPE)).map((e) => e.factHash);
    expect(order).toEqual(['b', 'd', 'a', 'c']);
  });

  it('never auto-approves without autoPromote (approval automated|all)', async () => {
    const store = makeStore({ evidenceSessions: 2 });
    await store.propose(capture('h1', 's1'));
    await store.propose(capture('h1', 's2'));
    await store.propose(capture('h1', 's3'));
    expect(approvals).toHaveLength(0);
    expect(await store.list(SCOPE)).toHaveLength(1);
  });

  it('capture-only queue with N=3: waits at 2 sessions, approves as evidence at 3', async () => {
    const store = makeStore({ evidenceSessions: 3, autoPromote: true });
    await store.propose(capture('h1', 's1'));
    await store.propose(capture('h1', 's2'));
    // A repeat from a session already counted is not new evidence.
    await store.propose(capture('h1', 's2'));
    expect(approvals).toHaveLength(0);
    expect(await store.list(SCOPE)).toHaveLength(1);

    await store.propose(capture('h1', 's3'));
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.approvedBy).toBe(EVIDENCE_APPROVER);
    expect(approvals[0]?.approvedBy).toBe('evidence');
    expect(approvals[0]?.entry.evidenceSessions).toEqual(['s1', 's2', 's3']);
    // Approve removes it from the queue, as a human approval does.
    expect(await store.list(SCOPE)).toHaveLength(0);
  });

  it('TTL expires a merged entry from its FIRST proposedAt, and tombstones its hash', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    let clock = 0;
    const store = makeStore({ evidenceSessions: 5, ttlMs: 10 * DAY, now: () => clock });
    await store.propose(capture('h1', 's1'));
    clock = 8 * DAY;
    await store.propose(capture('h1', 's2')); // merges; must not extend the TTL
    clock = 10 * DAY + 1;

    expect(await store.list(SCOPE)).toHaveLength(0);
    expect(await tombstones.has(SCOPE, 'h1')).toBe(true);
  });

  it('a failed promotion leaves the entry queued with its evidence, and the next sighting retries', async () => {
    let fail = true;
    const store = makeStore({
      evidenceSessions: 2,
      autoPromote: true,
      apply: async (entry, approvedBy) => {
        if (fail) throw new Error('disk full');
        approvals.push({ entry, approvedBy });
      },
    });
    await store.propose(capture('h1', 's1'));
    await expect(store.propose(capture('h1', 's2'))).rejects.toThrow('disk full');
    expect((await store.list(SCOPE))[0]?.evidenceSessions).toEqual(['s1', 's2']);

    fail = false;
    await store.propose(capture('h1', 's2'));
    expect(approvals.map((a) => a.approvedBy)).toEqual(['evidence']);
    expect(await store.list(SCOPE)).toHaveLength(0);
  });
});
