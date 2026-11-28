// R11 — the initiative ledger index is dynamic, so it renders as an `append` injector result
// (packages/types/src/injector.ts) and never enters the static prefix. Modelled on
// packages/core/src/__tests__/prompt-prefix-stability.test.ts: two turns of one session with
// the ledger changed in between.

import { AgentLoop, DefaultPersonalityRegistry } from '@ethosagent/core';
import { InitiativeIndexInjector } from '@ethosagent/initiative-runner';
import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  MemoryContext,
  MemoryProvider,
  Message,
  PersonalityConfig,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createTestSafety } from '../../../core/src/__tests__/helpers/test-safety';

const HEADER = 'Your initiatives (from your ledger)';
const PERSON: PersonalityConfig = { id: 'lean', name: 'Lean', toolset: [] };

function capturingLLM(captured: CompletionOptions[]): LLMProvider {
  return {
    name: 'capture',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(
      _m: Message[],
      _t: unknown,
      opts: CompletionOptions,
    ): AsyncIterable<CompletionChunk> {
      captured.push(opts);
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

const memory: MemoryProvider = {
  async prefetch() {
    return null;
  },
  async read() {
    return null;
  },
  async search() {
    return [];
  },
  async sync() {},
  async list(_ctx: MemoryContext) {
    return [];
  },
};

async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
  for await (const _e of gen) {
    // drained to exhaustion
  }
}

function makeLoop(captured: CompletionOptions[], lines: { current: string[] }) {
  const personalities = new DefaultPersonalityRegistry();
  personalities.define(PERSON);
  personalities.setDefault('lean');
  const injector = new InitiativeIndexInjector({
    store: { indexLines: () => lines.current },
  });
  return new AgentLoop({
    llm: capturingLLM(captured),
    personalities,
    injectors: [injector],
    safety: createTestSafety(),
    memory,
  });
}

describe('R11 ledger index is tail only', () => {
  it('keeps the static prefix byte-identical when the ledger changes between turns', async () => {
    const captured: CompletionOptions[] = [];
    const lines = {
      current: ['INI grow (active)', 'EXP-1 exploring: why churn? (due 2026-12-01)'],
    };
    const loop = makeLoop(captured, lines);

    await drain(loop.run('hello', { roomAudience: 'private' }));
    lines.current = ['INI grow (active)', 'EXP-2 proposed: pricing page (due 2026-12-09)'];
    await drain(loop.run('hello', { roomAudience: 'private' }));

    expect(captured).toHaveLength(2);
    const [a, b] = [captured[0]?.system ?? '', captured[1]?.system ?? ''];
    const cut = (s: string) => s.slice(0, s.indexOf(HEADER));
    expect(a).toContain(HEADER);
    expect(cut(a).length).toBeGreaterThan(0);
    expect(cut(a)).toBe(cut(b));
    expect(cut(a)).not.toContain('EXP-');
    expect(a).not.toBe(b);
    expect(a).toContain('EXP-1');
    expect(b).toContain('EXP-2');
  });

  it('renders nothing for a shared turn or an empty ledger', async () => {
    const captured: CompletionOptions[] = [];
    const lines = { current: ['INI grow (active)'] };
    const loop = makeLoop(captured, lines);
    await drain(loop.run('hello', { roomAudience: 'shared' }));
    lines.current = [];
    await drain(loop.run('hello', { roomAudience: 'private' }));
    expect(captured[0]?.system).not.toContain(HEADER);
    expect(captured[1]?.system).not.toContain(HEADER);
  });
});
