import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { describe, expect, it } from 'vitest';
import { SessionsRepository } from '../../features/sessions/repository';
import { SessionsService } from '../../features/sessions/service';
import { apiRouter } from '../../rpc/router';

// UBP-023 — `sessions.undoTurns` is declared in packages/web-contracts but had
// no handler, so the web client's `/undo` always failed (and `useChat` hid it).

describe('sessions.undoTurns', () => {
  it('is mounted on the router', () => {
    const sessions = apiRouter.sessions as Record<string, unknown>;
    expect(sessions.undoTurns).toBeDefined();
  });

  it('removes a whole tool turn through the real store', async () => {
    const store = new SQLiteSessionStore(':memory:');
    try {
      const session = await store.createSession({
        key: 'web:undo',
        platform: 'web',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
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
      });
      const add = (role: 'user' | 'assistant' | 'tool_result', content: string) =>
        store.appendMessage({ sessionId: session.id, role, content });
      await add('user', 'q');
      await add('assistant', '');
      await add('tool_result', 'r');
      await add('assistant', 'a');

      const service = new SessionsService({ sessions: new SessionsRepository(store) });
      expect(await service.undoTurns(session.id, 1)).toEqual({ removed: 1 });
      expect(await store.getMessages(session.id)).toEqual([]);
    } finally {
      store.close();
    }
  });
});
