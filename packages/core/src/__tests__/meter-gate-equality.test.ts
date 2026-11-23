// `meterGateTokens` is the context meter's "auto-compacts here" tick. It must
// equal the token count at which `maybeCompact` fires, or the meter lies.
// Pins: `meterGateTokens` (`agent-loop/context-sections.ts`) and `maybeCompact` (`agent-loop/compaction.ts`).

import type { ContextEngineCompactInput, Message, PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { maybeCompact } from '../agent-loop/compaction';
import { meterGateTokens } from '../agent-loop/context-sections';
import { DefaultContextEngineRegistry } from '../context-engines/registry';

function createSpyEngine() {
  let compactCalled = false;
  return {
    get compactCalled() {
      return compactCalled;
    },
    name: 'spy_engine' as const,
    async compact(opts: ContextEngineCompactInput) {
      compactCalled = true;
      return { messages: opts.messages.slice(-1), notes: 'dropped' };
    },
    shouldCompact() {
      return true;
    },
  };
}

const sessionMock = {
  recordCompression: async () => ({}),
  updateUsage: async () => {},
  recordCompactionTurn: async () => {},
  // biome-ignore lint/suspicious/noExplicitAny: standard test mock
} as any;

const personality: PersonalityConfig = { id: 'test', name: 'Test', context_engine: 'spy_engine' };
const meta = { sessionId: 's1', sessionKey: 'cli:s1', turnNumber: 1, lastCompactionTurn: 0 };
const messages: Message[] = [
  { role: 'user', content: 'hello there' },
  { role: 'assistant', content: 'hi' },
  { role: 'user', content: 'and now the current turn' },
];

async function fires(
  deps: Parameters<typeof maybeCompact>[0] extends infer D ? Partial<D> : never,
  lastActualInputTokens: number,
): Promise<boolean> {
  const engine = createSpyEngine();
  const registry = new DefaultContextEngineRegistry();
  registry.register(engine);
  await maybeCompact(
    {
      // biome-ignore lint/suspicious/noExplicitAny: standard test mock
      llm: { maxContextTokens: 200_000 } as any,
      contextEngines: registry,
      session: sessionMock,
      ...deps,
      lastActualInputTokens,
    },
    messages,
    '',
    personality,
    meta,
  );
  return engine.compactCalled;
}

describe('meterGateTokens equals maybeCompact gate', () => {
  const base = {
    pressure: 0.75,
    maxSingleToolResultTokens: 8_000,
    reservedOutputTokens: 6_000,
    staticTokens: 30_000,
  };
  const cases: Array<[string, { maxContextTokens?: number; windowTokens?: number }]> = [
    ['with a ceiling', { maxContextTokens: 150_000 }],
    ['without a ceiling', {}],
    ['with a gate window', { windowTokens: 64_000 }],
    ['with a ceiling above the fractional gate', { maxContextTokens: 190_000 }],
  ];

  for (const [name, extra] of cases) {
    it(`fires exactly above the meter value ${name}`, async () => {
      const deps = { ...base, ...extra };
      // biome-ignore lint/suspicious/noExplicitAny: standard test mock
      const llm = { maxContextTokens: 200_000 } as any;
      const gate = meterGateTokens({ llm, ...deps }, deps.staticTokens);
      expect(gate).toBeGreaterThan(0);
      expect(await fires(deps, gate)).toBe(false);
      expect(await fires(deps, gate + 1)).toBe(true);
    });
  }

  it('defaults pressure to 0.8 like maybeCompact', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: standard test mock
    const llm = { maxContextTokens: 200_000 } as any;
    const gate = meterGateTokens({ llm }, 20_000);
    expect(await fires({ staticTokens: 20_000 }, gate)).toBe(false);
    expect(await fires({ staticTokens: 20_000 }, gate + 1)).toBe(true);
  });
});
