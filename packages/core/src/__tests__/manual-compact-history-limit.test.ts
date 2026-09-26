// Manual `/compact` reads the history its personality's turns see.
//
// A small-window personality runs its turns with a scaled history limit
// (`SmallWindowOverlay.historyLimit`, applied by `withSmallWindow`), but
// `/compact` read the loop's normal limit (200). Every surface's `/compact` —
// CLI chat, TUI (via agent-bridge), gateway, web (`sessions.compact`) — calls
// `AgentLoop.compact`, which now passes `historyLimitFor` (small-window.ts) to
// `compactSession` (manual-compact.ts). Pinned here.

import type { PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../agent-loop';
import type { SmallWindowResolver } from '../agent-loop/small-window';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { DefaultPersonalityRegistry } from '../defaults/noop-personality';
import { createTestSafety } from './helpers/test-safety';

const usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  estimatedCostUsd: 0,
  apiCallCount: 0,
  compactionCount: 0,
};

async function setup(resolver?: SmallWindowResolver) {
  const session = new InMemorySessionStore();
  const limits: Array<number | undefined> = [];
  const getMessages = session.getMessages.bind(session);
  session.getMessages = async (id, opts) => {
    limits.push(opts?.limit);
    return getMessages(id, opts);
  };
  const personalities = new DefaultPersonalityRegistry();
  const small: PersonalityConfig = { id: 'small', name: 'Small' };
  const big: PersonalityConfig = { id: 'big', name: 'Big' };
  personalities.define(small);
  personalities.define(big);
  for (const p of [small, big]) {
    const s = await session.createSession({
      key: `cli:${p.id}`,
      platform: 'cli',
      model: 'm',
      provider: 'p',
      personalityId: p.id,
      usage,
    });
    for (let i = 0; i < 12; i++) {
      await session.appendMessage({
        sessionId: s.id,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `m-${i}`,
      });
    }
  }
  const loop = new AgentLoop({
    llm: {
      name: 'mock',
      model: 'm',
      maxContextTokens: 64_000,
      supportsCaching: false,
      supportsThinking: false,
      async *complete() {
        yield { type: 'done', finishReason: 'end_turn' };
      },
      async countTokens() {
        return 1;
      },
    },
    session,
    personalities,
    safety: createTestSafety(),
    ...(resolver ? { smallWindowResolver: resolver } : {}),
  });
  return { loop, limits };
}

// `small` engages small-window mode (scaled history of 40); `big` does not.
const resolver: SmallWindowResolver = async (personality) =>
  personality.id === 'small' ? { smallWindow: true, historyLimit: 40 } : { smallWindow: false };

describe('manual /compact — the personality’s own history limit', () => {
  it('a small-window personality compacts over its scaled history; others keep the loop limit', async () => {
    const { loop, limits } = await setup(resolver);
    await loop.compact('cli:small');
    expect(limits.at(-1)).toBe(40);
    await loop.compact('cli:big');
    expect(limits.at(-1)).toBe(200);
  });

  it('without a resolver it reads the loop limit, as before', async () => {
    const { loop, limits } = await setup();
    await loop.compact('cli:small');
    expect(limits.at(-1)).toBe(200);
  });
});
