// A turn routed by `modelOverride` to a model with a SMALLER context window is
// gated against that window, not the provider's (`turnGateWindow`,
// agent-loop/compaction.ts → `TurnSetup.gateWindowTokens`). The provider's
// `maxContextTokens` is the CONFIGURED model's window; once Anthropic reports
// its real 1M windows, an Opus-configured provider routing a turn to Haiku 4.5
// (200K) would otherwise let history grow to the 1M gate and overflow Haiku.

import type {
  CompletionChunk,
  CompletionOptions,
  ContextEngineCompactInput,
  LLMProvider,
  Message,
  ModelResolutionContext,
  PersonalityConfig,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
import { maybeCompact } from '../agent-loop/compaction';
import { turnGateDeps } from '../agent-loop/turn-gate';
import { turnGateWindow } from '../agent-loop/turn-window';
import { DefaultContextEngineRegistry } from '../context-engines/registry';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

const BIG = 1_000_000;
const SMALL = 20_000;

function mockLLM(onComplete: (opts: CompletionOptions) => void): LLMProvider {
  return {
    name: 'mock',
    model: 'big-model',
    maxContextTokens: BIG,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(_m: Message[], _t: unknown, opts: CompletionOptions) {
      onComplete(opts);
      const chunks: CompletionChunk[] = [
        { type: 'text_delta', text: 'ok' },
        { type: 'done', finishReason: 'end_turn' },
      ];
      yield* chunks;
    },
    async countTokens() {
      return 10;
    },
  };
}

function resolution(): ModelResolutionContext {
  return {
    registry: {
      entries: {
        big: { alias: 'big', provider: 'anthropic', modelId: 'big-model' },
        small: { alias: 'small', provider: 'anthropic', modelId: 'small-model' },
      },
      default: 'big',
      roles: {},
    },
    routing: {},
  };
}

const windows: Record<string, number> = { 'big-model': BIG, 'small-model': SMALL };

async function run(personalityModel: string, withResolver: boolean) {
  const onComplete = vi.fn();
  const loop = new AgentLoop({
    llm: mockLLM(onComplete),
    tools: new DefaultToolRegistry(),
    safety: createTestSafety(),
    modelResolution: resolution(),
    ...(withResolver ? { compaction: { contextWindowFor: (m: string) => windows[m] } } : {}),
  });
  // biome-ignore lint/complexity/useLiteralKeys: `personalities` is private; bracket-string is the TS escape hatch for test access
  loop['personalities'].define({ id: 'p', name: 'P', model: personalityModel });
  const events: AgentEvent[] = [];
  // ~40K tokens of user text: fits the 1M window, not the 20K one.
  for await (const e of loop.run('x'.repeat(160_000), { personalityId: 'p' })) events.push(e);
  return { onComplete, events };
}

describe('turnGateWindow', () => {
  const llm = { maxContextTokens: BIG };
  const lookup = (m: string) => windows[m];

  it('returns the override window when it is smaller than the provider window', () => {
    expect(turnGateWindow(llm, lookup, 'small-model')).toBe(SMALL);
  });

  it('never raises the gate: a larger, equal or unknown override window → undefined', () => {
    expect(turnGateWindow({ maxContextTokens: SMALL }, lookup, 'big-model')).toBeUndefined();
    expect(turnGateWindow(llm, lookup, 'big-model')).toBeUndefined();
    expect(turnGateWindow(llm, lookup, 'unknown-model')).toBeUndefined();
  });

  it('no override or no resolver → undefined (the provider window applies)', () => {
    expect(turnGateWindow(llm, lookup, undefined)).toBeUndefined();
    expect(turnGateWindow(llm, undefined, 'small-model')).toBeUndefined();
  });
});

describe('AgentLoop — a turn routed to a smaller-window model is gated against its window', () => {
  it('the context-fit preflight measures the override window and refuses before the call', async () => {
    const { onComplete, events } = await run('small', true);
    expect(onComplete).not.toHaveBeenCalled();
    const error = events.find((e) => e.type === 'error');
    expect(error?.type === 'error' && error.error).toContain(`${SMALL}-token window`);
  });

  it('without the resolver the same turn is gated against the provider window (sent)', async () => {
    const { onComplete } = await run('small', false);
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete.mock.calls[0]?.[0]?.modelOverride).toBe('small-model');
  });

  it('a turn on the configured model is unaffected by the resolver', async () => {
    const { onComplete } = await run('big', true);
    expect(onComplete).toHaveBeenCalledOnce();
  });
});

describe('the pressure gates honour the turn window', () => {
  const personality: PersonalityConfig = { id: 'p', name: 'P', context_engine: 'spy' };
  const history: Message[] = [
    { role: 'user', content: 'a'.repeat(40_000) },
    { role: 'assistant', content: 'b'.repeat(40_000) },
    { role: 'user', content: 'c'.repeat(40_000) },
  ];
  const meta = { sessionId: 's', sessionKey: 'k', turnNumber: 2, lastCompactionTurn: 0 };

  function spyRegistry() {
    const spy = {
      called: false,
      name: 'spy' as const,
      async compact(opts: ContextEngineCompactInput) {
        spy.called = true;
        return { messages: opts.messages.slice(-1), notes: 'dropped' };
      },
      shouldCompact: () => true,
    };
    const registry = new DefaultContextEngineRegistry();
    registry.register(spy);
    return { spy, registry };
  }

  const session = {
    recordCompression: async () => ({}),
    updateUsage: async () => {},
    recordCompactionTurn: async () => {},
    // biome-ignore lint/suspicious/noExplicitAny: standard test mock
  } as any;

  it('maybeCompact fires at the turn window (~30K tokens > 0.8 × 20K)', async () => {
    const { spy, registry } = spyRegistry();
    await maybeCompact(
      {
        // biome-ignore lint/suspicious/noExplicitAny: standard test mock
        llm: { maxContextTokens: BIG } as any,
        windowTokens: SMALL,
        contextEngines: registry,
        session,
      },
      history,
      '',
      personality,
      meta,
    );
    expect(spy.called).toBe(true);
  });

  it('maybeCompact does not fire at the provider window without it', async () => {
    const { spy, registry } = spyRegistry();
    await maybeCompact(
      {
        // biome-ignore lint/suspicious/noExplicitAny: standard test mock
        llm: { maxContextTokens: BIG } as any,
        contextEngines: registry,
        session,
      },
      history,
      '',
      personality,
      meta,
    );
    expect(spy.called).toBe(false);
  });

  it('the turn-end gate deps carry the turn window', () => {
    const deps = {
      // biome-ignore lint/suspicious/noExplicitAny: standard test mock
      llm: { maxContextTokens: BIG } as any,
      tools: new DefaultToolRegistry(),
    };
    const toolScope = { allowedTools: undefined, filterOpts: {} };
    expect(turnGateDeps(deps, { toolScope, gateWindowTokens: SMALL }, []).windowTokens).toBe(SMALL);
    expect(turnGateDeps(deps, { toolScope }, []).windowTokens).toBeUndefined();
  });
});
