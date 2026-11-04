import type { SessionStore } from '@ethosagent/types';
import { INCOGNITO_MAX_AGE_MS } from '@ethosagent/wiring';

/**
 * Incognito 24 h sweep (plan/phases/incognito-sessions.md D7/D8): scrubs the
 * content of incognito sessions older than `INCOGNITO_MAX_AGE_MS` through
 * `SessionStore.scrubIncognito`. UI cards need no sweep: incognito sessions
 * never persist them (`ChatService.persistCard`, pinned by
 * `apps/web-api/src/features/chat/__tests__/incognito.test.ts`). Run on the hourly retention ticks of
 * `ethos gateway start`, `ethos boot` and `ethos serve`. A store without the
 * method is a no-op. Errors propagate: the callers log and carry on, like
 * `pruneExpiredSessions`. Pinned by
 * `apps/ethos/src/commands/__tests__/incognito-retention.test.ts`.
 */
export async function scrubExpiredIncognito(
  store: Pick<SessionStore, 'scrubIncognito'>,
  opts: { now?: number } = {},
): Promise<{ messages: number; sessionIds: string[] }> {
  const now = opts.now ?? Date.now();
  if (!store.scrubIncognito) return { messages: 0, sessionIds: [] };
  return store.scrubIncognito({ olderThan: new Date(now - INCOGNITO_MAX_AGE_MS) });
}
