import { RETENTION_DEFAULTS, type RetentionConfig, type SessionStore } from '@ethosagent/types';
import { parseDuration } from '@ethosagent/wiring';

/**
 * R9 — the one runtime caller of `SessionStore.pruneOldSessions`, run by the
 * hourly retention timers in `ethos gateway start` (apps/ethos/src/commands/
 * gateway.ts, `pruneSessions`) and `ethos boot`.
 *
 * Keyed on the existing `retention.messages` window (default
 * `RETENTION_DEFAULTS.messages`, `forever` disables): the `observability-prune`
 * cron deletes messages past that window (`pruneObservability`,
 * extensions/observability-sqlite/src/retention.ts), and this removes the
 * session rows those deletions leave empty. A session holding any message
 * inside the window is kept by the store itself
 * (`SQLiteSessionStore.pruneOldSessions`). Pinned by
 * `apps/ethos/src/commands/__tests__/session-retention.test.ts`.
 */
export async function pruneExpiredSessions(
  store: Pick<SessionStore, 'pruneOldSessions'>,
  retention: RetentionConfig | undefined,
  now: number = Date.now(),
): Promise<number> {
  const window = parseDuration(retention?.messages ?? RETENTION_DEFAULTS.messages);
  if (window === null) return 0;
  return store.pruneOldSessions(new Date(now - window));
}
