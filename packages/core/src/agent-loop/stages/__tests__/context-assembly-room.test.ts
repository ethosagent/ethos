// L2 core seam (plan channel-prompts §3.6, D4/D5): `RunOptions.roomPrompt` is
// placed by `assembleContext` as its own `## This room` part right after SOUL.md;
// `RunOptions.roomSkills` reaches `PromptContext.roomSkills`. Drives a real
// AgentLoop turn so the assertions hit the actual call site.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import type {
  CompletionChunk,
  CompletionOptions,
  ContextInjector,
  LLMProvider,
  Message,
  PromptContext,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { createTestSafety } from '../../../__tests__/helpers/test-safety';
import type { AgentEvent, RunOptions } from '../../../agent-loop';
import { AgentLoop } from '../../../agent-loop';
import { DefaultPersonalityRegistry } from '../../../defaults/noop-personality';

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

const SOUL = 'You are Lean, a focused assistant.';

async function runOnce(
  runOpts: RunOptions,
  injectors: ContextInjector[] = [],
): Promise<string | undefined> {
  const storage = new InMemoryStorage();
  await storage.mkdir('/personalities/lean');
  await storage.write('/personalities/lean/SOUL.md', SOUL);
  const personalities = new DefaultPersonalityRegistry();
  vi.spyOn(personalities, 'getDefault').mockReturnValue({
    id: 'lean',
    name: 'Lean',
    toolset: [],
    soulFile: '/personalities/lean/SOUL.md',
  });
  const captured: CompletionOptions[] = [];
  const loop = new AgentLoop({
    llm: capturingLLM(captured),
    personalities,
    safety: createTestSafety(),
    storage,
    injectors,
  });
  await collect(loop.run('hello', runOpts));
  expect(captured).toHaveLength(1);
  return captured[0]?.system;
}

describe('context-assembly: room block', () => {
  it('renders `## This room` + the text right after SOUL.md, after the prelude', async () => {
    const system = (await runOnce({ roomPrompt: 'Engineering group for Atlas.' })) ?? '';
    const preludeAt = system.indexOf('External-content safety');
    const soulAt = system.indexOf(SOUL);
    const roomAt = system.indexOf('## This room');
    expect(preludeAt).toBeGreaterThanOrEqual(0);
    expect(soulAt).toBeGreaterThan(preludeAt);
    expect(roomAt).toBeGreaterThan(soulAt);
    expect(system.slice(soulAt)).toBe(`${SOUL}\n\n## This room\n\nEngineering group for Atlas.`);
  });

  it('is byte-identical to today when roomPrompt is absent', async () => {
    const without = await runOnce({});
    const undef = await runOnce({ roomPrompt: undefined });
    expect(undef).toBe(without);
    expect(without).not.toContain('## This room');
    expect(without?.endsWith(SOUL)).toBe(true);
  });

  it.each(['', '   ', '\n\t \n'])('treats blank roomPrompt %j as absent', async (blank) => {
    const without = await runOnce({});
    expect(await runOnce({ roomPrompt: blank })).toBe(without);
  });

  it('passes roomSkills to PromptContext.roomSkills, and omits it when unset', async () => {
    const seen: PromptContext[] = [];
    const probe: ContextInjector = {
      id: 'probe',
      priority: 1,
      async inject(ctx) {
        seen.push(ctx);
        return null;
      },
    };
    await runOnce({ roomSkills: ['incident-template', 'oncall'] }, [probe]);
    await runOnce({}, [probe]);
    expect(seen[0]?.roomSkills).toEqual(['incident-template', 'oncall']);
    expect(seen[1]).not.toHaveProperty('roomSkills');
  });

  it('keeps a prepended injector ahead of the prelude (room block stays after SOUL)', async () => {
    const prepender: ContextInjector = {
      id: 'platform-formatting',
      priority: 1,
      async inject() {
        return { content: 'PREPENDED', position: 'prepend' };
      },
    };
    const system = (await runOnce({ roomPrompt: 'R' }, [prepender])) ?? '';
    expect(system.startsWith('PREPENDED')).toBe(true);
    expect(system.indexOf('External-content safety')).toBeLessThan(system.indexOf(SOUL));
    expect(system.indexOf(SOUL)).toBeLessThan(system.indexOf('## This room'));
  });
});
