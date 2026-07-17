// Phase 4 — small-window mode. A ≤32k model swaps personality memory to
// index-not-content, forces skills into index form, uses the compact prelude,
// and scales the history limit. This test drives the mode through AgentLoop and
// asserts (a) memory content is replaced by an index the agent loads via
// memory_read, (b) skills injectors see the index flag, (c) the static prefix is
// byte-stable across turns (prefix caching survives small-window mode), and
// (d) a 16k-window session completes without overflow.

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
import { createTestSafety } from './helpers/test-safety';

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const _e of gen) out.push(_e);
  return out;
}

function capturingLLM(captured: CompletionOptions[], maxContextTokens: number): LLMProvider {
  return {
    name: 'capture',
    model: 'mock-model',
    maxContextTokens,
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

const MEMORY_CONTENT = 'Project uses pnpm workspaces and extensionless imports.';
const USER_CONTENT = 'The user prefers concise answers.';

function memoryWithBoth(): MemoryProvider {
  return {
    async prefetch(): Promise<MemorySnapshot | null> {
      return {
        entries: [
          { key: 'MEMORY.md', content: MEMORY_CONTENT },
          { key: 'USER.md', content: USER_CONTENT },
        ],
      };
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

// A skills-like injector that emits different content depending on whether
// small-window mode forced the index. Proves the flag reaches injectors.
const skillsFlagInjector: ContextInjector = {
  id: 'skills',
  priority: 100,
  async inject(ctx) {
    return {
      content: ctx.skillsIndexMode
        ? '## Skills\n\nCall `get_skill(name)` to load full instructions.'
        : '## Skills\n\nFULL SKILL BODY.',
      position: 'append',
    };
  },
};

function makePersonalities() {
  const personalities = new DefaultPersonalityRegistry();
  vi.spyOn(personalities, 'getDefault').mockReturnValue({ id: 'lean', name: 'Lean', toolset: [] });
  return personalities;
}

function makeLoop(captured: CompletionOptions[], maxContextTokens = 16_000) {
  return new AgentLoop({
    llm: capturingLLM(captured, maxContextTokens),
    personalities: makePersonalities(),
    safety: createTestSafety(),
    injectors: [skillsFlagInjector],
    memory: memoryWithBoth(),
    promptBudget: {
      compactPrelude: true,
      suppressMemoryGuidance: true,
      memoryIndexMode: true,
      skillsIndexMode: true,
      memorySnapshotCap: 4_000,
    },
  });
}

describe('Phase 4 — small-window mode', () => {
  it('injects a memory index (names + memory_read), not the memory content', async () => {
    const captured: CompletionOptions[] = [];
    await collect(makeLoop(captured).run('hello'));
    const system = captured[0]?.system ?? '';

    expect(system).toContain('## Memory');
    expect(system).toContain('memory_read');
    expect(system).toContain('MEMORY.md');
    expect(system).toContain('USER.md');
    // The bulky content stays OUT of the prompt — that's the whole point.
    expect(system).not.toContain(MEMORY_CONTENT);
    expect(system).not.toContain(USER_CONTENT);
  });

  it('forces skills into index mode', async () => {
    const captured: CompletionOptions[] = [];
    await collect(makeLoop(captured).run('hello'));
    const system = captured[0]?.system ?? '';
    expect(system).toContain('get_skill(name)');
    expect(system).not.toContain('FULL SKILL BODY.');
  });

  it('keeps the static prefix byte-identical across two turns (caching intact)', async () => {
    const captured: CompletionOptions[] = [];
    const loop = makeLoop(captured);
    await collect(loop.run('hello'));
    await collect(loop.run('hello'));
    expect(captured).toHaveLength(2);
    const first = captured[0]?.system ?? '';
    const second = captured[1]?.system ?? '';
    expect(first).toBe(second);
  });

  it('completes a 16k-window turn without overflow', async () => {
    const captured: CompletionOptions[] = [];
    const events = await collect(makeLoop(captured, 16_000).run('hello'));
    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });
});
