// plan telegram-live-cards L6 — `PromptContext.origin` is `RunOptions.origin` copied verbatim.
//
// `PromptContext.platform` is the LOOP's wiring profile ('cli' for a gateway process), the same for
// every turn it serves, so an injector cannot tell a Telegram turn from a CLI one by it. `origin`
// (`platform:chatId`, stamped by `Gateway.runTurn`) can. Enforcer: `assembleContext`
// (packages/core/src/agent-loop/stages/context-assembly.ts).

import type {
  CompletionChunk,
  ContextInjector,
  LLMProvider,
  PromptContext,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
import { DefaultPersonalityRegistry } from '../defaults/noop-personality';
import { createTestSafety } from './helpers/test-safety';

const llm: LLMProvider = {
  name: 'mock',
  model: 'mock-model',
  maxContextTokens: 200_000,
  supportsCaching: false,
  supportsThinking: false,
  async *complete(): AsyncIterable<CompletionChunk> {
    yield { type: 'text_delta', text: 'ok' };
    yield { type: 'done', finishReason: 'end_turn' };
  },
  async countTokens() {
    return 1;
  },
};

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<void> {
  for await (const _e of gen) {
    // drained to exhaustion
  }
}

function originSpy(seen: Array<string | undefined>): ContextInjector {
  return {
    id: 'origin-spy',
    priority: 1,
    async inject(ctx: PromptContext) {
      seen.push(ctx.origin);
      return null;
    },
  };
}

describe('PromptContext.origin', () => {
  it('carries the run origin, and is absent when the run has none', async () => {
    const reg = new DefaultPersonalityRegistry();
    vi.spyOn(reg, 'getDefault').mockReturnValue({ id: 'lean', name: 'Lean' });
    const seen: Array<string | undefined> = [];
    const loop = new AgentLoop({
      llm,
      personalities: reg,
      safety: createTestSafety(),
      injectors: [originSpy(seen)],
    });

    await drain(loop.run('a', { sessionKey: 'telegram:bot:77', origin: 'telegram:77' }));
    await drain(loop.run('b', { sessionKey: 'cli:here' }));

    expect(seen).toEqual(['telegram:77', undefined]);
  });
});
