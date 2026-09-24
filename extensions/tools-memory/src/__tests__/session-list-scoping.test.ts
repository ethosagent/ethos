/**
 * Item 8 (openclaw-advisory-fixes) — session_list_by_date is scoped to the
 * calling personality. Without the filter, a personality with the memory
 * toolset enumerated every other personality's session titles and ids.
 */

import { InMemorySessionStore } from '@ethosagent/core';
import type { ToolContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createSessionListByDateTool } from '../index';

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'session-under-test',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir: '/tmp',
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
    ...overrides,
  };
}

const USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  estimatedCostUsd: 0,
  apiCallCount: 0,
  compactionCount: 0,
};

async function seed(): Promise<InMemorySessionStore> {
  const store = new InMemorySessionStore();
  for (const [personalityId, n] of [
    ['alpha', 1],
    ['alpha', 2],
    ['beta', 1],
    ['beta', 2],
  ] as const) {
    await store.createSession({
      key: `cli:${personalityId}-${n}`,
      platform: 'cli',
      model: 'm',
      provider: 'p',
      personalityId,
      title: `${personalityId} session ${n}`,
      usage: USAGE,
    });
  }
  return store;
}

describe('session_list_by_date personality scoping', () => {
  it("returns only the calling personality's sessions", async () => {
    const tool = createSessionListByDateTool(await seed());
    const result = await tool.execute({ limit: 50 }, makeCtx({ personalityId: 'alpha' }));
    expect(result.ok).toBe(true);
    const text = result.ok ? result.value : '';
    expect(text).toContain('alpha session 1');
    expect(text).toContain('alpha session 2');
    expect(text).not.toContain('beta');
  });

  it('refuses a call with no personality context instead of listing unfiltered', async () => {
    const tool = createSessionListByDateTool(await seed());
    const result = await tool.execute({ limit: 50 }, makeCtx());
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.code).toBe('input_invalid');
    expect(JSON.stringify(result)).not.toContain('session 1');
  });
});
