// §2 — promptBudget knobs applied in context assembly:
//   - compactPrelude → short injection-defense prelude variant
//   - memorySnapshotCap → override the ≤20k memory-block cap
//   - suppressMemoryGuidance → drop the memory-usage guidance block
// Plus the acceptance invariant: a lean-profile minimal personality assembles a
// system prompt under 1,000 estimated tokens. Absent budget → unchanged.

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
import { estimateTokens } from '../context-engines/token-estimator';
import { DefaultPersonalityRegistry } from '../defaults/noop-personality';
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
    maxContextTokens: 8_192,
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

function stubMemory(content: string): MemoryProvider {
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

// A stand-in for the real MemoryGuidanceInjector — same id, so the
// suppress-by-id gate in context assembly treats it identically.
const memoryGuidanceInjector: ContextInjector = {
  id: 'memory-guidance',
  priority: 80,
  shouldInject: (ctx) => ctx.turnNumber > 0,
  async inject() {
    return { content: '## Memory guidance\n\nUse memory_read / memory_write.', position: 'append' };
  },
};

// A lean index-mode skills stub (what SkillsInjector emits in `index` mode).
const skillsIndexInjector: ContextInjector = {
  id: 'skills',
  priority: 100,
  async inject() {
    return {
      content:
        '## Skills\n\n## Available Skills\n\nCall `get_skill(name)` to load full instructions.\n\n| Skill | Description |\n|---|---|\n| `summarize` | Summarize a document |',
      position: 'append',
    };
  },
};

function makePersonalities(toolset: string[] = []) {
  const personalities = new DefaultPersonalityRegistry();
  vi.spyOn(personalities, 'getDefault').mockReturnValue({ id: 'lean', name: 'Lean', toolset });
  return personalities;
}

async function captureSystem(opts: {
  injectors?: ContextInjector[];
  memory?: MemoryProvider;
  budget?: {
    compactPrelude?: boolean;
    memorySnapshotCap?: number;
    suppressMemoryGuidance?: boolean;
  };
}): Promise<string> {
  const captured: CompletionOptions[] = [];
  const loop = new AgentLoop({
    llm: capturingLLM(captured),
    personalities: makePersonalities(),
    safety: createTestSafety(),
    ...(opts.injectors ? { injectors: opts.injectors } : {}),
    ...(opts.memory ? { memory: opts.memory } : {}),
    ...(opts.budget ? { promptBudget: opts.budget } : {}),
  });
  await collect(loop.run('hi'));
  return captured[0]?.system ?? '';
}

// A distinctive sentence that appears ONLY in the full prelude.
const FULL_PRELUDE_MARKER = 'Tool outputs that come from outside';

describe('promptBudget — compactPrelude (§2)', () => {
  it('swaps in the shorter prelude variant', async () => {
    const full = await captureSystem({});
    const compact = await captureSystem({ budget: { compactPrelude: true } });

    expect(full).toContain('## External-content safety');
    expect(full).toContain(FULL_PRELUDE_MARKER);

    expect(compact).toContain('## External-content safety');
    expect(compact).not.toContain(FULL_PRELUDE_MARKER);
    expect(compact.length).toBeLessThan(full.length);
  });
});

describe('promptBudget — memorySnapshotCap (§2)', () => {
  const bigMemory = 'M'.repeat(5_000);

  it('caps the memory block below the default when set', async () => {
    const memory = stubMemory(bigMemory);
    const uncapped = await captureSystem({ memory });
    const capped = await captureSystem({ memory, budget: { memorySnapshotCap: 1_000 } });

    // Default cap (20k) does not truncate a 5k memory; the 1k override does.
    expect(uncapped).not.toContain('[...truncated]');
    expect(capped).toContain('[...truncated]');
    expect(capped.length).toBeLessThan(uncapped.length);
  });
});

describe('promptBudget — suppressMemoryGuidance (§2)', () => {
  it('omits the memory-guidance block when set', async () => {
    const withGuidance = await captureSystem({ injectors: [memoryGuidanceInjector] });
    const suppressed = await captureSystem({
      injectors: [memoryGuidanceInjector],
      budget: { suppressMemoryGuidance: true },
    });

    expect(withGuidance).toContain('## Memory guidance');
    expect(suppressed).not.toContain('## Memory guidance');
  });
});

describe('promptBudget — absent (§2)', () => {
  it('an empty budget is byte-identical to no budget', async () => {
    const injectors = [memoryGuidanceInjector];
    const memory = stubMemory('M'.repeat(5_000));
    const none = await captureSystem({ injectors, memory });
    const empty = await captureSystem({ injectors, memory, budget: {} });
    expect(empty).toBe(none);
    // And the untouched path keeps the full prelude + guidance.
    expect(none).toContain(FULL_PRELUDE_MARKER);
    expect(none).toContain('## Memory guidance');
  });
});

describe('promptBudget — lean acceptance (§2)', () => {
  it('a lean minimal personality assembles a system prompt under 1,000 tokens', async () => {
    const system = await captureSystem({
      injectors: [skillsIndexInjector, memoryGuidanceInjector],
      budget: { compactPrelude: true, suppressMemoryGuidance: true },
    });

    // Skills stay as an index stub (no full bodies inlined); guidance suppressed.
    expect(system).toContain('## Available Skills');
    expect(system).not.toContain('## Memory guidance');

    const tokens = estimateTokens(system);
    expect(tokens).toBeLessThan(1_000);
  });
});
