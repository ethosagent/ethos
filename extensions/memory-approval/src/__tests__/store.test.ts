import { HistoryStore, withHistory } from '@ethosagent/memory-history';
import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { MemoryContext } from '@ethosagent/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PendingMemoryStore, TombstoneStore } from '../store';
import type { ApplyFn, PendingEntry, PendingGateObservability, ProposeInput } from '../types';

const DATA_DIR = '/data';
const SCOPE = 'personality:default';

function ctx(): MemoryContext {
  return {
    scopeId: SCOPE,
    sessionId: 's1',
    sessionKey: 'cli:proj',
    platform: 'cli',
    workingDir: '/w',
  };
}

function capture(text: string, hash: string): ProposeInput {
  return {
    scopeId: SCOPE,
    update: { action: 'add', key: 'MEMORY.md', content: `\n- ${text}` },
    source: 'capture',
    factHash: hash,
    sessionId: 's1',
    sessionKey: 'cli:proj',
  };
}

describe('PendingMemoryStore', () => {
  let storage: InMemoryStorage;
  let tombstones: TombstoneStore;

  beforeEach(() => {
    storage = new InMemoryStorage();
    tombstones = new TombstoneStore({ storage, dataDir: DATA_DIR });
  });

  function makeStore(opts: {
    apply?: ApplyFn;
    cap?: number;
    ttlMs?: number;
    now?: () => number;
    observability?: PendingGateObservability;
  }): PendingMemoryStore {
    return new PendingMemoryStore({
      storage,
      dataDir: DATA_DIR,
      tombstones,
      apply: opts.apply ?? (async () => {}),
      ...(opts.cap !== undefined ? { cap: opts.cap } : {}),
      ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.observability ? { observability: opts.observability } : {}),
    });
  }

  it('parks a capture candidate; nothing is written to the provider', async () => {
    const applied: PendingEntry[] = [];
    const store = makeStore({ apply: async (e) => void applied.push(e) });

    await store.propose(capture('user has a dog named Rex', 'h1'));

    const pending = await store.list(SCOPE);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.factHash).toBe('h1');
    // NOT written: apply is only invoked on approve.
    expect(applied).toHaveLength(0);
  });

  it('approve replays through history with the original source + approvedBy', async () => {
    const base = new MarkdownFileMemoryProvider({ dir: DATA_DIR, storage });
    const history = new HistoryStore({ dataDir: DATA_DIR, storage });
    const apply: ApplyFn = async (entry, approvedBy) => {
      const handle = withHistory(base, history, { source: entry.source, approvedBy });
      await handle.sync([entry.update], {
        scopeId: entry.scopeId,
        sessionId: entry.sessionId ?? '',
        sessionKey: entry.sessionKey ?? 'cli',
        platform: 'cli',
        workingDir: '',
      });
    };
    const store = makeStore({ apply });

    const entry = await store.propose(capture('daughter Priya b. 2019', 'h2'));
    const before = await base.read('MEMORY.md', ctx());
    expect(before?.content ?? '').not.toContain('Priya');

    const res = await store.approve(SCOPE, entry.id, 'mitesh');
    expect(res.ok).toBe(true);

    // Durable memory now holds the fact.
    const after = await base.read('MEMORY.md', ctx());
    expect(after?.content ?? '').toContain('daughter Priya b. 2019');

    // History recorded it under the ORIGINAL source + approvedBy.
    const { entries } = await history.read(SCOPE);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.source).toBe('capture');
    expect(entries[0]?.approvedBy).toBe('mitesh');

    // Removed from the queue.
    expect(await store.list(SCOPE)).toHaveLength(0);
  });

  it('reject tombstones the fact-hash and removes it from the queue', async () => {
    const store = makeStore({});
    const entry = await store.propose(capture('bad inference about the user', 'h3'));

    expect(await tombstones.has(SCOPE, 'h3')).toBe(false);
    const res = await store.reject(SCOPE, entry.id, 'wrong');
    expect(res.ok).toBe(true);
    expect(await tombstones.has(SCOPE, 'h3')).toBe(true);
    expect(await store.list(SCOPE)).toHaveLength(0);
  });

  it('drops the oldest and emits an observability event when the cap is exceeded', async () => {
    const onCapExceeded =
      vi.fn<(detail: { scopeId: string; droppedId: string; cap: number }) => void>();
    const store = makeStore({ cap: 2, observability: { onCapExceeded } });

    const first = await store.propose(capture('fact one', 'h1'));
    await store.propose(capture('fact two', 'h2'));
    await store.propose(capture('fact three', 'h3'));

    const pending = await store.list(SCOPE);
    expect(pending).toHaveLength(2);
    expect(pending.map((e) => e.factHash)).toEqual(['h2', 'h3']);
    expect(onCapExceeded).toHaveBeenCalledTimes(1);
    expect(onCapExceeded).toHaveBeenCalledWith(
      expect.objectContaining({ scopeId: SCOPE, droppedId: first.id, cap: 2 }),
    );
  });

  it('expiry prunes stale entries (auto-reject → tombstone)', async () => {
    let now = 1_000_000;
    const store = makeStore({ ttlMs: 1000, now: () => now });

    await store.propose(capture('ephemeral fact', 'hx'));
    expect(await store.list(SCOPE)).toHaveLength(1);

    now += 2000; // past the TTL
    expect(await store.list(SCOPE)).toHaveLength(0);
    // Expired capture facts are tombstoned so they are not re-proposed.
    expect(await tombstones.has(SCOPE, 'hx')).toBe(true);
  });

  it('approve of an unknown id is a no-op', async () => {
    const store = makeStore({});
    const res = await store.approve(SCOPE, 'nope', 'cli');
    expect(res.ok).toBe(false);
  });
});
