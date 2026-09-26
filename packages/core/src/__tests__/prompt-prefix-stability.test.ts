// §6 — prefix-cache-friendly prompt ordering, locked in.
//
// Contract: the system prompt is STATIC-FIRST (injection-defense prelude →
// SOUL.md → priority injectors) with the DYNAMIC sections (memory snapshot,
// progressive file-context, team topic index) at the TAIL. No per-turn text
// (dates, timestamps, turn counters) may leak anywhere in the prompt, or the
// static prefix stops being byte-stable and prefix caching (Anthropic cache
// breakpoints, vLLM --enable-prefix-caching, Ollama keep-alive) is defeated.
//
// This test drives two consecutive turns in the SAME session (so the internal
// turn counter genuinely advances) with UNCHANGED memory and asserts the
// static prefix is byte-identical across turns.

import type {
  CompletionChunk,
  CompletionOptions,
  ContextInjector,
  LLMProvider,
  MemoryContext,
  MemoryProvider,
  MemorySnapshot,
  Message,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
import { DefaultPersonalityRegistry } from '../defaults/noop-personality';
import { markServerCompaction } from '../providers/chained-provider';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const _e of gen) out.push(_e);
  return out;
}

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

// Constant memory — the dynamic tail. Its content never changes across turns,
// so an unchanged tail is what makes full-prompt equality the strongest form
// of the stability assertion. Digit-free so the no-date/no-timestamp guards
// can be applied to the whole prompt without a false positive.
function constantMemory(content: string): MemoryProvider {
  return {
    async prefetch(): Promise<MemorySnapshot | null> {
      return { entries: [{ key: 'MEMORY.md', content }] };
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
}

// A static priority injector standing in for the real skills/index injectors.
// Its `shouldInject` reads `turnNumber` (which advances between turns) but its
// content is constant — the exact shape a well-behaved injector must have to
// keep the prefix stable.
const staticInjector: ContextInjector = {
  id: 'skills',
  priority: 100,
  shouldInject: (ctx) => ctx.turnNumber > 0,
  async inject() {
    return {
      content: '## Skills\n\nCall `get_skill(name)` to load full instructions.',
      position: 'append',
    };
  },
};

function makePersonalities() {
  const personalities = new DefaultPersonalityRegistry();
  vi.spyOn(personalities, 'getDefault').mockReturnValue({ id: 'lean', name: 'Lean', toolset: [] });
  return personalities;
}

const MEMORY_CONTENT = 'Project uses pnpm workspaces and extensionless imports.';
const PRELUDE_MARKER = 'External-content safety';

async function runTwoTurns(): Promise<{ first: string; second: string }> {
  const captured: CompletionOptions[] = [];
  const loop = new AgentLoop({
    llm: capturingLLM(captured),
    personalities: makePersonalities(),
    safety: createTestSafety(),
    injectors: [staticInjector],
    memory: constantMemory(MEMORY_CONTENT),
  });
  // Same input both turns; the only thing that changes internally is the turn
  // counter (history grows), which is exactly the per-turn variation under test.
  await collect(loop.run('hello'));
  await collect(loop.run('hello'));
  expect(captured).toHaveLength(2);
  return { first: captured[0]?.system ?? '', second: captured[1]?.system ?? '' };
}

// Everything before the memory tail is the static prefix. `## Memory` only
// appears where the memory snapshot is rendered (no memory-guidance injector
// is wired here), so it is an unambiguous boundary.
function staticPrefix(system: string): string {
  const idx = system.indexOf('## Memory');
  return idx === -1 ? system : system.slice(0, idx);
}

describe('§6 — prefix-cache-friendly prompt ordering', () => {
  it('produces a byte-identical static prefix across two consecutive turns', async () => {
    const { first, second } = await runTwoTurns();

    // Memory is unchanged, so the whole prompt (prefix + tail) is byte-stable.
    expect(first).toBe(second);

    // And the static prefix in isolation is byte-identical.
    const p1 = staticPrefix(first);
    const p2 = staticPrefix(second);
    expect(p1).toBe(p2);
    // The prefix genuinely precedes the dynamic tail — no memory content leaked
    // into the static region.
    expect(p1).not.toContain(MEMORY_CONTENT);
    expect(p1.length).toBeGreaterThan(0);
  });

  it('keeps the static sections first and the memory snapshot at the tail', async () => {
    const { first } = await runTwoTurns();

    const preludeAt = first.indexOf(PRELUDE_MARKER);
    const injectorAt = first.indexOf('## Skills');
    const memoryAt = first.indexOf('## Memory');

    expect(preludeAt).toBeGreaterThanOrEqual(0);
    expect(injectorAt).toBeGreaterThan(preludeAt);
    expect(memoryAt).toBeGreaterThan(injectorAt);
    // Memory is the final section.
    expect(first.trimEnd().endsWith(MEMORY_CONTENT)).toBe(true);
  });

  it('never emits per-turn dynamic text (dates, clock times, turn counters)', async () => {
    const { first } = await runTwoTurns();
    const prefix = staticPrefix(first);

    // These would each break prefix caching if they leaked into the prompt.
    expect(prefix).not.toMatch(/\d{4}-\d{2}-\d{2}/); // ISO date
    expect(prefix).not.toMatch(/\b\d{1,2}:\d{2}:\d{2}\b/); // clock time
    expect(prefix).not.toMatch(/\bturn\s*#?\s*\d+/i); // turn counter
    // The whole prompt is digit-free here (memory content is digit-free), so a
    // stray timestamp anywhere would surface as an unexpected digit.
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

// reach-and-containment Part 1 — with on-demand tool loading active, a tool
// loaded in turn 1 stays at the tail of the tools array, and turn 2 (no search)
// sends the array byte-identically to turn 1's final step (D1-2/D1-11: one
// prefix miss at the load, reused thereafter).
describe('§6 — tools array stability under on-demand tool loading', () => {
  it('turn 2 sends the same tools array as turn 1 after a load', async () => {
    const capturedTools: unknown[][] = [];
    let call = 0;
    const llm: LLMProvider = {
      name: 'capture',
      model: 'mock-model',
      maxContextTokens: 200_000,
      supportsCaching: false,
      supportsThinking: false,
      async *complete(_m: Message[], tools: unknown[]): AsyncIterable<CompletionChunk> {
        capturedTools.push(structuredClone(tools));
        call++;
        if (call === 1) {
          yield { type: 'tool_use_start', toolCallId: 's1', toolName: 'tool_search' };
          yield {
            type: 'tool_use_end',
            toolCallId: 's1',
            inputJson: JSON.stringify({ query: 'weather' }),
          };
          yield { type: 'done', finishReason: 'tool_use' };
          return;
        }
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'done', finishReason: 'end_turn' };
      },
      async countTokens() {
        return 1;
      },
    };
    const tools = new DefaultToolRegistry();
    for (const [name, description] of [
      ['read_file', 'Read a file'],
      ['mcp__wx__forecast', 'Weather forecast'],
      ['mcp__wx__alerts', 'Severe alerts'],
    ]) {
      tools.register({
        name,
        description,
        schema: { type: 'object' },
        capabilities: {},
        execute: async () => ({ ok: true, value: 'x' }),
      });
    }
    const personalities = new DefaultPersonalityRegistry();
    vi.spyOn(personalities, 'getDefault').mockReturnValue({
      id: 'lean',
      name: 'Lean',
      toolset: ['read_file'],
      mcp_servers: ['wx'],
    });
    const loop = new AgentLoop({
      llm,
      tools,
      personalities,
      safety: createTestSafety(),
      toolLoading: () => true,
    });
    await collect(loop.run('weather?'));
    await collect(loop.run('again'));

    expect(capturedTools).toHaveLength(3);
    const turn1Final = JSON.stringify(capturedTools[1]);
    expect(turn1Final).toContain('mcp__wx__forecast');
    expect(JSON.stringify(capturedTools[2])).toBe(turn1Final);
  });
});

// openclaw-9.5-adoption item 7 — server-side compaction rewrites the MESSAGE
// history (a compaction block the API replays in place of what came before it),
// never the system prompt. With the provider flagged and a compaction block in
// turn 1, turn 2's system prompt is still byte-identical.
describe('§6 — prefix stability with server-side compaction on', () => {
  it('a compaction block in turn 1 leaves turn 2 system prompt byte-identical', async () => {
    const captured: CompletionOptions[] = [];
    const replayed: Message[][] = [];
    let call = 0;
    const llm = markServerCompaction({
      ...capturingLLM(captured),
      async *complete(
        m: Message[],
        _t: unknown,
        opts: CompletionOptions,
      ): AsyncIterable<CompletionChunk> {
        captured.push(opts);
        replayed.push(m.slice());
        if (call++ === 0) {
          yield { type: 'compaction', content: 'summary', encryptedContent: 'opaque' };
        }
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'done', finishReason: 'end_turn' };
      },
    } satisfies LLMProvider);
    const loop = new AgentLoop({
      llm,
      personalities: makePersonalities(),
      safety: createTestSafety(),
      injectors: [staticInjector],
      memory: constantMemory(MEMORY_CONTENT),
    });
    await collect(loop.run('hello'));
    await collect(loop.run('hello'));
    expect(captured).toHaveLength(2);
    expect(captured[1]?.system).toBe(captured[0]?.system);
    expect(staticPrefix(captured[1]?.system ?? '').length).toBeGreaterThan(0);
    // The block did reach turn 2 — in the messages, not the prompt.
    expect(replayed[1]?.length).toBeGreaterThan(replayed[0]?.length ?? 0);
  });
});
