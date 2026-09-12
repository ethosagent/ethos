// `RunOptions.skipMemoryPrefetch` — the enforcer for "this turn touches no
// memory".
//
// A host that serves a bounded personality to an outside caller has to be able
// to say memory is withheld and have that be TRUE of the wire, not of a
// rendering step downstream. So the flag is checked at the one place memory
// enters a turn — Step 5 of `agent-loop/stages/context-assembly` — and it
// covers all three reads that step can make: the personality-scope `prefetch`,
// the `search` fallback taken when a provider returns null from it, and the
// `user:<userId>` scope `read` of USER.md.
//
// The assertion is on the PROVIDER, not on the prompt text: a prompt with no
// memory section but a provider call behind it would still have read the data.

import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  MemoryEntry,
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

const MEMORY_CONTENT = 'Project uses pnpm workspaces.';
const USER_CONTENT = 'The user prefers terse answers.';
const SEARCH_CONTENT = 'Semantic hit that should never be reached.';

/** Counts every read method so the test can assert on the provider, not the prompt. */
function spyMemory(opts: { prefetchReturns: MemorySnapshot | null }): MemoryProvider & {
  calls: { prefetch: number; read: number; search: number };
} {
  const calls = { prefetch: 0, read: 0, search: 0 };
  return {
    calls,
    async prefetch(): Promise<MemorySnapshot | null> {
      calls.prefetch++;
      return opts.prefetchReturns;
    },
    async read(key: string): Promise<MemoryEntry | null> {
      calls.read++;
      return key === 'USER.md' ? { key, content: USER_CONTENT } : null;
    },
    async search() {
      calls.search++;
      return [{ key: 'NOTE.md', content: SEARCH_CONTENT }];
    },
    async sync() {},
    async list() {
      return [];
    },
  };
}

function makePersonalities() {
  const personalities = new DefaultPersonalityRegistry();
  vi.spyOn(personalities, 'getDefault').mockReturnValue({ id: 'lean', name: 'Lean', toolset: [] });
  return personalities;
}

function makeLoop(memory: MemoryProvider, captured: CompletionOptions[]): AgentLoop {
  return new AgentLoop({
    llm: capturingLLM(captured),
    personalities: makePersonalities(),
    safety: createTestSafety(),
    memory,
  });
}

describe('RunOptions.skipMemoryPrefetch', () => {
  it('calls no provider read method and builds no memory section', async () => {
    const memory = spyMemory({
      prefetchReturns: { entries: [{ key: 'MEMORY.md', content: MEMORY_CONTENT }] },
    });
    const captured: CompletionOptions[] = [];

    await collect(
      makeLoop(memory, captured).run('hello', { userId: 'u1', skipMemoryPrefetch: true }),
    );

    expect(memory.calls).toEqual({ prefetch: 0, read: 0, search: 0 });
    const system = captured[0]?.system ?? '';
    expect(system).not.toContain('## Memory');
    expect(system).not.toContain(MEMORY_CONTENT);
    expect(system).not.toContain(USER_CONTENT);
  });

  it('skips the `user:` scope read even though `userId` is set', async () => {
    // `userId` alone drives a `read('USER.md')` against `user:<id>`. The flag
    // has to cover that read too, or "no memory" would still leak the profile.
    const memory = spyMemory({ prefetchReturns: null });
    const captured: CompletionOptions[] = [];

    await collect(
      makeLoop(memory, captured).run('hello', { userId: 'u1', skipMemoryPrefetch: true }),
    );

    expect(memory.calls.read).toBe(0);
    expect(captured[0]?.system ?? '').not.toContain('About You');
  });

  it('skips the null-prefetch `search` fallback', async () => {
    // A provider returning null from `prefetch` normally falls back to a
    // semantic `search` on the user text. That is a third read path.
    const memory = spyMemory({ prefetchReturns: null });
    const captured: CompletionOptions[] = [];

    await collect(makeLoop(memory, captured).run('hello', { skipMemoryPrefetch: true }));

    expect(memory.calls.search).toBe(0);
    expect(captured[0]?.system ?? '').not.toContain(SEARCH_CONTENT);
  });

  it('without the flag, behaviour is unchanged — prefetch and the user read both run', async () => {
    const memory = spyMemory({
      prefetchReturns: { entries: [{ key: 'MEMORY.md', content: MEMORY_CONTENT }] },
    });
    const captured: CompletionOptions[] = [];

    await collect(makeLoop(memory, captured).run('hello', { userId: 'u1' }));

    expect(memory.calls.prefetch).toBe(1);
    expect(memory.calls.read).toBe(1);
    const system = captured[0]?.system ?? '';
    expect(system).toContain('## Memory');
    expect(system).toContain(MEMORY_CONTENT);
    expect(system).toContain(USER_CONTENT);
  });

  it('without the flag, a null prefetch still falls back to search', async () => {
    const memory = spyMemory({ prefetchReturns: null });
    const captured: CompletionOptions[] = [];

    await collect(makeLoop(memory, captured).run('hello'));

    expect(memory.calls.search).toBe(1);
    expect(captured[0]?.system ?? '').toContain(SEARCH_CONTENT);
  });
});
