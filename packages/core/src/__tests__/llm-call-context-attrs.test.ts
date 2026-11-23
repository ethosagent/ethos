// Context meter — the `llm_call` span carries `systemSections`, `contextWindow`
// and `compactAtTokens` so the anatomy RPC can split memory/skills out of the
// provider-measured system slice. Pins: `contextMeterAttrs`
// (`agent-loop/context-sections.ts`), the capture in `assembleContext`
// (`agent-loop/stages/context-assembly.ts`) and the stamp in `stream-step.ts`.

import type {
  CompletionChunk,
  CompletionOptions,
  ContextInjector,
  LLMProvider,
  MemoryProvider,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../agent-loop';
import { apportionSystemSections, meterGateTokens } from '../agent-loop/context-sections';
import { NoopMemoryProvider } from '../defaults/noop-memory';
import { DefaultHookRegistry } from '../hook-registry';
import type { AgentLoopObservability } from '../observability/agent-loop-observability';
import { createTestSafety } from './helpers/test-safety';

const REQUEST_TOKENS = { system: 1000, tools: 200, messages: 50 };

function llmWith(sent: string[], requestTokens: typeof REQUEST_TOKENS | undefined): LLMProvider {
  return {
    name: 'mock',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(_m, _t, opts: CompletionOptions): AsyncIterable<CompletionChunk> {
      sent.push(opts.system ?? '');
      yield { type: 'text_delta', text: 'ok' };
      yield {
        type: 'usage',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          estimatedCostUsd: 0,
          ...(requestTokens ? { requestTokens } : {}),
        },
      };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 10;
    },
  };
}

function injector(id: string, content: string, priority: number): ContextInjector {
  return { id, priority, inject: async () => ({ content, position: 'append' }) };
}

const memory: MemoryProvider = Object.assign(new NoopMemoryProvider(), {
  async prefetch() {
    return { entries: [{ key: 'MEMORY.md', content: 'remember the milk '.repeat(20) }] };
  },
});

async function run(opts: {
  requestTokens: typeof REQUEST_TOKENS | undefined;
  hooks?: DefaultHookRegistry;
  key: string;
  compaction?: { pressure?: number; maxContextTokens?: number };
  maxCompletionTokens?: number;
}) {
  const attrs: Array<Record<string, unknown> | undefined> = [];
  const llmSpans = new Set<string>();
  let seq = 0;
  const observability: AgentLoopObservability = {
    startTurnTrace: () => 'trace-1',
    endTrace: () => {},
    startSpan: (o) => {
      const id = `span-${++seq}`;
      if (o.kind === 'llm_call') llmSpans.add(id);
      return id;
    },
    endSpan: (id, _s, a) => {
      if (llmSpans.has(id)) attrs.push(a);
    },
    recordSafetyBlock: () => {},
    recordCompaction: () => {},
    recordTierEscalation: () => {},
    recordTierOverride: () => {},
    flush: () => {},
  };
  const sent: string[] = [];
  const llm = llmWith(sent, opts.requestTokens);
  const loop = new AgentLoop({
    llm,
    safety: createTestSafety(),
    observability,
    memory,
    ...(opts.hooks ? { hooks: opts.hooks } : {}),
    ...(opts.compaction ? { compaction: opts.compaction } : {}),
    injectors: [
      injector('skills', 'S'.repeat(400), 50),
      injector('memory-guidance', 'G'.repeat(300), 40),
      injector('team-memory-index:t', 'T'.repeat(100), 30),
      injector('other', 'O'.repeat(500), 20),
    ],
  });
  for await (const _e of loop.run('go', {
    sessionKey: opts.key,
    ...(opts.maxCompletionTokens !== undefined
      ? { maxCompletionTokens: opts.maxCompletionTokens }
      : {}),
  })) {
    // drain
  }
  return { attrs, sent, llm };
}

describe('llm_call span context-meter attrs', () => {
  it('stamps systemSections, contextWindow and compactAtTokens', async () => {
    const { attrs, sent, llm } = await run({ requestTokens: REQUEST_TOKENS, key: 'cli:cm-1' });
    expect(attrs).toHaveLength(1);
    const a = attrs[0];
    const sections = a?.systemSections as { memory: number; skills: number };
    expect(sections.memory).toBeGreaterThan(0);
    expect(sections.skills).toBeGreaterThan(0);
    const sentSystem = sent[0] ?? '';
    // skills 400 chars; memory = guidance 300 + team index 100 + rendered memory block.
    const memBlock = sentSystem.slice(sentSystem.indexOf('## Memory'));
    expect(sections).toEqual(
      apportionSystemSections(1000, sentSystem.length, {
        memory: 400 + memBlock.length,
        skills: 400,
      }),
    );
    expect(a?.contextWindow).toBe(200_000);
    expect(a?.compactAtTokens).toBe(meterGateTokens({ llm }, 1200));
  });

  it('omits systemSections when before_prompt_build overrides the system prompt', async () => {
    const hooks = new DefaultHookRegistry();
    hooks.registerModifying('before_prompt_build', async () => ({ overrideSystem: 'X' }));
    const { attrs } = await run({ requestTokens: REQUEST_TOKENS, hooks, key: 'cli:cm-2' });
    expect('systemSections' in (attrs[0] ?? {})).toBe(false);
    expect(attrs[0]?.contextWindow).toBe(200_000);
  });

  it('omits systemSections and compactAtTokens without requestTokens', async () => {
    const { attrs } = await run({ requestTokens: undefined, key: 'cli:cm-3' });
    expect('systemSections' in (attrs[0] ?? {})).toBe(false);
    expect('compactAtTokens' in (attrs[0] ?? {})).toBe(false);
    expect(attrs[0]?.contextWindow).toBe(200_000);
  });

  it('feeds the configured pressure, ceiling and output reserve into compactAtTokens', async () => {
    const compaction = { pressure: 0.6, maxContextTokens: 50_000 };
    const { attrs, llm } = await run({
      requestTokens: REQUEST_TOKENS,
      key: 'cli:cm-4',
      compaction,
      maxCompletionTokens: 3000,
    });
    const expected = meterGateTokens({ llm, reservedOutputTokens: 3000, ...compaction }, 1200);
    expect(attrs[0]?.compactAtTokens).toBe(expected);
    // Guards the plumbing: the defaults would give a different gate.
    expect(expected).not.toBe(meterGateTokens({ llm }, 1200));
  });
});
