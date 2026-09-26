// R9 (plan/phases/openclaw-2026.9.6-gaps.md) — `pruneOldSessions` gets a
// runtime caller (the gateway's hourly retention timer). It keys on
// `sessions.updated_at`, which `appendMessage` does NOT bump (only session
// updates and `updateUsage` do), so a session whose latest traffic never
// touched usage could read as stale while holding recent messages. A session
// with any message at or after the cutoff is kept.

import { describe, expect, it } from 'vitest';
import { SQLiteSessionStore } from '../index';

const baseSession = {
  key: 'cli:default',
  platform: 'cli',
  model: 'claude-opus-4-7',
  provider: 'anthropic',
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

const DAY_MS = 86_400_000;

function backdate(store: SQLiteSessionStore, sessionId: string, days: number): void {
  // biome-ignore lint/suspicious/noExplicitAny: direct DB access for test setup
  (store as any).db
    .prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
    .run(new Date(Date.now() - days * DAY_MS).toISOString(), sessionId);
}

describe('SQLiteSessionStore.pruneOldSessions keeps sessions with recent messages', () => {
  it('does not delete a stale-looking session that holds a message newer than the cutoff', async () => {
    const store = new SQLiteSessionStore(':memory:');
    try {
      const live = await store.createSession({ ...baseSession, key: 'live' });
      await store.appendMessage({ sessionId: live.id, role: 'user', content: 'still here' });
      backdate(store, live.id, 30);

      const shell = await store.createSession({ ...baseSession, key: 'shell' });
      backdate(store, shell.id, 30);

      expect(await store.pruneOldSessions(new Date(Date.now() - 7 * DAY_MS))).toBe(1);
      expect(await store.getSession(live.id)).not.toBeNull();
      expect(await store.getSession(shell.id)).toBeNull();
    } finally {
      store.close();
    }
  });
});
