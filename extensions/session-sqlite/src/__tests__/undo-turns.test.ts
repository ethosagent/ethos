// UBP-023 — `/undo` removes whole TURNS: a `user` row through the end of the
// turn it started, tool rows included. The adjacency pairing it replaced
// (assistant followed by user in DESC order) refused a tool turn outright and,
// asked for two, deleted a question and its tool_use while leaving the tool
// result and final answer live.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SQLiteSessionStore } from '../index';

const baseSession = {
  key: 'cli:undo',
  platform: 'cli',
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
};

describe('SQLiteSessionStore.undoTurns', () => {
  let store: SQLiteSessionStore;
  let sessionId: string;

  beforeEach(async () => {
    store = new SQLiteSessionStore(':memory:');
    sessionId = (await store.createSession(baseSession)).id;
  });

  afterEach(() => {
    store.close();
  });

  async function plainTurn(q: string, a: string): Promise<void> {
    await store.appendMessage({ sessionId, role: 'user', content: q });
    await store.appendMessage({ sessionId, role: 'assistant', content: a });
  }

  async function toolTurn(q: string, a: string): Promise<void> {
    await store.appendMessage({ sessionId, role: 'user', content: q });
    await store.appendMessage({
      sessionId,
      role: 'assistant',
      content: '',
      toolCalls: [{ id: `tc-${q}`, name: 'read_file', input: { path: 'foo.ts' } }],
    });
    await store.appendMessage({
      sessionId,
      role: 'tool_result',
      content: 'file body',
      toolCallId: `tc-${q}`,
      toolName: 'read_file',
    });
    await store.appendMessage({ sessionId, role: 'assistant', content: a });
  }

  const contents = async () => (await store.getMessages(sessionId)).map((m) => m.content);

  it('undoes one tool-using turn completely (user, tool_use, tool_result, answer)', async () => {
    await plainTurn('hi', 'hello');
    await toolTurn('read foo.ts and fix', 'fixed');

    expect(await store.undoTurns(sessionId, 1)).toBe(1);
    expect(await contents()).toEqual(['hi', 'hello']);
  });

  it('undoes two tool turns — all eight rows', async () => {
    await plainTurn('hi', 'hello');
    await toolTurn('first', 'done 1');
    await toolTurn('second', 'done 2');

    expect(await store.undoTurns(sessionId, 2)).toBe(2);
    expect(await contents()).toEqual(['hi', 'hello']);
  });

  it('undoes a turn whose steer rows came after the user message', async () => {
    await plainTurn('hi', 'hello');
    await store.appendMessage({ sessionId, role: 'user', content: 'plan it' });
    await store.appendMessage({ sessionId, role: 'user_steer', content: 'and test it' });
    await store.appendMessage({ sessionId, role: 'assistant', content: 'planned + tested' });

    expect(await store.undoTurns(sessionId, 1)).toBe(1);
    expect(await contents()).toEqual(['hi', 'hello']);
  });

  it('asked for more turns than exist, undoes the ones there are', async () => {
    await toolTurn('only', 'answer');
    expect(await store.undoTurns(sessionId, 3)).toBe(1);
    expect(await contents()).toEqual([]);
  });

  it('returns 0 and removes nothing when there is no user turn', async () => {
    expect(await store.undoTurns(sessionId, 1)).toBe(0);
  });
});
