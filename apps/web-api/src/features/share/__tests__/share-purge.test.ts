import { SqliteShareLinkStore } from '@ethosagent/wiring';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PURGE_INTERVAL_MS, startSharePurge } from '../purge';

// plan share-links D2/D13: expired snapshots are purged at start and hourly; the timer is
// unref'd and cleared by the returned stop (createWebApi.dispose runs it).
beforeEach(() => vi.useFakeTimers({ now: new Date('2026-11-26T10:00:00Z') }));
afterEach(() => vi.useRealTimers());

function expiringLink(store: SqliteShareLinkStore, expiresAt: Date) {
  return store.create({
    sessionId: 's',
    personalityId: 'p',
    title: 't',
    options: '{}',
    snapshot: '{"v":1}',
    expiresAt,
    actor: 'cli',
  }).record.id;
}

describe('startSharePurge', () => {
  it('purges on start, then every hour, and stop clears the timer', () => {
    const store = new SqliteShareLinkStore(':memory:');
    const past = expiringLink(store, new Date('2026-11-26T09:00:00Z'));
    const soon = expiringLink(store, new Date('2026-11-26T10:30:00Z'));
    const kinds = (id: string) => store.listEvents(id).map((e) => e.kind);

    const stop = startSharePurge({ store });
    expect(kinds(past)).toEqual(['created', 'purged']);
    expect(kinds(soon)).toEqual(['created']);

    vi.advanceTimersByTime(PURGE_INTERVAL_MS);
    expect(kinds(soon)).toEqual(['created', 'purged']);

    stop();
    expect(vi.getTimerCount()).toBe(0);
    store.close();
  });

  it('unrefs its timer', () => {
    const unref = vi.fn();
    const spy = vi.spyOn(globalThis, 'setInterval').mockReturnValue({ unref } as never);
    const stop = startSharePurge({ store: { purgeExpired: () => 0 } });
    expect(unref).toHaveBeenCalledOnce();
    stop();
    spy.mockRestore();
  });

  it('a failing purge is reported and does not stop the schedule', () => {
    const onError = vi.fn();
    let n = 0;
    const stop = startSharePurge({
      store: {
        purgeExpired: () => {
          n += 1;
          if (n === 1) throw new Error('busy');
          return 0;
        },
      },
      onError,
    });
    expect(onError).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(PURGE_INTERVAL_MS);
    expect(n).toBe(2);
    stop();
  });

  it('revokes orphans (links whose session no longer exists) on start and hourly, as system', async () => {
    const store = new SqliteShareLinkStore(':memory:');
    const live = new Set(['kept']);
    const mk = (sessionId: string) =>
      store.create({
        sessionId,
        personalityId: 'p',
        title: 't',
        options: '{}',
        snapshot: '{"v":1}',
        expiresAt: new Date('2026-12-26T10:00:00Z'),
        actor: 'cli',
      }).record.id;
    const gone = mk('gone');
    const kept = mk('kept');
    const later = mk('later');
    live.add('later');
    const sessions = {
      getSession: async (id: string) => (live.has(id) ? ({ id } as never) : null),
    };
    const stop = startSharePurge({ store, sessions });
    await vi.advanceTimersByTimeAsync(0);
    const events = (id: string) => store.listEvents(id).map((e) => `${e.kind}:${e.actor}`);
    expect(events(gone)).toEqual(['created:cli', 'revoked:system']);
    expect(events(kept)).toEqual(['created:cli']);
    // A session deleted by any path between ticks is swept on the next tick (<= 1 hour).
    live.delete('later');
    expect(events(later)).toEqual(['created:cli']);
    await vi.advanceTimersByTimeAsync(PURGE_INTERVAL_MS);
    expect(events(later)).toEqual(['created:cli', 'revoked:system']);
    stop();
    store.close();
  });

  it('a failing orphan sweep is reported through onError and the schedule continues', async () => {
    const onError = vi.fn();
    const sweeps = vi.fn(async () => {
      throw new Error('sessions.db busy');
    });
    const stop = startSharePurge({
      store: { purgeExpired: () => 0, revokeOrphans: sweeps },
      sessions: { getSession: async () => null },
      onError,
    });
    await vi.advanceTimersByTimeAsync(PURGE_INTERVAL_MS);
    expect(sweeps).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(2);
    stop();
  });
});
