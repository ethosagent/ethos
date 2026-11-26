import type { Session } from '@ethosagent/types';
import type { SqliteShareLinkStore } from '@ethosagent/wiring';

// Two hourly jobs, both at start and then every hour (plan share-links D2, §3):
// - `purgeExpired` nulls expired snapshots (an expired link must not keep its text on disk);
// - `revokeOrphans` revokes live links whose session no longer exists, so EVERY deletion path
//   (web, CLI, retention prune, desktop) is covered without touching the SessionStore contract.
//   LIMITATION: a link to a deleted session stays readable until the next sweep, up to one hour.
// FAILURE MODE: a failing job (SQLITE_BUSY, a corrupt share-links.db, an unreadable session
// store) is caught and handed to `onError`; the next tick retries. Without an `onError` the
// failure is invisible and expired text stays on disk, so `wire.ts` always passes one. The
// timer is unref'd so it never holds the process open, and the returned stop clears it;
// `createWebApi.dispose()` runs stop. Pinned by __tests__/share-purge.test.ts (fake timers) and
// __tests__/share-wire.test.ts (onError reaches the logger).

export const PURGE_INTERVAL_MS = 3_600_000;

export function startSharePurge(opts: {
  store: Pick<SqliteShareLinkStore, 'purgeExpired'> &
    Partial<Pick<SqliteShareLinkStore, 'revokeOrphans'>>;
  /** Session existence source for the orphan sweep; absent -> no sweep. */
  sessions?: { getSession(id: string): Promise<Session | null> };
  now?: () => Date;
  intervalMs?: number;
  /** A purge failure must not take the server down; the next tick retries. */
  onError?: (err: unknown) => void;
}): () => void {
  const now = opts.now ?? (() => new Date());
  const { sessions, store } = opts;
  const run = (): void => {
    try {
      store.purgeExpired(now(), 'system');
    } catch (err) {
      opts.onError?.(err);
    }
    if (sessions && store.revokeOrphans) {
      store
        .revokeOrphans(async (id) => (await sessions.getSession(id)) !== null, 'system')
        .catch((err: unknown) => opts.onError?.(err));
    }
  };
  run();
  const timer = setInterval(run, opts.intervalMs ?? PURGE_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
