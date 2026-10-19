import type {
  CompletionChunk,
  LLMProvider,
  Message,
  Tool,
  ToolDefinitionLite,
  UsageRecord,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
import { DefaultPersonalityRegistry } from '../defaults/noop-personality';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

// plan background-usage-accounting §5.2 — in-turn utility calls (a tool's
// `ctx.llm`, the turn-end memory flush) are metered when `AgentLoopConfig.usage`
// is set: one ledger row each, the cost charged to the session budget once, and
// one `usage` AgentEvent per charge (no new event variant, D15). Without
// `usage` the loop behaves exactly as before.

const MAIN_COST = 1;
const TOOL_LLM_COST = 0.1;
const FLUSH_COST = 0.01;

function usage(cost: number): CompletionChunk {
  return {
    type: 'usage',
    usage: {
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      estimatedCostUsd: cost,
    },
  };
}

interface Call {
  messages: Message[];
  tools: ToolDefinitionLite[];
  system?: string;
}

/**
 * Main call 1 asks for `summarize`; the tool's `ctx.llm` call answers; main
 * call 2 ends the turn. A flush call (identified by its system prompt) writes
 * nothing and stops.
 */
function scriptedLLM(log: Call[] = []): LLMProvider {
  let mainCalls = 0;
  return {
    name: 'scripted',
    model: 'main-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(messages, tools, options): AsyncIterable<CompletionChunk> {
      log.push({ messages, tools, system: options.system });
      if (options.system?.includes('silent background memory maintenance')) {
        yield { type: 'text_delta', text: 'nothing to save' };
        yield usage(FLUSH_COST);
        yield { type: 'done', finishReason: 'end_turn' };
        return;
      }
      const first = messages[0];
      if (tools.length === 0 && first?.content === 'UTILITY PROMPT') {
        yield { type: 'text_delta', text: 'summary' };
        yield usage(TOOL_LLM_COST);
        yield { type: 'done', finishReason: 'end_turn' };
        return;
      }
      mainCalls++;
      if (mainCalls === 1) {
        yield { type: 'tool_use_start', toolCallId: 'c1', toolName: 'summarize' };
        yield { type: 'tool_use_end', toolCallId: 'c1', inputJson: '{}' };
        yield usage(MAIN_COST);
        yield { type: 'done', finishReason: 'tool_use' };
        return;
      }
      yield { type: 'text_delta', text: 'final answer' };
      yield usage(MAIN_COST);
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 10;
    },
  };
}

function registry(): DefaultToolRegistry {
  const tools = new DefaultToolRegistry();
  const summarize: Tool = {
    name: 'summarize',
    description: 'summarize via ctx.llm',
    capabilities: {},
    schema: { type: 'object', properties: {} },
    async execute(_args, ctx) {
      const text = (await ctx.llm?.complete('UTILITY PROMPT')) ?? '';
      return { ok: true, value: text };
    },
  };
  const memWrite: Tool = {
    name: 'memory_write',
    description: 'write memory',
    toolset: 'memory',
    capabilities: {},
    schema: { type: 'object', properties: {} },
    async execute() {
      return { ok: true, value: 'ok' };
    },
  };
  tools.register(summarize);
  tools.register(memWrite);
  return tools;
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

function costEvents(events: AgentEvent[], cost: number): number[] {
  return events.flatMap((e, i) => (e.type === 'usage' && e.estimatedCostUsd === cost ? [i] : []));
}

describe('in-turn utility usage', () => {
  it('a tool using ctx.llm is recorded once, charged to the session once, and yields one usage event after the batch', async () => {
    const rows: UsageRecord[] = [];
    const loop = new AgentLoop({
      llm: scriptedLLM(),
      tools: registry(),
      safety: createTestSafety(),
      usage: { recorder: { record: (r) => rows.push(r) } },
      options: { platform: 'telegram' },
    });

    const events = await collect(loop.run('go', { sessionKey: 'k1' }));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'tool_llm',
      sourceClass: 'turn_utility',
      sessionKey: 'k1',
      personalityId: 'default',
      platform: 'telegram',
      estimatedCostUsd: TOOL_LLM_COST,
      outcome: 'ok',
    });
    expect(rows[0]?.sessionId).toEqual(expect.any(String));
    expect(loop.getSessionCost('k1')).toBeCloseTo(2 * MAIN_COST + TOOL_LLM_COST, 12);

    const charged = costEvents(events, TOOL_LLM_COST);
    expect(charged).toHaveLength(1);
    const toolEnd = events.findIndex((e) => e.type === 'tool_end' && e.toolName === 'summarize');
    const answer = events.findIndex((e) => e.type === 'text_delta' && e.text === 'final answer');
    expect(charged[0]).toBeGreaterThan(toolEnd);
    expect(charged[0]).toBeLessThan(answer);
  });

  it("the memory flush's usage is recorded and arrives as a post-done usage event", async () => {
    const rows: UsageRecord[] = [];
    const loop = new AgentLoop({
      llm: scriptedLLM(),
      tools: registry(),
      safety: createTestSafety(),
      usage: { recorder: { record: (r) => rows.push(r) } },
      memoryConsolidation: { enabled: true, flushThreshold: 0.000_001, minMessagesSinceFlush: 0 },
      compaction: { autoCompact: false },
    });

    const events = await collect(loop.run('go', { sessionKey: 'k2' }));

    expect(rows.map((r) => r.kind)).toEqual(['tool_llm', 'memory_flush']);
    expect(rows[1]).toMatchObject({ sessionKey: 'k2', estimatedCostUsd: FLUSH_COST });
    const done = events.findIndex((e) => e.type === 'done');
    const flushCharge = costEvents(events, FLUSH_COST);
    expect(flushCharge).toHaveLength(1);
    expect(flushCharge[0]).toBeGreaterThan(done);
    expect(loop.getSessionCost('k2')).toBeCloseTo(2 * MAIN_COST + TOOL_LLM_COST + FLUSH_COST, 12);
  });

  it('with budgetCapUsd just above the main-call cost, the utility charge trips cost-cap on the next iteration', async () => {
    const personalities = new DefaultPersonalityRegistry();
    personalities.define({ id: 'capped', name: 'Capped', budgetCapUsd: MAIN_COST + 0.05 });
    const log: Call[] = [];
    const loop = new AgentLoop({
      llm: scriptedLLM(log),
      tools: registry(),
      personalities,
      safety: createTestSafety(),
      usage: { recorder: { record: () => {} } },
    });

    const events = await collect(loop.run('go', { sessionKey: 'k3', personalityId: 'capped' }));

    const halt = events.find((e) => e.type === 'halt');
    expect(halt).toMatchObject({ kind: 'budget', rule: 'cost-cap' });
    // Main call 1 + the tool's utility call; main call 2 never happened.
    expect(log.filter((c) => c.tools.length > 0)).toHaveLength(1);
  });

  it('completeDirect meters as the given kind only when the loop meters usage', async () => {
    const rows: UsageRecord[] = [];
    const metered = new AgentLoop({
      llm: scriptedLLM(),
      safety: createTestSafety(),
      usage: { recorder: { record: (r) => rows.push(r) } },
    });
    const plain = new AgentLoop({ llm: scriptedLLM(), safety: createTestSafety() });
    const msgs: Message[] = [{ role: 'user', content: 'UTILITY PROMPT' }];
    const kind = { kind: 'channel_digest' as const, attribution: { botKey: 'b1' } };
    for await (const _ of metered.completeDirect(msgs, { usage: kind })) {
      // drain
    }
    for await (const _ of plain.completeDirect(msgs, { usage: kind })) {
      // drain
    }
    for await (const _ of metered.completeDirect(msgs)) {
      // drain
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'channel_digest',
      sourceClass: 'background',
      botKey: 'b1',
      estimatedCostUsd: TOOL_LLM_COST,
    });
  });

  it('without AgentLoopConfig.usage the event stream is unchanged (fixture)', async () => {
    const loop = new AgentLoop({
      llm: scriptedLLM(),
      tools: registry(),
      safety: createTestSafety(),
      memoryConsolidation: { enabled: true, flushThreshold: 0.000_001, minMessagesSinceFlush: 0 },
      compaction: { autoCompact: false },
    });

    const events = await collect(loop.run('go', { sessionKey: 'k4' }));
    // The tool's ctx.llm call and the flush still cost money, but nothing is
    // charged: the session total is the main calls only, as before this plan.
    expect(loop.getSessionCost('k4')).toBe(2 * MAIN_COST);

    expect(events.map(normalize)).toEqual(FIXTURE);
  });
});

/** Strip the fields that vary run to run (timings, generated ids). */
function normalize(e: AgentEvent): unknown {
  const out: Record<string, unknown> = { ...e };
  for (const k of ['durationMs', 'traceId', 'sessionId']) {
    if (k in out) out[k] = '<var>';
  }
  return out;
}

// Captured on main before this plan landed (f2cf5bd4).
const FIXTURE: unknown[] = [
  { type: 'run_start', provider: 'scripted', model: 'main-model', source: 'default' },
  { type: 'usage', inputTokens: 100, outputTokens: 10, estimatedCostUsd: 1 },
  { type: 'tool_start', toolCallId: 'c1', toolName: 'summarize', args: {} },
  {
    type: 'tool_end',
    toolCallId: 'c1',
    toolName: 'summarize',
    ok: true,
    durationMs: '<var>',
    result: 'summary',
  },
  { type: 'text_delta', text: 'final answer' },
  { type: 'usage', inputTokens: 100, outputTokens: 10, estimatedCostUsd: 1 },
  { type: 'done', text: 'final answer', turnCount: 2 },
];
