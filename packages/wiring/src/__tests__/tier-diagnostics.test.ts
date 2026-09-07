// Lane 5(i) — tier-mismatch startup diagnostic. The resolveModelWithTier
// guard (core) silently drops a personality's tier map when the declared
// provider does not match the active LLM; wiring warns at construction. The
// guard itself STAYS — asserted here alongside each diagnostic case so the
// warning provably changes output, not behavior.

import { ChainedProvider, resolveModelWithTier } from '@ethosagent/core';
import type { LLMProvider, PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  evaluateTierMismatch,
  resolveActiveLlmName,
  resolveCharacterSheetRouting,
} from '../tier-diagnostics';

function personality(overrides: Partial<PersonalityConfig>): PersonalityConfig {
  return { id: 'researcher', name: 'Researcher', ...overrides };
}

describe('Lane 5(i) — evaluateTierMismatch', () => {
  it('warns on a tier map with a mismatched provider, naming personality, tiers, and both providers', () => {
    const p = personality({
      provider: 'anthropic',
      model: { trivial: 'claude-haiku-4-5', default: 'claude-sonnet-4-6', deep: 'claude-opus-4-7' },
    });
    const warning = evaluateTierMismatch(p, 'ollama');
    expect(warning).toBeDefined();
    expect(warning).toContain('researcher');
    expect(warning).toContain('trivial=claude-haiku-4-5');
    expect(warning).toContain('default=claude-sonnet-4-6');
    expect(warning).toContain('deep=claude-opus-4-7');
    expect(warning).toContain('"anthropic"');
    expect(warning).toContain('"ollama"');
    expect(warning).toContain('inert');

    // Behavior otherwise unchanged: the guard still drops the tiers.
    const resolved = resolveModelWithTier(p, 'trivial', {}, 'ollama', 'qwen3:8b');
    expect(resolved).toEqual({ model: 'qwen3:8b', source: 'global' });
  });

  it('warns when a tier map is declared with NO provider at all', () => {
    const p = personality({ model: { default: 'claude-sonnet-4-6' } });
    const warning = evaluateTierMismatch(p, 'ollama');
    expect(warning).toBeDefined();
    expect(warning).toContain('"(none)"');
  });

  it('stays silent on a tier map with a MATCHING provider', () => {
    const p = personality({
      provider: 'anthropic',
      model: { trivial: 'claude-haiku-4-5', default: 'claude-sonnet-4-6' },
    });
    expect(evaluateTierMismatch(p, 'anthropic')).toBeUndefined();

    // And the tiers actually apply — the guard admits them.
    const resolved = resolveModelWithTier(p, 'trivial', {}, 'anthropic', 'claude-sonnet-4-6');
    expect(resolved).toEqual({ model: 'claude-haiku-4-5', source: 'personality' });
  });

  it('stays silent on a personality with no model block — no new resolution path', () => {
    const p = personality({});
    expect(evaluateTierMismatch(p, 'ollama')).toBeUndefined();
    // Resolution is exactly the pre-diagnostic path: global model.
    const resolved = resolveModelWithTier(p, 'default', {}, 'ollama', 'qwen3:8b');
    expect(resolved).toEqual({ model: 'qwen3:8b', source: 'global' });
  });

  it('stays silent on a plain string model (not a tier map)', () => {
    const p = personality({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
    expect(evaluateTierMismatch(p, 'ollama')).toBeUndefined();
  });
});

// The read-only sibling of the startup warning: what `ethos personality show`
// and the web Personalities tab print for `## Routing`. Every case asserts the
// resolver's answer against `resolveModelWithTier`'s — the sheet may not claim
// a model the turn would not send.
describe('resolveCharacterSheetRouting', () => {
  it('reports the global model, and the tier map as inert, on a provider mismatch', () => {
    const p = personality({ provider: 'anthropic', model: { default: 'claude-sonnet-4-6' } });
    const routing = resolveCharacterSheetRouting(p, 'codex', 'gpt-5.6-terra');
    expect(routing.effectiveModel).toBe('gpt-5.6-terra');
    expect(routing.source).toBe('global');
    expect(routing.inert?.declared).toBe('default=claude-sonnet-4-6');
    expect(routing.inert?.reason).toContain('"anthropic"');
    expect(routing.inert?.reason).toContain('"codex"');
    // The enforcer agrees.
    expect(resolveModelWithTier(p, 'default', {}, 'codex', 'gpt-5.6-terra').model).toBe(
      'gpt-5.6-terra',
    );
  });

  it('reports the personality tier map when the active LLM honours it', () => {
    const p = personality({ provider: 'anthropic', model: { default: 'claude-sonnet-4-6' } });
    const routing = resolveCharacterSheetRouting(p, 'anthropic', 'claude-opus-4-7');
    expect(routing).toEqual({
      activeProvider: 'anthropic',
      effectiveModel: 'claude-sonnet-4-6',
      source: 'personality',
    });
  });

  it('calls a plain string `model:` inert whatever the provider says — the guard reads a map only', () => {
    const p = personality({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
    const routing = resolveCharacterSheetRouting(p, 'anthropic', 'claude-opus-4-7');
    expect(routing.effectiveModel).toBe('claude-opus-4-7');
    expect(routing.source).toBe('global');
    expect(routing.inert?.declared).toBe('claude-sonnet-4-6');
    expect(routing.inert?.reason).toContain('tier map only');
    // Not the resolver being pessimistic: turn-context really does drop it.
    expect(resolveModelWithTier(p, 'default', {}, 'anthropic', 'claude-opus-4-7')).toEqual({
      model: 'claude-opus-4-7',
      source: 'global',
    });
  });

  it('names a modelRouting entry as the winning source and the declaration as inert', () => {
    const p = personality({ provider: 'anthropic', model: { default: 'claude-sonnet-4-6' } });
    const routing = resolveCharacterSheetRouting(p, 'anthropic', 'claude-opus-4-7', {
      researcher: 'claude-haiku-4-5',
    });
    expect(routing.effectiveModel).toBe('claude-haiku-4-5');
    expect(routing.source).toBe('routing-override');
    expect(routing.inert?.reason).toContain('modelRouting.researcher');
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

  it('matches ChainedProvider.name for a fallback chain — so every tier map reads inert', () => {
    const config = {
      provider: 'anthropic',
      providers: [{ provider: 'anthropic' }, { provider: 'openrouter' }],
    };
    expect(resolveActiveLlmName(config)).toBe(
      new ChainedProvider([fake('anthropic'), fake('openrouter')]).name,
    );
    const p = personality({ provider: 'anthropic', model: { default: 'claude-sonnet-4-6' } });
    expect(
      resolveCharacterSheetRouting(p, resolveActiveLlmName(config), 'claude-opus-4-7').source,
    ).toBe('global');
  });
});
