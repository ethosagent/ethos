import { forkSession, forkSessionKey } from '@ethosagent/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SQLiteSessionStore } from '../index';

// `forkSessionKey` (packages/core/src/session-fork.ts) against the store that
// actually enforces UNIQUE(key): two forks of one session in the same
// millisecond used to build the same `…:fork:<Date.now()>` key.

const base = {
  platform: 'cli',
  model: 'claude-opus-4-7',
  provider: 'anthropic',
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

const FROZEN = new Date('2026-09-25T12:00:00.000Z');

describe('forkSessionKey', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('two forks of one session in the same millisecond both succeed with distinct keys', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FROZEN);
    const store = new SQLiteSessionStore(':memory:');
    try {
      const source = await store.createSession({ ...base, key: 'cli:proj' });
      await store.appendMessage({ sessionId: source.id, role: 'user', content: 'hi' });

      // The old key shape collides: with the clock frozen both keys are equal.
      const legacy = `${source.key}:fork:${Date.now()}`;
      await forkSession(store, source.id, { key: legacy });
      await expect(forkSession(store, source.id, { key: legacy })).rejects.toThrow();

      const a = await forkSession(store, source.id, { key: forkSessionKey(source.key) });
      const b = await forkSession(store, source.id, { key: forkSessionKey(source.key) });
      const shape = new RegExp(`^cli:proj:fork:${FROZEN.getTime()}-[0-9a-f]{8}$`);
      expect(a.session.key).toMatch(shape);
      expect(b.session.key).toMatch(shape);
      expect(a.session.key).not.toBe(b.session.key);
      expect((await store.getMessages(b.session.id)).map((m) => m.content)).toEqual(['hi']);
    } finally {
      store.close();
    }
  });
});
