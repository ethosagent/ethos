// What `## Routing` on the character sheet claims, asserted against the
// function the TURN calls — the sheet may not name a model the turn would not
// send.
//
// `evaluateTierMismatch` and its cases are gone with the guard they described
// (D8/T1.7): `personality.provider === llmName` made every tier map inert on a
// chained deployment and every plain-string declaration inert everywhere, and
// a warning about a silent drop is worth nothing once the drop is fixed.
//
// Two paths. With NO registry (`registry: undefined`) `resolveTurnModel` is the
// D11b legacy shim: `modelRouting` wins, otherwise the deployment default, and
// a personality declaration falls through. With a registry it is the D7 rung
// chain, and the sheet names the vendor id, the alias, the role and the rung.

import { ChainedProvider, describeDeviation, resolveTurnModel } from '@ethosagent/core';
import type { LLMProvider, ModelRegistry, PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createLLM, type WiringConfig } from '../index';
import { lookupLegacyCatalogModelId } from '../model-catalog';
import { resolveActiveLlmName, resolveCharacterSheetRouting } from '../tier-diagnostics';

function personality(overrides: Partial<PersonalityConfig>): PersonalityConfig {
  return { id: 'researcher', name: 'Researcher', ...overrides };
}

/** What the TURN would send for this personality. */
function turnModel(
  p: PersonalityConfig,
  activeProvider: string,
  globalModel: string,
  routing: Record<string, string> = {},
  registry: ModelRegistry = { entries: {}, roles: {} },
): string {
  const resolved = resolveTurnModel({
    personality: p,
    role: 'default',
    ctx: { registry, routing },
    llmName: activeProvider,
    llmModel: globalModel,
  });
  if (!resolved.ok) throw new Error('unexpected refusal');
  return resolved.model;
}

describe('resolveCharacterSheetRouting — no registry (D11b legacy path)', () => {
  it('reports the deployment default, and the declaration as not used, while no registry exists', () => {
    const p = personality({ provider: 'anthropic', model: { default: 'claude-sonnet-4-6' } });
    const routing = resolveCharacterSheetRouting(p, 'codex', 'gpt-5.6-terra', {}, undefined);

    expect(routing.effectiveModel).toBe('gpt-5.6-terra');
    expect(routing.source).toBe('global');
    expect(routing.inert?.declared).toBe('default=claude-sonnet-4-6');
    expect(routing.inert?.reason).toContain('no model registry');
    expect(routing.inert?.reason).toContain('ethos migrate models');
    // The enforcer agrees — the sheet is not being pessimistic.
    expect(turnModel(p, 'codex', 'gpt-5.6-terra')).toBe('gpt-5.6-terra');
  });

  it('says the same thing when the declared provider MATCHES the active LLM', () => {
    // The old guard admitted a tier map here and dropped it everywhere else,
    // which is the inconsistency V2 is about. With no registry to resolve an
    // alias against, the declaration falls through either way — and the turn
    // does the same, which is the property that matters.
    const p = personality({ provider: 'anthropic', model: { default: 'claude-sonnet-4-6' } });
    const routing = resolveCharacterSheetRouting(p, 'anthropic', 'claude-opus-4-7', {}, undefined);

    expect(routing.effectiveModel).toBe('claude-opus-4-7');
    expect(routing.source).toBe('global');
    expect(turnModel(p, 'anthropic', 'claude-opus-4-7')).toBe('claude-opus-4-7');
  });

  it('calls a plain string `model:` not used too, and the turn drops it identically', () => {
    const p = personality({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
    const routing = resolveCharacterSheetRouting(p, 'anthropic', 'claude-opus-4-7', {}, undefined);

    expect(routing.effectiveModel).toBe('claude-opus-4-7');
    expect(routing.source).toBe('global');
    expect(routing.inert?.declared).toBe('claude-sonnet-4-6');
    expect(turnModel(p, 'anthropic', 'claude-opus-4-7')).toBe('claude-opus-4-7');
  });

  it('names a modelRouting entry as the winning source and the declaration as not used', () => {
    const p = personality({ provider: 'anthropic', model: { default: 'claude-sonnet-4-6' } });
    const routing = resolveCharacterSheetRouting(
      p,
      'anthropic',
      'claude-opus-4-7',
      { researcher: 'claude-haiku-4-5' },
      undefined,
    );

    expect(routing.effectiveModel).toBe('claude-haiku-4-5');
    expect(routing.source).toBe('routing-override');
    expect(routing.inert?.reason).toBe('`modelRouting.researcher` in config.yaml takes priority');
    expect(turnModel(p, 'anthropic', 'claude-opus-4-7', { researcher: 'claude-haiku-4-5' })).toBe(
      'claude-haiku-4-5',
    );
  });

  it('claims nothing unused for a personality that declares no model', () => {
    const routing = resolveCharacterSheetRouting(
      personality({}),
      'codex',
      'gpt-5.6-terra',
      {},
      undefined,
    );

    expect(routing).toEqual({
      activeProvider: 'codex',
      effectiveModel: 'gpt-5.6-terra',
      source: 'global',
    });
  });
});

describe('resolveCharacterSheetRouting — with a registry (D7 rung chain)', () => {
  const registry = (roles: ModelRegistry['roles'] = {}): ModelRegistry => ({
    entries: {
      sonnet: { alias: 'sonnet', provider: 'anthropic', modelId: 'claude-sonnet-5' },
      opus: { alias: 'opus', provider: 'anthropic', modelId: 'claude-opus-5' },
    },
    default: 'sonnet',
    roles,
  });

  it('names the default model a routing override to an UNBOUND role falls through to (the live bug)', () => {
    const p = personality({ id: 'pr-reviewer', model: 'sonnet' });
    const routing = resolveCharacterSheetRouting(
      p,
      'anthropic',
      'legacy-ignored',
      { 'pr-reviewer': 'deep' },
      registry(),
    );

    expect(routing).toEqual({
      activeProvider: 'anthropic',
      effectiveModel: 'claude-sonnet-5',
      source: 'routing-override',
      alias: 'sonnet',
      role: { name: 'deep', bound: false },
      inert: {
        declared: 'sonnet',
        reason: '`modelRouting.pr-reviewer` in config.yaml takes priority',
      },
    });
    expect(turnModel(p, 'anthropic', 'legacy-ignored', { 'pr-reviewer': 'deep' }, registry())).toBe(
      routing.effectiveModel,
    );
  });

  it('names the alias a personality declares directly, and reports nothing unused', () => {
    const p = personality({ model: 'opus' });
    const routing = resolveCharacterSheetRouting(p, 'anthropic', 'x', {}, registry());

    expect(routing).toEqual({
      activeProvider: 'anthropic',
      effectiveModel: 'claude-opus-5',
      source: 'personality',
      alias: 'opus',
    });
    expect(turnModel(p, 'anthropic', 'x', {}, registry())).toBe('claude-opus-5');
  });

  it('names the alias and the role for a BOUND role declaration', () => {
    const p = personality({ model: 'deep' });
    const routing = resolveCharacterSheetRouting(
      p,
      'anthropic',
      'x',
      {},
      registry({ deep: 'opus' }),
    );

    expect(routing).toEqual({
      activeProvider: 'anthropic',
      effectiveModel: 'claude-opus-5',
      source: 'personality',
      alias: 'opus',
      role: { name: 'deep', bound: true },
    });
    expect(turnModel(p, 'anthropic', 'x', {}, registry({ deep: 'opus' }))).toBe('claude-opus-5');
  });

  it('names the registry default for a personality that declares nothing', () => {
    const routing = resolveCharacterSheetRouting(personality({}), 'anthropic', 'x', {}, registry());

    expect(routing).toEqual({
      activeProvider: 'anthropic',
      effectiveModel: 'claude-sonnet-5',
      source: 'global',
      alias: 'sonnet',
    });
  });

  it('carries the refusal a turn shows for an alias nothing configures', () => {
    const p = personality({ model: 'opsu' });
    const routing = resolveCharacterSheetRouting(p, 'anthropic', 'x', {}, registry());
    const turn = resolveTurnModel({
      personality: p,
      role: 'default',
      ctx: { registry: registry(), routing: {} },
      llmName: 'anthropic',
      llmModel: 'x',
    });

    expect(turn.ok).toBe(false);
    expect(routing.effectiveModel).toBeUndefined();
    expect(routing.source).toBe('personality');
    expect(routing.refusal).toContain('"opsu"');
    expect(routing.refusal).toContain('does not resolve');
    expect(routing.refusal).toContain('Configured models: sonnet, opus');
  });
});

describe('resolveCharacterSheetRouting — legacy vendor ids (D11c)', () => {
  const codex = (roles: ModelRegistry['roles'] = {}): ModelRegistry => ({
    entries: {
      'gpt-5-6-terra': {
        alias: 'gpt-5-6-terra',
        provider: 'codex-gpt-terra',
        modelId: 'gpt-5.6-terra',
      },
    },
    default: 'gpt-5-6-terra',
    roles,
  });
  const scout = personality({
    id: 'reddit-scout',
    provider: 'anthropic',
    model: { trivial: 'claude-haiku-4-5', default: 'claude-sonnet-4-6' },
  });

  it('shows a claude tier map on the default through the unbound role, with the notice the turn carries', () => {
    const routing = resolveCharacterSheetRouting(scout, 'codex', 'gpt-5.6-terra', {}, codex());
    const turn = resolveTurnModel({
      personality: scout,
      role: 'default',
      ctx: { registry: codex(), routing: {}, catalogModelId: lookupLegacyCatalogModelId },
      llmName: 'codex',
      llmModel: 'gpt-5.6-terra',
    });
    if (!turn.ok) throw new Error(turn.reason);

    if (routing.refusal !== undefined) throw new Error(routing.refusal);
    expect(routing.effectiveModel).toBe('gpt-5.6-terra');
    expect(turn.model).toBe(routing.effectiveModel);
    expect(routing.alias).toBe('gpt-5-6-terra');
    expect(routing.role).toEqual({ name: 'default', bound: false });
    // The sheet's notice is the turn's deviation, through the one renderer.
    if (!turn.deviation) throw new Error('expected the turn to carry the D11c deviation');
    const { line, fix } = describeDeviation(turn.deviation);
    expect(routing.notice).toBe(`${line} ${fix}`);
    expect(routing.notice).toContain('`model.default: default`');
  });

  it('carries the bound-role refusal the turn shows', () => {
    const routing = resolveCharacterSheetRouting(
      scout,
      'codex',
      'gpt-5.6-terra',
      {},
      codex({ default: 'gpt-5-6-terra' }),
    );

    expect(routing.effectiveModel).toBeUndefined();
    expect(routing.refusal).toContain('"claude-sonnet-4-6"');
    expect(routing.refusal).toContain('"default" role');
  });
});

describe('lookupLegacyCatalogModelId (D11c catalog seam)', () => {
  it('returns an exact catalog id', () => {
    expect(lookupLegacyCatalogModelId('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
  });

  it('reads an undated vendor alias as its dated snapshot', () => {
    expect(lookupLegacyCatalogModelId('claude-sonnet-4-5')).toBe('claude-sonnet-4-5-20250929');
  });

  it('does not guess about a near miss', () => {
    expect(lookupLegacyCatalogModelId('claude-sonnet-4')).toBeUndefined();
    expect(lookupLegacyCatalogModelId('claude-sonnet-4-6x')).toBeUndefined();
  });
});

describe('resolveActiveLlmName', () => {
  const fake = (name: string): LLMProvider =>
    ({
      name,
      model: 'm',
      supportsCaching: false,
      supportsThinking: false,
      maxContextTokens: 1000,
      complete: () => {
        throw new Error('not used');
      },
    }) as unknown as LLMProvider;

  it('is the provider name for a single-provider deployment', () => {
    expect(resolveActiveLlmName({ provider: 'codex' })).toBe('codex');
    expect(resolveActiveLlmName({ provider: 'codex', providers: [{ provider: 'codex' }] })).toBe(
      'codex',
    );
  });

  it('matches ChainedProvider.name for a fallback chain', () => {
    const config = {
      provider: 'anthropic',
      providers: [{ provider: 'anthropic' }, { provider: 'openrouter' }],
    };

    expect(resolveActiveLlmName(config)).toBe(
      new ChainedProvider([fake('anthropic'), fake('openrouter')]).name,
    );
    // It is still the name the sheet prints as `activeProvider`; what it is NO
    // LONGER is a gate on whether a declaration is read (D8).
    const p = personality({ provider: 'anthropic', model: { default: 'claude-sonnet-4-6' } });
    expect(
      resolveCharacterSheetRouting(
        p,
        resolveActiveLlmName(config),
        'claude-opus-4-7',
        {},
        undefined,
      ).activeProvider,
    ).toBe('chain(anthropic,openrouter)');
  });

  it('leaves failover:false entries out of the chain name', () => {
    const config = {
      provider: 'openrouter',
      providers: [
        { provider: 'openrouter' },
        { provider: 'anthropic' },
        { provider: 'azure', id: 'azure-eu', failover: false },
        { provider: 'ollama' },
        { provider: 'bedrock', id: 'bedrock-us', failover: false },
      ],
    };

    expect(resolveActiveLlmName(config)).toBe('chain(openrouter,anthropic,ollama)');
  });

  it('is the bare provider name when one hop remains', () => {
    expect(
      resolveActiveLlmName({
        provider: 'openrouter',
        providers: [{ provider: 'anthropic' }, { provider: 'azure', failover: false }],
      }),
    ).toBe('anthropic');
  });

  it("names the default alias's entry when every entry opts out, as the runtime serves it", () => {
    const modelRegistry: ModelRegistry = {
      entries: { vision: { alias: 'vision', provider: 'eu', modelId: 'gpt-5' } },
      default: 'vision',
      roles: {},
    };
    const providers = [
      { provider: 'anthropic', failover: false },
      { provider: 'azure', id: 'eu', failover: false },
    ];

    expect(resolveActiveLlmName({ provider: 'anthropic', providers, modelRegistry })).toBe('azure');
    expect(resolveActiveLlmName({ provider: 'anthropic', providers })).toBe('anthropic');
  });

  it('equals the name of the provider createLLM builds for the same config', async () => {
    const k = { apiKey: 'k' };
    const configs: WiringConfig[] = [
      {
        provider: 'openrouter',
        model: 'm',
        ...k,
        providers: [
          { provider: 'openrouter', model: 'm', ...k },
          { provider: 'anthropic', model: 'claude-sonnet-5', ...k },
          { provider: 'openrouter', id: 'eu', model: 'm', failover: false, ...k },
        ],
      },
      {
        provider: 'openrouter',
        model: 'm',
        ...k,
        providers: [
          { provider: 'anthropic', model: 'claude-sonnet-5', ...k },
          { provider: 'openrouter', model: 'm', failover: false, ...k },
        ],
      },
      {
        provider: 'openrouter',
        model: 'm',
        ...k,
        modelRegistry: {
          entries: { main: { alias: 'main', provider: 'b', modelId: 'claude-sonnet-5' } },
          default: 'main',
          roles: {},
        },
        providers: [
          { provider: 'openrouter', id: 'a', model: 'm', failover: false, ...k },
          { provider: 'anthropic', id: 'b', model: 'claude-sonnet-5', failover: false, ...k },
        ],
      },
    ];

    for (const config of configs) {
      expect(resolveActiveLlmName(config)).toBe((await createLLM(config)).name);
    }
  });
});
