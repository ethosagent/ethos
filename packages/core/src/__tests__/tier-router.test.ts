// The tier router at turn setup (plan/phases/decision-provider-jev.md §8.3,
// D15, R1; §14 "Router" and regression contract (c)).
//
// Asserts what the PROVIDER was asked to serve (`modelOverride ?? llm.model`),
// like model-tier.test.ts, plus whether the router was called at all — R1's
// whole point is that no call is made when the answer cannot change the model.
// Plan decision-provider-personality §7.1: the router also receives the turn's
// resolved personality.

import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  ModelRegistry,
  ModelResolutionContext,
  ModelTierName,
  PersonalityConfig,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
import { routeTurnTier, type TierRouter } from '../agent-loop/tier-router';
import type { AgentLoopObservability } from '../observability/agent-loop-observability';
import { createTestSafety } from './helpers/test-safety';

function makeLLM(seen: CompletionOptions[]): LLMProvider {
  return {
    name: 'mock',
    model: 'base-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(_m, _t, opts: CompletionOptions): AsyncIterable<CompletionChunk> {
      seen.push(opts);
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

function registry(roles: ModelRegistry['roles']): ModelRegistry {
  return {
    entries: {
      haiku: { alias: 'haiku', provider: 'anthropic', modelId: 'claude-haiku-5' },
      sonnet: { alias: 'sonnet', provider: 'anthropic', modelId: 'claude-sonnet-5' },
      opus: { alias: 'opus', provider: 'anthropic', modelId: 'claude-opus-5' },
    },
    default: 'sonnet',
    roles,
  };
}

const BOUND: ModelRegistry['roles'] = { trivial: 'haiku', deep: 'opus', dreaming: 'opus' };

function observability() {
  const recordTierOverride = vi.fn();
  const obs: AgentLoopObservability = {
    startTurnTrace: () => 'trace-1',
    endTrace: () => {},
    startSpan: () => 'span-1',
    endSpan: () => {},
    recordSafetyBlock: () => {},
    recordCompaction: () => {},
    recordTierEscalation: () => {},
    recordTierOverride,
    flush: () => {},
  };
  return { obs, recordTierOverride };
}

async function turn(opts: {
  router?: TierRouter;
  roles?: ModelRegistry['roles'];
  personality?: Partial<PersonalityConfig>;
  tierOverride?: ModelTierName;
  modelOverride?: string;
  text?: string;
  abortSignal?: AbortSignal;
}) {
  const seen: CompletionOptions[] = [];
  const { obs, recordTierOverride } = observability();
  const modelResolution: ModelResolutionContext = {
    registry: registry(opts.roles ?? BOUND),
    routing: {},
  };
  const loop = new AgentLoop({
    llm: makeLLM(seen),
    safety: createTestSafety(),
    modelResolution,
    observability: obs,
    ...(opts.router ? { tierRouter: opts.router } : {}),
  });
  // biome-ignore lint/complexity/useLiteralKeys: `personalities` is private; bracket-string is the TS escape hatch for test access
  loop['personalities'].define({ id: 'p', name: 'P', ...opts.personality });
  const events: AgentEvent[] = [];
  for await (const e of loop.run(opts.text ?? 'thanks!', {
    personalityId: 'p',
    ...(opts.tierOverride ? { tierOverride: opts.tierOverride } : {}),
    ...(opts.modelOverride ? { modelOverride: opts.modelOverride } : {}),
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
  })) {
    events.push(e);
  }
  const served = seen[0]?.modelOverride ?? 'base-model';
  return { served, recordTierOverride, events };
}

describe('tier router — regression contract (c): no router configured', () => {
  it('no override → the default model, and no framework tier record', async () => {
    const { served, recordTierOverride } = await turn({});
    expect(served).toBe('claude-sonnet-5');
    expect(recordTierOverride).not.toHaveBeenCalled();
  });

  it('a user override is the tier, exactly as before', async () => {
    const { served, recordTierOverride } = await turn({ tierOverride: 'trivial' });
    expect(served).toBe('claude-haiku-5');
    expect(recordTierOverride).toHaveBeenCalledTimes(1);
    expect(recordTierOverride.mock.calls[0]?.[0]).toMatchObject({ actor: 'user' });
  });

  it('routeTurnTier with no router never resolves anything', async () => {
    const resolve = vi.fn(() => ({ provider: 'a', model: 'b' }));
    expect(
      await routeTurnTier({
        router: undefined,
        message: 'hi',
        personality: { id: 'p', name: 'P' },
        resolve,
      }),
    ).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('tier router — routing', () => {
  it("'trivial' → the trivial model runs, recorded with actor 'framework'", async () => {
    const router = vi.fn<TierRouter>(async () => 'trivial');
    const { served, recordTierOverride } = await turn({ router });
    expect(router).toHaveBeenCalledTimes(1);
    expect(served).toBe('claude-haiku-5');
    expect(recordTierOverride).toHaveBeenCalledTimes(1);
    expect(recordTierOverride.mock.calls[0]?.[0]).toEqual({
      traceId: 'trace-1',
      actor: 'framework',
      tier: 'trivial',
      personalityId: 'p',
    });
  });

  it('the router receives the user message and the turn signal', async () => {
    const router = vi.fn<TierRouter>(async () => null);
    const controller = new AbortController();
    await turn({ router, text: 'hello there', abortSignal: controller.signal });
    expect(router.mock.calls[0]?.[0].message).toBe('hello there');
    expect(router.mock.calls[0]?.[0].signal).toBe(controller.signal);
  });

  it("the router receives the turn's resolved personality (the object model resolution reads)", async () => {
    const router = vi.fn<TierRouter>(async () => null);
    await turn({
      router,
      personality: { decisions: { provider: 'typesafe', sites: { router: 'shadow' } } },
    });
    const personality = router.mock.calls[0]?.[0].personality;
    expect(personality?.id).toBe('p');
    expect(personality?.decisions).toEqual({
      provider: 'typesafe',
      sites: { router: 'shadow' },
    });
  });

  it("the router receives the turn's traceId, so its record joins the turn", async () => {
    const router = vi.fn<TierRouter>(async () => null);
    await turn({ router });
    expect(router.mock.calls[0]?.[0].traceId).toBe('trace-1');
  });

  it('null → default', async () => {
    const { served, recordTierOverride } = await turn({ router: async () => null });
    expect(served).toBe('claude-sonnet-5');
    expect(recordTierOverride).not.toHaveBeenCalled();
  });

  it('a failing router → default, and the turn still runs', async () => {
    const { served, events } = await turn({
      router: async () => {
        throw new Error('provider down');
      },
    });
    expect(served).toBe('claude-sonnet-5');
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('a misbehaving router cannot select deep or dreaming (D15)', async () => {
    for (const tier of ['deep', 'dreaming', 'default']) {
      const router = (async () => tier) as unknown as TierRouter;
      const { served, recordTierOverride } = await turn({ router });
      expect(served).toBe('claude-sonnet-5');
      expect(recordTierOverride).not.toHaveBeenCalled();
    }
  });

  it('an empty message is not routed', async () => {
    const router = vi.fn<TierRouter>(async () => 'trivial');
    const { served } = await turn({ router, text: '   ' });
    expect(router).not.toHaveBeenCalled();
    expect(served).toBe('claude-sonnet-5');
  });
});

describe('tier router — when it is NOT called', () => {
  it('a user override wins and suppresses the call', async () => {
    for (const tierOverride of ['default', 'deep'] as const) {
      const router = vi.fn<TierRouter>(async () => 'trivial');
      const { served, recordTierOverride } = await turn({ router, tierOverride });
      expect(router).not.toHaveBeenCalled();
      expect(served).toBe(tierOverride === 'deep' ? 'claude-opus-5' : 'claude-sonnet-5');
      expect(recordTierOverride.mock.calls.map((c) => c[0].actor)).toEqual(['user']);
    }
  });

  it('R1: a rung 3 alias wins → trivial and default are the same model → no call', async () => {
    const router = vi.fn<TierRouter>(async () => 'trivial');
    const { served } = await turn({ router, personality: { model: 'sonnet' } });
    expect(router).not.toHaveBeenCalled();
    expect(served).toBe('claude-sonnet-5');
  });

  it('R1: a rung 0 run pin wins → no call', async () => {
    const router = vi.fn<TierRouter>(async () => 'trivial');
    const { served } = await turn({ router, modelOverride: 'opus' });
    expect(router).not.toHaveBeenCalled();
    expect(served).toBe('claude-opus-5');
  });

  it('R1: `trivial` unbound → it falls back to default → no call', async () => {
    const router = vi.fn<TierRouter>(async () => 'trivial');
    const { served } = await turn({ router, roles: { deep: 'opus' } });
    expect(router).not.toHaveBeenCalled();
    expect(served).toBe('claude-sonnet-5');
  });

  it('R1: a resolution failure on the trivial side → no call', async () => {
    const router = vi.fn();
    const resolve = (role: 'trivial' | 'default') =>
      role === 'trivial' ? null : { provider: 'anthropic', model: 'claude-sonnet-5' };
    expect(
      await routeTurnTier({ router, message: 'hi', personality: { id: 'p', name: 'P' }, resolve }),
    ).toBeUndefined();
    expect(router).not.toHaveBeenCalled();
  });

  it('R1: same model on a different provider entry still counts as different', async () => {
    const router = vi.fn<TierRouter>(async () => 'trivial');
    const resolve = (role: 'trivial' | 'default') => ({
      provider: role === 'trivial' ? 'local' : 'anthropic',
      model: 'm',
    });
    expect(
      await routeTurnTier({ router, message: 'hi', personality: { id: 'p', name: 'P' }, resolve }),
    ).toBe('trivial');
  });
});
