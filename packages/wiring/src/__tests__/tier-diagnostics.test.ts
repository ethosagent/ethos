// What `## Routing` on the character sheet claims, asserted against the
// function the TURN calls — the sheet may not name a model the turn would not
// send.
//
// `evaluateTierMismatch` and its cases are gone with the guard they described
// (D8/T1.7): `personality.provider === llmName` made every tier map inert on a
// chained deployment and every plain-string declaration inert everywhere, and
// a warning about a silent drop is worth nothing once the drop is fixed.
//
// These cases still run against an EMPTY registry, which is what the sheet is
// handed until T1.8 assembles a `ModelResolutionContext` from config and T1.11
// renders the full rung chain. On that path `resolveTurnModel` is the D11b
// legacy shim: `modelRouting` wins, otherwise the deployment default, and a
// personality declaration reads as inert — which is exactly what a turn on a
// registry-less deployment does.

import { ChainedProvider, resolveTurnModel } from '@ethosagent/core';
import type { LLMProvider, PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { resolveActiveLlmName, resolveCharacterSheetRouting } from '../tier-diagnostics';

function personality(overrides: Partial<PersonalityConfig>): PersonalityConfig {
  return { id: 'researcher', name: 'Researcher', ...overrides };
}

/** What the TURN would send for this personality on a registry-less deployment. */
function turnModel(
  p: PersonalityConfig,
  activeProvider: string,
  globalModel: string,
  routing: Record<string, string> = {},
): string {
  const resolved = resolveTurnModel({
    personality: p,
    role: 'default',
    ctx: { registry: { entries: {}, roles: {} }, routing },
    llmName: activeProvider,
    llmModel: globalModel,
  });
  if (!resolved.ok) throw new Error('unexpected refusal');
  return resolved.model;
}

describe('resolveCharacterSheetRouting', () => {
  it('reports the deployment default, and the declaration as inert, while no registry exists', () => {
    const p = personality({ provider: 'anthropic', model: { default: 'claude-sonnet-4-6' } });
    const routing = resolveCharacterSheetRouting(p, 'codex', 'gpt-5.6-terra');

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
    // alias against, the declaration is inert either way — and the turn does
    // the same, which is the property that matters.
    const p = personality({ provider: 'anthropic', model: { default: 'claude-sonnet-4-6' } });
    const routing = resolveCharacterSheetRouting(p, 'anthropic', 'claude-opus-4-7');

    expect(routing.effectiveModel).toBe('claude-opus-4-7');
    expect(routing.source).toBe('global');
    expect(turnModel(p, 'anthropic', 'claude-opus-4-7')).toBe('claude-opus-4-7');
  });

  it('calls a plain string `model:` inert too, and the turn drops it identically', () => {
    const p = personality({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
    const routing = resolveCharacterSheetRouting(p, 'anthropic', 'claude-opus-4-7');

    expect(routing.effectiveModel).toBe('claude-opus-4-7');
    expect(routing.source).toBe('global');
    expect(routing.inert?.declared).toBe('claude-sonnet-4-6');
    expect(turnModel(p, 'anthropic', 'claude-opus-4-7')).toBe('claude-opus-4-7');
  });

  it('names a modelRouting entry as the winning source and the declaration as inert', () => {
    const p = personality({ provider: 'anthropic', model: { default: 'claude-sonnet-4-6' } });
    const routing = resolveCharacterSheetRouting(p, 'anthropic', 'claude-opus-4-7', {
      researcher: 'claude-haiku-4-5',
    });

    expect(routing.effectiveModel).toBe('claude-haiku-4-5');
    expect(routing.source).toBe('routing-override');
    expect(routing.inert?.reason).toContain('modelRouting.researcher');
    expect(turnModel(p, 'anthropic', 'claude-opus-4-7', { researcher: 'claude-haiku-4-5' })).toBe(
      'claude-haiku-4-5',
    );
  });

  it('claims nothing inert for a personality that declares no model', () => {
    const routing = resolveCharacterSheetRouting(personality({}), 'codex', 'gpt-5.6-terra');

    expect(routing).toEqual({
      activeProvider: 'codex',
      effectiveModel: 'gpt-5.6-terra',
      source: 'global',
    });
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
      resolveCharacterSheetRouting(p, resolveActiveLlmName(config), 'claude-opus-4-7')
        .activeProvider,
    ).toBe('chain(anthropic,openrouter)');
  });
});
