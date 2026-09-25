// plan decision-tool D13 — `AgentLoopConfig.personalityToolExclude`. Turn setup
// unions its answer with the surface's `toolsetExclude` into
// `filterOpts.excludeTools`, the one gate that outranks `alwaysInclude` in both
// `toDefinitions` and `executeParallel`. So a hidden tool is absent from the
// definitions AND refused at dispatch when the model names it anyway, and a
// surface exclusion still applies beside it.

import type {
  AgentEvent,
  CompletionChunk,
  LLMProvider,
  PersonalityConfig,
  ToolDefinitionLite,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { AgentLoop } from '../agent-loop';
import { DefaultPersonalityRegistry } from '../defaults/noop-personality';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

/** Round 1 captures the definitions and calls `forced`; round 2 ends the turn. */
function forcingLLM(forced: string, captured: ToolDefinitionLite[][]): LLMProvider {
  let calls = 0;
  return {
    name: 'forcing',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(_m, tools): AsyncIterable<CompletionChunk> {
      calls++;
      captured.push(tools);
      if (calls > 1) {
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'done', finishReason: 'end_turn' };
        return;
      }
      yield { type: 'tool_use_start', toolCallId: 'c1', toolName: forced };
      yield { type: 'tool_use_end', toolCallId: 'c1', inputJson: '{}' };
      yield { type: 'done', finishReason: 'tool_use' };
    },
    async countTokens() {
      return 1;
    },
  };
}

function setup(exclude: (p: PersonalityConfig) => string[]) {
  const executed = vi.fn(async () => ({ ok: true as const, value: 'ran' }));
  const tools = new DefaultToolRegistry();
  for (const name of ['alpha', 'beta']) {
    tools.register({ name, description: name, schema: {}, capabilities: {}, execute: executed });
  }
  tools.register({
    name: 'decide',
    description: 'decide',
    schema: {},
    capabilities: {},
    alwaysInclude: true,
    execute: executed,
  });
  const personalities = new DefaultPersonalityRegistry();
  vi.spyOn(personalities, 'getDefault').mockReturnValue({
    id: 'plain',
    name: 'Plain',
    toolset: ['alpha', 'beta'],
  });
  const captured: ToolDefinitionLite[][] = [];
  const loop = new AgentLoop({
    llm: forcingLLM('decide', captured),
    tools,
    personalities,
    safety: createTestSafety(),
    personalityToolExclude: exclude,
  });
  return { loop, captured, executed };
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const toolEnd = (events: AgentEvent[]) =>
  events.find((e): e is Extract<AgentEvent, { type: 'tool_end' }> => e.type === 'tool_end');

describe('personalityToolExclude (decision-tool D13)', () => {
  it('a hidden alwaysInclude tool is absent from the definitions and refused at dispatch', async () => {
    const { loop, captured, executed } = setup((p) => (p.id === 'plain' ? ['decide'] : []));
    const events = await collect(loop.run('go'));
    expect(captured[0]?.map((d) => d.name).sort()).toEqual(['alpha', 'beta']);
    expect(toolEnd(events)).toMatchObject({ toolName: 'decide', ok: false });
    expect(executed).not.toHaveBeenCalled();
  });

  it("a surface's toolsetExclude still applies beside the personality's", async () => {
    const { loop, captured } = setup(() => ['decide']);
    await collect(loop.run('go', { toolsetExclude: ['beta'] }));
    expect(captured[0]?.map((d) => d.name)).toEqual(['alpha']);
  });

  it('an empty answer hides nothing: alwaysInclude reaches the model and runs', async () => {
    const { loop, captured, executed } = setup(() => []);
    const events = await collect(loop.run('go'));
    expect(captured[0]?.map((d) => d.name).sort()).toEqual(['alpha', 'beta', 'decide']);
    expect(toolEnd(events)).toMatchObject({ toolName: 'decide', ok: true });
    expect(executed).toHaveBeenCalledTimes(1);
  });
});
