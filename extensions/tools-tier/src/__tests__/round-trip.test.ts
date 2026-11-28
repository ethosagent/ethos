// think-deeper-tier-switch Task 1.1 — the REAL `think_deeper` tool through a
// real AgentLoop and a stub LLM: fast, then deep, then fast again. The tool
// only asks; core switches (`tool-processing.ts` sets the one-shot flag,
// `stream-step.ts` consumes it). The core-side pin, with a stub tool, is
// `packages/core/src/__tests__/model-tier.test.ts`.

import { AgentLoop, DefaultToolRegistry } from '@ethosagent/core';
import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  ModelRegistry,
  Tool,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createTestSafety } from '../../../../packages/core/src/__tests__/helpers/test-safety';
import { createThinkDeeperTool } from '../index';

const registry: ModelRegistry = {
  entries: {
    sonnet: { alias: 'sonnet', provider: 'anthropic', modelId: 'claude-sonnet-5' },
    opus: { alias: 'opus', provider: 'anthropic', modelId: 'claude-opus-5' },
  },
  default: 'sonnet',
  roles: { deep: 'opus' },
};

const noop: Tool = {
  name: 'noop',
  description: 'does nothing',
  schema: { type: 'object' },
  capabilities: {},
  async execute() {
    return { ok: true, value: 'done' };
  },
};

function scriptedLLM(served: Array<string | undefined>): LLMProvider {
  let call = 0;
  return {
    name: 'mock',
    model: 'base-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(_m, _t, opts: CompletionOptions): AsyncIterable<CompletionChunk> {
      served.push(opts.modelOverride);
      call += 1;
      if (call <= 2) {
        const name = call === 1 ? 'think_deeper' : 'noop';
        const json = call === 1 ? JSON.stringify({ reason: 'race condition' }) : '{}';
        yield { type: 'tool_use_start', toolCallId: `tc${call}`, toolName: name };
        yield { type: 'tool_use_delta', toolCallId: `tc${call}`, partialJson: json };
        yield { type: 'tool_use_end', toolCallId: `tc${call}`, inputJson: json };
        yield { type: 'done', finishReason: 'tool_use' };
        return;
      }
      yield { type: 'text_delta', text: 'answer' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 10;
    },
  };
}

describe('think_deeper round trip (real tool, real loop)', () => {
  it('runs call 2 on deep and call 3 back on the turn model', async () => {
    const served: Array<string | undefined> = [];
    const tools = new DefaultToolRegistry();
    tools.register(createThinkDeeperTool());
    tools.register(noop);
    const loop = new AgentLoop({
      llm: scriptedLLM(served),
      tools,
      safety: createTestSafety(),
      modelResolution: { registry, routing: {} },
    });
    // biome-ignore lint/complexity/useLiteralKeys: `personalities` is private; bracket-string is the TS escape hatch for test access
    loop['personalities'].define({
      id: 'esc',
      name: 'Esc',
      model: 'default',
      toolset: ['think_deeper', 'noop'],
    });

    const events = [];
    for await (const e of loop.run('hi', { personalityId: 'esc' })) events.push(e);

    expect(served).toEqual(['claude-sonnet-5', 'claude-opus-5', 'claude-sonnet-5']);
    const esc = events.find((e) => e.type === 'tier_escalation');
    expect(esc).toMatchObject({ to: 'deep', model: 'claude-opus-5', reason: 'race condition' });
  });
});
