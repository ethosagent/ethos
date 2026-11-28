// R5 (plan world-model Task 4.4): the world context lives in the dynamic tail,
// after `## Memory`, outside the static prefix. A real AgentLoop with the real
// WorldContextInjector over a minimal in-test service: two turns that change
// the world block (Ravi vs Priya) keep a byte-identical static prefix
// (`slice(0, indexOf('## Memory'))`). The loop is driven as in
// packages/core/src/__tests__/prompt-prefix-stability.test.ts.

import { AgentLoop, DefaultPersonalityRegistry } from '@ethosagent/core';
import type {
  AgentEvent,
  CompletionChunk,
  CompletionOptions,
  ContextInjector,
  LLMProvider,
  MemoryContext,
  MemoryProvider,
  MemorySnapshot,
  Message,
} from '@ethosagent/types';
import { WORLD_CONTEXT_HEADING, WorldContextInjector } from '@ethosagent/world-service';
import { describe, expect, it, vi } from 'vitest';
import { createTestSafety } from './helpers/wiring-test-safety';

type Service = ConstructorParameters<typeof WorldContextInjector>[0]['service'];

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<void> {
  for await (const _e of gen) {
    // drained to exhaustion
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

const section = (id: string, priority: number, content: string): ContextInjector => ({
  id,
  priority,
  async inject() {
    return { content, position: 'append' };
  },
});

const MEMORY_CONTENT = 'Notes about the team stay here.';

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

/** Everything before `## Memory`. Per-turn world text must not sit in here. */
function staticPrefix(system: string): string {
  return system.slice(0, system.indexOf('## Memory'));
}

const facts = { ravi: 'Ravi owns billing', priya: 'Priya leads platform' } as const;

// One shareable world; an entity "matches" when its name is the queried term.
const service: Service = {
  visible: async () => [
    {
      id: 'world:acme',
      tag: 'acme',
      alias: null,
      mode: 'read',
      audience: 'shareable',
      shared: true,
    },
  ],
  query: async (_c, _w, q) => {
    const key = q.kind === 'entities' ? q.text : undefined;
    const text = key === 'ravi' || key === 'priya' ? facts[key] : undefined;
    if (text === undefined || key === undefined) {
      return { entities: [], attributes: [], edges: [], truncated: false };
    }
    return {
      entities: [
        {
          id: key,
          world: 'world:acme',
          type: 'Person',
          name: key,
          aliases: [],
          recordedAt: '2026-01-01T00:00:00.000Z',
          retiredAt: null,
          sourceRef: 'seed',
          author: 'user',
          mergedInto: null,
          tag: 'acme',
          displayTag: `acme:${key}`,
        },
      ],
      attributes: [
        {
          id: `${key}-a`,
          world: 'world:acme',
          entityId: key,
          key: 'note',
          value: text,
          validFrom: '2026-03-01',
          validTo: null,
          recordedAt: '2026-01-01T00:00:00.000Z',
          retiredAt: null,
          sourceRef: 'seed',
          author: 'user',
          confidence: 1,
          tag: 'acme',
        },
      ],
      edges: [],
      truncated: false,
    };
  },
  neighbours: async () => ({ entities: [], attributes: [], edges: [], truncated: false }),
};

describe('R5 world context prefix', () => {
  it('R5 graph context is tail only', async () => {
    const captured: CompletionOptions[] = [];
    const personalities = new DefaultPersonalityRegistry();
    vi.spyOn(personalities, 'getDefault').mockReturnValue({
      id: 'lean',
      name: 'Lean',
      toolset: [],
    });
    const safety = createTestSafety();
    const loop = new AgentLoop({
      llm: capturingLLM(captured),
      personalities,
      safety,
      memory: constantMemory(MEMORY_CONTENT),
      injectors: [
        section('skills', 100, '## Skills\n\nstatic skills index'),
        section('low', 30, '## Low\n\nlowest shipped injector'),
        new WorldContextInjector({
          service,
          sanitize: safety.injection.sanitize,
          maxChars: 2400,
          hops: 2,
        }),
      ],
    });

    await drain(loop.run('what about ravi'));
    await drain(loop.run('what about ravi'));
    await drain(loop.run('what about priya'));
    expect(captured).toHaveLength(3);
    const [t1, t2, t3] = captured.map((c) => c.system ?? '');

    expect(t1).toBe(t2);

    const worldAt = (s: string): number => s.indexOf(WORLD_CONTEXT_HEADING);
    const memoryAt = (s: string): number => s.indexOf('## Memory');
    expect(worldAt(t1)).toBeGreaterThan(memoryAt(t1));
    expect(memoryAt(t1)).toBeGreaterThan(t1.indexOf('## Low'));
    expect(t1.indexOf('## Low')).toBeGreaterThan(t1.indexOf('## Skills'));
    expect(t1.split(WORLD_CONTEXT_HEADING)).toHaveLength(2);
    expect(t3.split(WORLD_CONTEXT_HEADING)).toHaveLength(2);
    expect(t1).toContain('Ravi owns billing');
    expect(t3).toContain('Priya leads platform');
    expect(t3).not.toContain('Ravi owns billing');
    expect(t1).not.toBe(t3);

    expect(staticPrefix(t1)).toBe(staticPrefix(t3));
    expect(staticPrefix(t1)).not.toContain(MEMORY_CONTENT);
    expect(t1).toContain('from 2026-03-01');
    expect(staticPrefix(t1)).not.toContain('2026-03-01');
    expect(t1.indexOf('2026-03-01')).toBeGreaterThan(worldAt(t1));
  });
});
