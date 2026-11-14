import { listRewindPoints } from '@ethosagent/core';
import { describe, expect, it } from 'vitest';
import { SQLiteSessionStore } from '../index';

describe('listRewindPoints on the SQLite store', () => {
  it('does not list or count prompts removed by undoTurns', async () => {
    const store = new SQLiteSessionStore(':memory:');
    const s = await store.createSession({
      key: 'cli:rw',
      platform: 'cli',
      model: 'm',
      provider: 'p',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0,
        apiCallCount: 0,
        compactionCount: 0,
      },
    });
    for (const t of ['one', 'two', 'three']) {
      await store.appendMessage({ sessionId: s.id, role: 'user', content: t });
      await store.appendMessage({ sessionId: s.id, role: 'assistant', content: `re ${t}` });
    }
    await store.undoTurns(s.id, 1);
    const pts = await listRewindPoints(store, s.id);
    expect(pts).toHaveLength(2);
    expect(pts[0]).toMatchObject({ turnsBack: 1, text: 'two' });
    store.close();
  });
});
