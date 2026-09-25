// Compaction targets use the same units as the engines that consume them.
//
// Every shipped context engine compares `estimate(currentSystem) +
// estimate(messages)` against `targetTokens` — a whole-request budget. Once a
// request had measured the static slice (turn 2+), `maybeCompact` passed
// `0.7 × (window − static)` instead: a MESSAGES-ONLY budget, from which the
// engine then subtracted the system prompt a second time. On a 32k window with
// a ~20k-token static prefix the target sat below the prefix, and drop_oldest
// dropped all older history even when most of it would fit.
//
// The unmeasured case is not only turn 1: `SQLiteSessionStore` did not persist
// `usage.requestTokens` (it does now — `extensions/session-sqlite/src/__tests__/
// request-tokens.test.ts`), and a provider may report no split. There the target counted the whole prefix as compactible and
// dropped all older history the same way. Context assembly now passes the tool
// schemas (`CompactionDeps.toolSchemas`), and an unmeasured static slice is
// estimated from system prompt + tool schemas, so both cases get one target.
//
// Pins: `compactionTarget` and `maybeCompact` in
// `packages/core/src/agent-loop/compaction.ts`, and the `toolSchemas` context
// assembly passes (`stages/context-assembly.ts`).

import type {
  CompletionChunk,
  CompletionOptions,
  ContextEngineCompactInput,
  LLMProvider,
  Message,
  PersonalityConfig,
  Tool,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
import {
  compactionTarget,
  effectiveGate,
  evaluateGate,
  gateThreshold,
  maybeCompact,
} from '../agent-loop/compaction';
import { DropOldestEngine } from '../context-engines/drop-oldest';
import { DefaultContextEngineRegistry } from '../context-engines/registry';
import { estimateMessagesTokens, estimateTokens } from '../context-engines/token-estimator';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { DefaultHookRegistry } from '../hook-registry';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

const personality = { id: 'p', name: 'p' } as PersonalityConfig;
const meta = { sessionId: 's1', sessionKey: 'cli:s1', turnNumber: 2, lastCompactionTurn: 0 };
const sessionMock = {
  recordCompression: async () => ({}),
  updateUsage: async () => {},
  recordCompactionTurn: async () => {},
  // biome-ignore lint/suspicious/noExplicitAny: standard test mock
} as any;

const user = (content: string): Message => ({ role: 'user', content });

// 32k window, default 4096 output reserve → 28672 usable. A ~20k-token system
// prompt (80,000 chars), ten 1000-token older messages and a 100-token question.
const WINDOW = 32_768;
const SYSTEM = 's'.repeat(80_000);
const HISTORY = Array.from({ length: 10 }, (_, i) => user(`${i}`.repeat(4_000)));
const QUESTION = user('?'.repeat(400));

function dropOldest(): DefaultContextEngineRegistry {
  const r = new DefaultContextEngineRegistry();
  r.register(new DropOldestEngine());
  return r;
}

function targetSpy(): { registry: DefaultContextEngineRegistry; seen: number[] } {
  const seen: number[] = [];
  const registry = new DefaultContextEngineRegistry();
  registry.register({
    name: 'drop_oldest',
    async compact(opts: ContextEngineCompactInput) {
      seen.push(opts.targetTokens);
      return new DropOldestEngine().compact(opts);
    },
  });
  return { registry, seen };
}

describe('maybeCompact — turn 2+ target is a whole-request budget', () => {
  it('keeps the newest older messages that fit beside a large measured static prefix', async () => {
    // Measured static = 20,000 (the system prompt). Gate: 20000 + 0.8 × 8672 =
    // 26937 < ~30100 → fires. Whole target: 20000 + floor(0.7 × 8672) = 26070,
    // minus the question's 100 → 25970. drop_oldest counts the 20000-token
    // system prompt itself, so 5970 tokens of history fit: the 5 newest.
    // Before the fix the target was floor(0.7 × 8672) − 100 = 5970, below the
    // system prompt alone, and every older message was dropped.
    const result = await maybeCompact(
      {
        // biome-ignore lint/suspicious/noExplicitAny: standard test mock
        llm: { maxContextTokens: WINDOW } as any,
        contextEngines: dropOldest(),
        session: sessionMock,
        staticTokens: 20_000,
      },
      [...HISTORY, QUESTION],
      SYSTEM,
      personality,
      meta,
    );
    expect(result.messages).toEqual([...HISTORY.slice(5), QUESTION]);
    expect(result.notice?.droppedCount).toBe(5);
  });

  it('subtracts the part of the measured static slice the engine cannot see (tool schemas)', async () => {
    // Measured static = 21,000: the 20,000-token system prompt + 1,000 of tool
    // schemas, which the engine never counts. Whole target: 21000 +
    // floor(0.7 × 7672) = 26370; the engine sees 1,000 fewer static tokens than
    // the provider will send, so it gets 26370 − 1000 − 100 = 25270.
    const { registry, seen } = targetSpy();
    const result = await maybeCompact(
      {
        // biome-ignore lint/suspicious/noExplicitAny: standard test mock
        llm: { maxContextTokens: WINDOW } as any,
        contextEngines: registry,
        session: sessionMock,
        staticTokens: 21_000,
      },
      [...HISTORY, QUESTION],
      SYSTEM,
      personality,
      meta,
    );
    expect(seen).toEqual([25_270]);
    // The request the provider will actually receive lands on the whole target.
    const sent = 21_000 + estimateMessagesTokens(result.messages);
    expect(sent).toBeLessThanOrEqual(26_370);
    expect(result.messages).toEqual([...HISTORY.slice(5), QUESTION]);
  });

  it('turn 1 and turn 2+ targets are the same gate arithmetic, in engine units', async () => {
    const q = estimateMessagesTokens(QUESTION);
    const turn1 = targetSpy();
    await maybeCompact(
      {
        // biome-ignore lint/suspicious/noExplicitAny: standard test mock
        llm: { maxContextTokens: WINDOW } as any,
        contextEngines: turn1.registry,
        session: sessionMock,
      },
      [...HISTORY, QUESTION],
      SYSTEM,
      personality,
      { ...meta, turnNumber: 1 },
    );
    const turn2 = targetSpy();
    await maybeCompact(
      {
        // biome-ignore lint/suspicious/noExplicitAny: standard test mock
        llm: { maxContextTokens: WINDOW } as any,
        contextEngines: turn2.registry,
        session: sessionMock,
        staticTokens: estimateTokens(SYSTEM),
      },
      [...HISTORY, QUESTION],
      SYSTEM,
      personality,
      meta,
    );
    const g1 = evaluateGate({ llm: { maxContextTokens: WINDOW } }, [], SYSTEM);
    const g2 = evaluateGate(
      { llm: { maxContextTokens: WINDOW }, staticTokens: estimateTokens(SYSTEM) },
      [],
      SYSTEM,
    );
    // Both turns hand the engine `gateThreshold(g, 0.7)` less the current turn:
    // on turn 1 nothing is measured, so that is floor(0.7 × 28672) = 20070 —
    // unchanged; on turn 2 the measured slice equals what the engine counts.
    expect(turn1.seen).toEqual([gateThreshold(g1, 0.7) - q]);
    expect(turn1.seen).toEqual([20_070 - q]);
    expect(turn2.seen).toEqual([gateThreshold(g2, 0.7) - q]);
    // Each target lands BELOW its own turn's pressure gate, so a compaction
    // that reaches it does not re-trip the gate on the next turn, and measuring
    // the static slice never makes compaction more aggressive than not.
    for (const [seen, g] of [
      [turn1.seen, g1],
      [turn2.seen, g2],
    ] as const) {
      expect((seen[0] ?? 0) + q).toBeLessThan(effectiveGate(g, 0.8));
    }
    expect(turn2.seen[0] ?? 0).toBeGreaterThanOrEqual(turn1.seen[0] ?? 0);
  });

  it('an unmeasured turn given its tool schemas gets the same target as a measured one', async () => {
    // 4,000 chars of tool schemas = 1,000 tokens. Unmeasured, the static slice
    // is estimated as ceil((80000 + 4000) / 4) = 21,000 — the same figure the
    // measured case above carries — so both hand the engine 25,270.
    const toolSchemas = 't'.repeat(4_000);
    const unmeasured = targetSpy();
    const result = await maybeCompact(
      {
        // biome-ignore lint/suspicious/noExplicitAny: standard test mock
        llm: { maxContextTokens: WINDOW } as any,
        contextEngines: unmeasured.registry,
        session: sessionMock,
        toolSchemas,
      },
      [...HISTORY, QUESTION],
      SYSTEM,
      personality,
      { ...meta, turnNumber: 1 },
    );
    const measured = targetSpy();
    await maybeCompact(
      {
        // biome-ignore lint/suspicious/noExplicitAny: standard test mock
        llm: { maxContextTokens: WINDOW } as any,
        contextEngines: measured.registry,
        session: sessionMock,
        staticTokens: 21_000,
        toolSchemas,
      },
      [...HISTORY, QUESTION],
      SYSTEM,
      personality,
      meta,
    );
    expect(unmeasured.seen).toEqual([25_270]);
    expect(measured.seen).toEqual(unmeasured.seen);
    expect(result.messages).toEqual([...HISTORY.slice(5), QUESTION]);
  });

  it('caps the whole-request target at the target fraction of the absolute ceiling', () => {
    // 1M window, 300k ceiling, 50k measured static of which the engine sees
    // none (empty system prompt): whole target = min(50000 + 0.7 × 946000,
    // 0.7 × 300000) = 210000; the engine gets 210000 − 50000 = 160000, so
    // static + kept history stays at 210k instead of the old 260k.
    const g = evaluateGate(
      { llm: { maxContextTokens: 1_000_000 }, reservedOutputTokens: 0, staticTokens: 50_000 },
      [],
      '',
    );
    expect(compactionTarget(g, 0.7, '', 300_000)).toBe(160_000);
    // No measured static and no system prompt → byte-identical to before.
    const g0 = evaluateGate(
      { llm: { maxContextTokens: 1_000_000 }, reservedOutputTokens: 0 },
      [],
      '',
    );
    expect(compactionTarget(g0, 0.7, '', 300_000)).toBe(210_000);
  });
});

// ---------------------------------------------------------------------------
// AgentLoop — turn 3 of a 32k session with a ~20k-token static prefix
// ---------------------------------------------------------------------------

interface Captured {
  messages: Message[];
  system: string;
}

/** Reports what a local server would: real input tokens and, when `split`,
 *  the static split. */
function measuringLLM(calls: Captured[], split: boolean): LLMProvider {
  return {
    name: 'ollama',
    model: 'llama3.2',
    maxContextTokens: WINDOW,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(messages: Message[], toolDefs, opts?: CompletionOptions) {
      const system = opts?.system ?? '';
      calls.push({ messages: structuredClone(messages), system });
      const sys = estimateTokens(system);
      const msgs = estimateMessagesTokens(messages);
      const tools = estimateTokens(JSON.stringify(toolDefs));
      const chunks: CompletionChunk[] = [
        { type: 'text_delta', text: 'ok' },
        {
          type: 'usage',
          usage: {
            inputTokens: sys + tools + msgs,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            estimatedCostUsd: 0,
            ...(split ? { requestTokens: { system: sys, tools, messages: msgs } } : {}),
          },
        },
        { type: 'done', finishReason: 'end_turn' },
      ];
      for (const c of chunks) yield c;
    },
    async countTokens() {
      return 10;
    },
  };
}

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const texts = (c: Captured | undefined): string[] =>
  (c?.messages ?? []).map((m) => (typeof m.content === 'string' ? m.content : ''));

/** ~4k chars of tool schema, counted in the static prefix every request sends. */
const schemaTool: Tool = {
  name: 'schema_tool',
  description: 'd'.repeat(4_000),
  schema: { type: 'object' },
  capabilities: {},
  execute: async () => ({ ok: true, value: 'x' }),
};

describe('AgentLoop — older history survives compaction beside a large static prefix', () => {
  it.each([
    { name: 'measured static slice, no tools', split: true, withTool: false },
    { name: 'unmeasured static slice (no split), with tools', split: false, withTool: true },
  ])(
    'turn 3 keeps the newest older turn that fits, and the question — $name',
    async ({ split, withTool }) => {
      const hooks = new DefaultHookRegistry();
      hooks.registerModifying('before_prompt_build', async () => ({
        appendSystem: 'p'.repeat(80_000),
      }));
      const tools = new DefaultToolRegistry();
      if (withTool) tools.register(schemaTool);
      const calls: Captured[] = [];
      const loop = new AgentLoop({
        llm: measuringLLM(calls, split),
        session: new InMemorySessionStore(),
        safety: createTestSafety(),
        hooks,
        tools,
      });
      const t1 = `one ${'a'.repeat(9_600)}`;
      const t2 = `two ${'b'.repeat(9_600)}`;
      const t3 = `three ${'c'.repeat(9_600)}`;
      await drain(loop.run(t1, { sessionKey: 'cli:units' }));
      await drain(loop.run(t2, { sessionKey: 'cli:units' }));
      const events = await drain(loop.run(t3, { sessionKey: 'cli:units' }));

      expect(calls).toHaveLength(3);
      // Compaction ran on turn 3 (the in-chat notice) …
      expect(events.some((e) => e.type === 'tool_progress' && e.toolName === '_compaction')).toBe(
        true,
      );
      const sent = texts(calls[2]);
      // … dropped the oldest turn, kept the newest older turn that fits, and the
      // question. Before the fix the request carried the question alone.
      expect(sent.at(-1)).toBe(t3);
      expect(sent).toContain(t2);
      expect(sent).not.toContain(t1);
    },
  );
});
