// V-CP-1 — a dream that does its maintenance through memory_write and then
// stops without a word is a successful dream: the loop ends it with a blank
// `done`, not `error empty_completion` (settleTextEnd,
// packages/core/src/agent-loop/stages/text-end.ts), so persistState runs and
// runsToday counts it against maxPerDay. Before the fix it re-ran every
// idleMinutes as a fresh paid turn.

import {
  AgentLoop,
  DefaultPersonalityRegistry,
  DefaultToolRegistry,
  InMemorySessionStore,
} from '@ethosagent/core';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type {
  CompletionChunk,
  LLMProvider,
  Message,
  PersonalityConfig,
  Tool,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createTestSafety } from '../../../../packages/core/src/__tests__/helpers/test-safety';
import { DreamExecutor } from '../dream-executor';

const personalityId = 'test-personality';

/** First call asks for one `memory_write`; the call after its result is silent. */
function silentDreamLLM(): LLMProvider {
  return {
    name: 'scripted',
    model: 'scripted-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(messages: Message[]): AsyncIterable<CompletionChunk> {
      const last = messages.at(-1);
      const afterTool =
        last !== undefined &&
        typeof last.content !== 'string' &&
        JSON.stringify(last.content).includes('tool_result');
      if (!afterTool) {
        const args = JSON.stringify({ store: 'memory', action: 'add', content: 'dreamt fact' });
        yield { type: 'tool_use_start', toolCallId: 'call-1', toolName: 'memory_write' };
        yield { type: 'tool_use_delta', toolCallId: 'call-1', partialJson: args };
        yield { type: 'tool_use_end', toolCallId: 'call-1', inputJson: args };
        yield { type: 'done', finishReason: 'tool_use' };
        return;
      }
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

describe('DreamExecutor — a silent tool-only dream (V-CP-1)', () => {
  it('persists its state after memory_write calls with no closing text', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(`personalities/${personalityId}`);
    const writes: unknown[] = [];
    const memoryWrite: Tool = {
      name: 'memory_write',
      description: 'memory_write',
      schema: { type: 'object' },
      capabilities: {},
      async execute(args: unknown) {
        writes.push(args);
        return { ok: true, value: 'saved' };
      },
    };
    const tools = new DefaultToolRegistry();
    tools.register(memoryWrite);
    const personalities = new DefaultPersonalityRegistry();
    personalities.define({ id: personalityId, name: 'Test', toolset: ['memory_write'] });
    const loop = new AgentLoop({
      llm: silentDreamLLM(),
      tools,
      session: new InMemorySessionStore(),
      personalities,
      safety: createTestSafety(),
      compaction: { autoCompact: false },
    });
    const cfg = {
      id: personalityId,
      name: 'Test',
      dreaming: { enable: true, idleMinutes: 60, maxPerDay: 1 },
    } as PersonalityConfig;
    const executor = new DreamExecutor(
      storage,
      () => loop,
      () => cfg,
    );
    executor.recordUserTurn(personalityId);
    const lastTurns = (executor as unknown as { lastUserTurnAt: Map<string, number> })
      .lastUserTurnAt;
    lastTurns.set(personalityId, Date.now() - 61 * 60_000);
    await (executor as unknown as { tick(): Promise<void> }).tick();
    executor.stop();

    expect(writes).toHaveLength(1);
    const raw = await storage.read(`personalities/${personalityId}/dream-state.json`);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw ?? '{}')).toMatchObject({ runsToday: 1 });
  });
});
