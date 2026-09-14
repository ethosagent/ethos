// D11c — the legacy-declaration shim (plan/phases/model-registry.md T3.6).
//
// One case per row of the D11c table, plus the precedence pins the plan names:
// an alias beats the exact-modelId match, and a family map onto a BOUND role is
// a refusal rather than a silent upgrade. The shim runs at resolution time on a
// personality's own declaration and is never written back.

import type {
  AgentEvent,
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  ModelRegistry,
  ModelResolutionContext,
  ModelResolutionFailure,
  PersonalityConfig,
  ResolvedModel,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../agent-loop';
import { resolveTurnModel } from '../agent-loop/turn-model';
import { describeDeviation, mapLegacyModelDeclaration, resolveModel } from '../model-resolution';
import { createTestSafety } from './helpers/test-safety';

/** A catalog with the shapes the family table has to tell apart. */
const CATALOG = new Set([
  'claude-haiku-4-5',
  'claude-sonnet-4-6',
  'claude-opus-4-7',
  'gpt-5.4-mini',
  'o4-mini',
  'gpt-5.6-terra',
  'claude-fable-5-1',
]);
const catalogModelId = (declared: string): string | undefined =>
  CATALOG.has(declared) ? declared : undefined;

/** The shape of the machine this shim was written for: no Claude entries, no bindings. */
function codexRegistry(overrides: Partial<ModelRegistry> = {}): ModelRegistry {
  return {
    entries: {
      'gpt-5-6-terra': {
        alias: 'gpt-5-6-terra',
        provider: 'codex-gpt-terra',
        modelId: 'gpt-5.6-terra',
      },
      'qwen3-8-flash-next': {
        alias: 'qwen3-8-flash-next',
        provider: 'openai-compat',
        modelId: 'qwen3.8-flash-next',
      },
    },
    default: 'gpt-5-6-terra',
    roles: {},
    ...overrides,
  };
}

function ctx(overrides: Partial<ModelResolutionContext> = {}): ModelResolutionContext {
  return { registry: codexRegistry(), routing: {}, catalogModelId, ...overrides };
}

function resolve(
  model: PersonalityConfig['model'],
  context: ModelResolutionContext = ctx(),
  role: 'trivial' | 'default' | 'deep' = 'default',
): ResolvedModel | ModelResolutionFailure {
  return resolveModel({ personality: { id: 'reddit-scout', model }, role, ctx: context });
}

function expectResolved(result: ResolvedModel | ModelResolutionFailure): ResolvedModel {
  if ('ok' in result) throw new Error(`expected a resolved model, got: ${result.reason}`);
  return result;
}

function expectFailure(result: ResolvedModel | ModelResolutionFailure): ModelResolutionFailure {
  if (!('ok' in result)) throw new Error(`expected a refusal, got alias ${result.alias}`);
  return result;
}

describe('D11c — one case per table row', () => {
  it('a value matching a registry alias is used as the alias, with nothing announced', () => {
    const resolved = expectResolved(resolve('qwen3-8-flash-next'));
    expect(resolved.alias).toBe('qwen3-8-flash-next');
    expect(resolved.deviation).toBeUndefined();
  });

  it('a vendor id equal to exactly one entry modelId maps to that alias, once, naming the line', () => {
    const resolved = expectResolved(resolve('gpt-5.6-terra'));

    expect(resolved.alias).toBe('gpt-5-6-terra');
    expect(resolved.source).toBe('personality');
    expect(resolved.pinned).toBe(true);
    expect(resolved.deviation).toMatchObject({
      kind: 'legacy-id-mapped',
      declared: 'gpt-5.6-terra',
      effective: 'gpt-5-6-terra',
      once: true,
    });
    const { line, fix } = describeDeviation(
      resolved.deviation as NonNullable<typeof resolved.deviation>,
    );
    expect(line).toContain('gpt-5.6-terra');
    expect(line).toContain('gpt-5-6-terra');
    expect(fix).toContain('`model: gpt-5-6-terra`');
    expect(fix).toContain('0.10.0');
  });

  it('two matching entries → needsAttention, not a guess', () => {
    const registry = codexRegistry();
    registry.entries['terra-batch'] = {
      alias: 'terra-batch',
      provider: 'codex-gpt-terra',
      modelId: 'gpt-5.6-terra',
    };
    const failure = expectFailure(resolve('gpt-5.6-terra', ctx({ registry })));

    expect(failure.code).toBe('model_unresolved');
    expect(failure.declared).toBe('gpt-5.6-terra');
    expect(failure.reason).toContain('gpt-5-6-terra');
    expect(failure.reason).toContain('terra-batch');
  });

  it("a family map onto an unbound role resolves to today's model", () => {
    const resolved = expectResolved(resolve('claude-sonnet-4-6'));

    expect(resolved.alias).toBe('gpt-5-6-terra');
    expect(resolved.modelId).toBe('gpt-5.6-terra');
    expect(resolved.source).toBe('default');
    // The default rung, exactly as before the registry: never pinned, rides the chain.
    expect(resolved.pinned).toBe(false);
    expect(resolved.deviation).toMatchObject({
      kind: 'legacy-id-mapped',
      declared: 'claude-sonnet-4-6',
      effective: 'gpt-5-6-terra',
      once: true,
    });
    expect(resolved.deviation?.reason).toContain('"default" role');
    expect(resolved.deviation?.fix).toContain('`model: default`');
  });

  it('a family map onto a bound role is needsAttention, not a silent upgrade', () => {
    const registry = codexRegistry({
      entries: {
        ...codexRegistry().entries,
        opus: { alias: 'opus', provider: 'anthropic', modelId: 'claude-opus-5' },
      },
      roles: { deep: 'opus' },
    });
    const failure = expectFailure(
      resolve({ default: 'claude-opus-4-7' }, ctx({ registry }), 'default'),
    );

    expect(failure.code).toBe('model_unresolved');
    expect(failure.declared).toBe('claude-opus-4-7');
    // Names the role it would have mapped to, what that role is bound to here,
    // and the one line that makes it explicit.
    expect(failure.reason).toContain('"deep" role');
    expect(failure.reason).toContain('"opus"');
    expect(failure.reason).toContain('claude-opus-5');
    expect(failure.fix).toContain('`model.default: deep`');
  });

  it('anything else refuses with the ordinary message', () => {
    const failure = expectFailure(resolve('claude-sonnet-9-typo'));
    expect(failure.reason).toContain('neither a role nor a model configured');
    expect(failure.fix).toContain('Configured models:');
  });

  it('a catalog id in no known family refuses rather than guessing', () => {
    expectFailure(resolve('claude-fable-5-1'));
  });

  it('with no catalog lookup injected the family rows never fire', () => {
    expectFailure(resolve('claude-sonnet-4-6', ctx({ catalogModelId: undefined })));
  });
});

describe('D11c — precedence and scope', () => {
  it('an alias literally named like a vendor id wins over the exact-modelId match', () => {
    const registry = codexRegistry({
      entries: {
        ...codexRegistry().entries,
        'claude-sonnet-5': { alias: 'claude-sonnet-5', provider: 'mine', modelId: 'my-sonnet' },
        other: { alias: 'other', provider: 'anthropic', modelId: 'claude-sonnet-5' },
      },
    });
    const resolved = expectResolved(resolve('claude-sonnet-5', ctx({ registry })));

    expect(resolved.alias).toBe('claude-sonnet-5');
    expect(resolved.deviation).toBeUndefined();
  });

  it('the family table is literal and ordered', () => {
    const roleOf = (declared: string): string | undefined => {
      const mapped = mapLegacyModelDeclaration({
        personalityId: 'p',
        declared,
        key: 'model',
        ctx: ctx(),
      });
      return mapped.kind === 'mapped' && mapped.declaration.kind === 'role'
        ? mapped.declaration.role
        : undefined;
    };
    expect(roleOf('claude-haiku-4-5')).toBe('trivial');
    expect(roleOf('claude-sonnet-4-6')).toBe('default');
    expect(roleOf('claude-opus-4-7')).toBe('deep');
    expect(roleOf('gpt-5.4-mini')).toBe('trivial');
    expect(roleOf('o4-mini')).toBe('trivial');
    // `gpt-5.6-terra` is a registry entry's modelId here, so it maps to the alias
    // first; against a registry without it, the `gpt-*` row reads it as `default`.
    const noTerra = ctx({ registry: { entries: {}, default: undefined, roles: {} } });
    const mapped = mapLegacyModelDeclaration({
      personalityId: 'p',
      declared: 'gpt-5.6-terra',
      key: 'model',
      ctx: noTerra,
    });
    expect(mapped.kind === 'mapped' && mapped.declaration).toEqual({
      kind: 'role',
      role: 'default',
    });
  });

  it('a claude tier map on a registry with no claude entries resolves every leaf to the default', () => {
    const tiers = {
      trivial: 'claude-haiku-4-5',
      default: 'claude-sonnet-4-6',
      deep: 'claude-opus-4-7',
    };
    for (const role of ['trivial', 'default', 'deep'] as const) {
      const resolved = expectResolved(resolve(tiers, ctx(), role));
      expect(resolved.modelId).toBe('gpt-5.6-terra');
      expect(resolved.deviation?.kind).toBe('legacy-id-mapped');
      expect(resolved.deviation?.declared).toBe(tiers[role]);
      expect(resolved.deviation?.fix).toContain(`\`model.${role}: ${role}\``);
    }
  });

  it('a modelRouting value is not shimmed — only the personality declaration is', () => {
    const failure = expectFailure(
      resolveModel({
        personality: { id: 'reddit-scout' },
        role: 'default',
        ctx: ctx({ routing: { 'reddit-scout': 'claude-sonnet-4-6' } }),
      }),
    );
    expect(failure.declared).toBe('claude-sonnet-4-6');
  });

  it('a /model pin is not shimmed', () => {
    const failure = expectFailure(
      resolveModel({
        personality: { id: 'reddit-scout' },
        role: 'default',
        ctx: ctx(),
        runOverride: 'claude-sonnet-4-6',
      }),
    );
    expect(failure.declared).toBe('claude-sonnet-4-6');
  });

  it('an escalation drops a legacy string the shim reads as a role, like a declared role', () => {
    const turn = resolveTurnModel({
      personality: { id: 'pi-tester', model: 'claude-sonnet-4-6' },
      role: 'deep',
      ctx: ctx(),
      llmName: 'codex',
      llmModel: 'gpt-5.6-terra',
    });
    if (!turn.ok) throw new Error(turn.reason);
    // Resolves the requested `deep` role (unbound → default), not the `default`
    // role the legacy string maps to.
    expect(turn.deviation).toMatchObject({ kind: 'role-unbound', declared: 'deep' });
  });
});

describe('D11c — the notice rides run_start once per personality per process', () => {
  function mockLLM(): LLMProvider {
    return {
      name: 'codex',
      model: 'gpt-5.6-terra',
      maxContextTokens: 200_000,
      supportsCaching: false,
      supportsThinking: false,
      async *complete(
        _m: unknown,
        _t: unknown,
        _o: CompletionOptions,
      ): AsyncIterable<CompletionChunk> {
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'done', finishReason: 'end_turn' };
      },
      async countTokens() {
        return 1;
      },
    };
  }

  async function runStart(loop: AgentLoop, sessionKey: string) {
    const events: AgentEvent[] = [];
    for await (const e of loop.run('hi', { personalityId: 'reddit-scout', sessionKey })) {
      events.push(e);
    }
    const start = events.find((e) => e.type === 'run_start');
    if (start?.type !== 'run_start') throw new Error('no run_start');
    return start;
  }

  it('announces on the first turn and not the second', async () => {
    const loop = new AgentLoop({
      llm: mockLLM(),
      safety: createTestSafety(),
      modelResolution: ctx(),
    });
    // biome-ignore lint/complexity/useLiteralKeys: `personalities` is private; bracket-string is the TS escape hatch for test access
    loop['personalities'].define({
      id: 'reddit-scout',
      name: 'Reddit scout',
      model: { trivial: 'claude-haiku-4-5', default: 'claude-sonnet-4-6' },
    });

    const first = await runStart(loop, 'cli:a');
    const second = await runStart(loop, 'cli:b');

    expect(first.model).toBe('gpt-5.6-terra');
    expect(first.deviation?.kind).toBe('legacy-id-mapped');
    expect(second.model).toBe('gpt-5.6-terra');
    expect(second.deviation).toBeUndefined();
  });
});
