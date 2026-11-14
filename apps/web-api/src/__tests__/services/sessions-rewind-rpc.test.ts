import { SQLiteCardStore } from '@ethosagent/session-cards';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import type { CardEnvelope } from '@ethosagent/web-contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionsRepository } from '../../features/sessions/repository';
import { SessionsService } from '../../features/sessions/service';
import { SCOPE_MAP } from '../../middleware/dual-auth';
import { apiRouter } from '../../rpc/router';

// `sessions.rewind`: fork just before an earlier prompt, return its text.
// Real SQLite stores; the busy guard is injected.

const CARD: CardEnvelope = { kind: 'text', specVersion: 1, payload: { title: 'n', text: 'x' } };

describe('sessions.rewind', () => {
  let store: SQLiteSessionStore;
  let repo: SessionsRepository;
  let service: SessionsService;
  let sessionId: string;
  let userIds: string[];

  beforeEach(async () => {
    store = new SQLiteSessionStore(':memory:');
    repo = new SessionsRepository(store);
    service = new SessionsService({ sessions: repo });
    const s = await store.createSession({
      key: 'web:rewind',
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
    sessionId = s.id;
    userIds = [];
    for (const [role, content] of [
      ['user', 'a'],
      ['assistant', 'A'],
      ['user', 'b'],
      ['assistant', 'B'],
    ] as const) {
      const m = await store.appendMessage({ sessionId, role, content });
      if (role === 'user') userIds.push(m.id);
    }
  });

  afterEach(() => store.close());

  it('is mounted on the router and scoped sessions:write', () => {
    expect((apiRouter.sessions as Record<string, unknown>).rewind).toBeDefined();
    expect(SCOPE_MAP.sessions?.rewind).toBe('sessions:write');
  });

  it('forks before the target prompt and returns the original text', async () => {
    const out = await service.rewind(sessionId, { turnsBack: 1 });
    expect(out.prompt).toBe('b');
    expect(out.turnsBack).toBe(1);
    expect(out.hadAttachments).toBe(false);
    expect(out.session.parentSessionId).toBe(sessionId);
    expect((await store.getMessages(out.session.id)).map((m) => m.content)).toEqual(['a', 'A']);
  });

  it('accepts an exact messageId', async () => {
    const out = await service.rewind(sessionId, { messageId: userIds[0] ?? '' });
    expect(out.prompt).toBe('a');
    expect(out.turnsBack).toBe(2);
    expect(await store.getMessages(out.session.id)).toEqual([]);
  });

  it('refuses while a turn is running and creates nothing', async () => {
    const busy = new SessionsService({ sessions: repo, isTurnRunning: () => true });
    await expect(busy.rewind(sessionId, { turnsBack: 1 })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(await store.listSessions({ parentSessionId: sessionId })).toEqual([]);
  });

  it('maps an unknown session to SESSION_NOT_FOUND', async () => {
    await expect(service.rewind('nope', { turnsBack: 1 })).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
    });
  });

  it('copies only the cards of kept tool calls', async () => {
    const cards = new SQLiteCardStore(':memory:');
    try {
      const s2 = await store.createSession({
        key: 'web:rewind-cards',
        platform: 'web',
        provider: 'anthropic',
        model: 'm',
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
      const add = (m: Parameters<typeof store.appendMessage>[0]) => store.appendMessage(m);
      await add({ sessionId: s2.id, role: 'user', content: 'q1' });
      await add({
        sessionId: s2.id,
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 't1', name: 'x', input: {} }],
      });
      await add({ sessionId: s2.id, role: 'tool_result', content: 'r', toolCallId: 't1' });
      await add({ sessionId: s2.id, role: 'assistant', content: 'A1' });
      await add({ sessionId: s2.id, role: 'user', content: 'q2' });
      await add({
        sessionId: s2.id,
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 't2', name: 'x', input: {} }],
      });
      await add({ sessionId: s2.id, role: 'tool_result', content: 'r', toolCallId: 't2' });
      cards.append(s2.id, 't1', CARD);
      cards.append(s2.id, 't2', CARD);

      const withCards = new SessionsService({ sessions: repo, cards });
      const out = await withCards.rewind(s2.id, { turnsBack: 1 });
      expect(cards.list(out.session.id).map((c) => c.toolCallId)).toEqual(['t1']);
    } finally {
      cards.close();
    }
  });
});
