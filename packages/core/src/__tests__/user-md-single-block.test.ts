// Phase 1b — USER.md double-injection fix. USER.md was injected twice: once by
// the personality-scope prefetch and again by the per-user-scope read. The
// user-scope read is canonical; the prefetched copy must be suppressed so the
// built prompt carries EXACTLY ONE "About You" block.

import type {
  CompletionChunk,
  CompletionOptions,
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

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<void> {
  for await (const _e of gen) {
    // drain
  }
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

// A memory backend that returns USER.md from BOTH the personality-scope
// prefetch AND the per-user-scope read — the exact double-supply the fix
// dedupes.
function doubleUserMemory(): MemoryProvider {
  return {
    async prefetch(): Promise<MemorySnapshot | null> {
      return {
        entries: [
          { key: 'USER.md', content: 'PREFETCHED-USER-PROFILE' },
          { key: 'MEMORY.md', content: 'project memory' },
        ],
      };
    },
    async read(key: string, ctx: MemoryContext) {
      if (key === 'USER.md' && ctx.scopeId.startsWith('user:')) {
        return { key: 'USER.md', content: 'CANONICAL-USER-PROFILE' };
      }
      return null;
    },
    async search() {
      return [];
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

async function captureSystem(userId?: string): Promise<string> {
  const captured: CompletionOptions[] = [];
  const loop = new AgentLoop({
    llm: capturingLLM(captured),
    personalities: makePersonalities(),
    safety: createTestSafety(),
    memory: doubleUserMemory(),
  });
  await collect(loop.run('hi', userId ? { userId } : {}));
  return captured[0]?.system ?? '';
}

describe('USER.md double-injection fix', () => {
  it('builds EXACTLY ONE "About You" block when the user-scope read succeeds', async () => {
    const system = await captureSystem('u1');
    const blocks = system.match(/## About You/g) ?? [];
    expect(blocks).toHaveLength(1);
  });

  it('the canonical (user-scope) profile wins; the prefetched copy is dropped', async () => {
    const system = await captureSystem('u1');
    expect(system).toContain('CANONICAL-USER-PROFILE');
    expect(system).not.toContain('PREFETCHED-USER-PROFILE');
  });
});
