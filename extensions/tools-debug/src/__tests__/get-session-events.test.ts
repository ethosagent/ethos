// plan personality-memory-boundary G1-8 — `get_session_events` refuses a
// shared room's session (stamped shared, or a pre-upgrade group lane key)
// unless it is the caller's own session.

import { InMemorySessionStore } from '@ethosagent/core';
import type { ToolContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { buildGetSessionEvents } from '../index';

const usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  estimatedCostUsd: 0,
  apiCallCount: 0,
  compactionCount: 0,
};

function callerCtx(sessionId: string): ToolContext {
  return {
    sessionId,
    sessionKey: 'dream:ops:1',
    platform: 'cli',
    workingDir: '/tmp',
    currentTurn: 0,
    messageCount: 0,
    abortSignal: new AbortController().signal,
    emit: () => undefined,
    resultBudgetChars: 80_000,
  };
}

async function storeWith(key: string, metadata?: Record<string, unknown>) {
  const store = new InMemorySessionStore();
  const session = await store.createSession({
    key,
    platform: key.split(':')[0] ?? 'cli',
    model: 'm',
    provider: 'p',
    usage,
    ...(metadata ? { metadata } : {}),
  });
  await store.appendMessage({ sessionId: session.id, role: 'user', content: 'room secret' });
  return { store, id: session.id };
}

describe('get_session_events — shared sessions', () => {
  it('refuses a session stamped shared from another session', async () => {
    const { store, id } = await storeWith('web:abc', { roomAudience: 'shared' });
    const res = await buildGetSessionEvents({ sessionStore: store }).execute(
      { sessionId: id },
      callerCtx('dream-session'),
    );
    expect(res).toMatchObject({ ok: false, code: 'not_available' });
  });

  it('pre-upgrade fixture: refuses an UNSTAMPED telegram group lane', async () => {
    const { store, id } = await storeWith('telegram:bot1:-1001234567890');
    const res = await buildGetSessionEvents({ sessionStore: store }).execute(
      { sessionId: id },
      callerCtx('dream-session'),
    );
    expect(res.ok).toBe(false);
  });

  it("reads the caller's own shared session", async () => {
    const { store, id } = await storeWith('telegram:bot1:-100200');
    const res = await buildGetSessionEvents({ sessionStore: store }).execute(
      { sessionId: id },
      callerCtx(id),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toContain('room secret');
  });

  it('reads a DM lane, and a group listed in privateChats', async () => {
    const dm = await storeWith('telegram:bot1:4242');
    expect(
      (
        await buildGetSessionEvents({ sessionStore: dm.store }).execute(
          { sessionId: dm.id },
          callerCtx('other'),
        )
      ).ok,
    ).toBe(true);

    const trusted = await storeWith('telegram:bot1:-100200');
    const res = await buildGetSessionEvents({
      sessionStore: trusted.store,
      privateChats: { has: (p, c) => p === 'telegram' && c === '-100200' },
    }).execute({ sessionId: trusted.id }, callerCtx('other'));
    expect(res.ok).toBe(true);
  });
});
