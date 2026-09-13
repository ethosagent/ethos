// `validateModelRegistry` — the refusals the `modelRegistry.*` codec
// deliberately does not make (plan/phases/model-registry.md T1.3).
//
// The codec builds an entry missing `provider` or `modelId` with `''` in the
// missing slot and lets a dangling `default` through, so every assertion here
// is on a registry shaped exactly the way `parseConfigYaml` would hand one over.
//
// Every message is asserted to name BOTH the offending alias and the configured
// set: a refusal that does not say what WOULD have worked makes the operator go
// read a file.

import type { ModelRegistry, ModelRegistryEntry } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import type { ProviderChainEntry } from '../index';
import { validateModelRegistry } from '../model-registry';

function entry(alias: string, fields: Partial<ModelRegistryEntry> = {}): ModelRegistryEntry {
  return {
    alias,
    provider: fields.provider ?? 'anthropic-work',
    modelId: fields.modelId ?? `${alias}-vendor-id`,
    ...(fields.fallbacks ? { fallbacks: fields.fallbacks } : {}),
  };
}

function registryOf(
  entries: ModelRegistryEntry[],
  rest: Partial<Pick<ModelRegistry, 'default' | 'roles'>> = {},
): ModelRegistry {
  return {
    entries: Object.fromEntries(entries.map((e) => [e.alias, e])),
    ...(rest.default ? { default: rest.default } : {}),
    roles: rest.roles ?? {},
  };
}

/** Two entries, both explicitly keyed — the shape D24 says every alias needs. */
const chain: ProviderChainEntry[] = [
  { provider: 'anthropic', id: 'anthropic-work', apiKey: 'sk' },
  { provider: 'ollama', id: 'local', baseUrl: 'http://127.0.0.1:11434/v1' },
];

describe('validateModelRegistry', () => {
  it('a valid registry produces no problems', () => {
    const registry = registryOf(
      [
        entry('sonnet', { fallbacks: ['sonnet-eu'] }),
        entry('sonnet-eu'),
        entry('qwen', { provider: 'local', modelId: 'qwen2.5-coder:32b' }),
      ],
      { default: 'sonnet', roles: { deep: 'sonnet', trivial: 'qwen' } },
    );
    expect(validateModelRegistry(registry, chain)).toEqual([]);
  });

  it('an absent registry produces no problems', () => {
    expect(validateModelRegistry(undefined, chain)).toEqual([]);
  });

  it('unknown provider key is refused, naming the alias and the configured set', () => {
    const registry = registryOf([entry('sonnet', { provider: 'anthropic-personal' })]);
    const problems = validateModelRegistry(registry, chain);
    expect(problems.map((p) => p.code)).toEqual(['unknown_provider_key']);
    const [problem] = problems;
    expect(problem?.alias).toBe('sonnet');
    expect(problem?.key).toBe('modelRegistry.sonnet.provider');
    expect(problem?.message).toContain('"sonnet"');
    expect(problem?.message).toContain('anthropic-personal');
    // The configured set, both halves: the models and the provider entries.
    expect(problem?.message).toContain('Configured models: sonnet.');
    expect(problem?.message).toContain('anthropic-work');
    expect(problem?.message).toContain('local');
  });

  it('missing modelId is refused with the line to add', () => {
    const registry = registryOf([entry('sonnet', { modelId: '' })]);
    const problems = validateModelRegistry(registry, chain);
    expect(problems.map((p) => p.code)).toEqual(['missing_model_id']);
    expect(problems[0]?.alias).toBe('sonnet');
    expect(problems[0]?.message).toContain('"sonnet"');
    expect(problems[0]?.message).toContain('Configured models: sonnet.');
    expect(problems[0]?.fix).toBe('modelRegistry.sonnet.modelId: <vendor model id>');
  });

  it('missing provider is refused with the line to add', () => {
    const registry = registryOf([entry('sonnet', { provider: '' })]);
    const problems = validateModelRegistry(registry, chain);
    expect(problems.map((p) => p.code)).toEqual(['missing_provider']);
    expect(problems[0]?.message).toContain('"sonnet"');
    expect(problems[0]?.message).toContain('Configured models: sonnet.');
    expect(problems[0]?.message).toContain('anthropic-work');
    expect(problems[0]?.fix).toBe('modelRegistry.sonnet.provider: <provider entry id>');
  });

  it('reserved alias name is refused', () => {
    // D1 — roles and aliases share one namespace, so the four role names are
    // reserved. The codec drops `modelRegistry.roles.<role>` lines into the role
    // map, but `modelRegistry.deep.provider` builds an ALIAS called `deep`.
    const registry = registryOf([entry('deep'), entry('sonnet')]);
    const problems = validateModelRegistry(registry, chain);
    expect(problems.map((p) => p.code)).toEqual(['reserved_alias']);
    expect(problems[0]?.alias).toBe('deep');
    expect(problems[0]?.message).toContain('"deep"');
    expect(problems[0]?.message).toContain('trivial, default, deep, dreaming');
    expect(problems[0]?.message).toContain('Configured models: deep, sonnet.');
  });

  it('an alias the config reader could not read back is refused', () => {
    // The codec's own parse branch claims `[A-Za-z0-9_-]+` only, so an alias
    // with a space renders a line no reader claims — the entry would be gone on
    // the next read. `renderModelRegistry` names this gap and leaves it here.
    const registry = registryOf([entry('my model'), entry('sonnet')]);
    const problems = validateModelRegistry(registry, chain);
    expect(problems.map((p) => p.code)).toEqual(['invalid_alias']);
    expect(problems[0]?.alias).toBe('my model');
    expect(problems[0]?.message).toContain('"my model"');
    expect(problems[0]?.message).toContain('[A-Za-z0-9_-]+');
    expect(problems[0]?.message).toContain('Configured models: my model, sonnet.');
  });

  it('unknown default is refused, and says which of the two default keys it is', () => {
    const registry = registryOf([entry('sonnet')], { default: 'opus' });
    const problems = validateModelRegistry(registry, chain);
    expect(problems.map((p) => p.code)).toEqual(['unknown_default']);
    expect(problems[0]?.alias).toBe('opus');
    expect(problems[0]?.key).toBe('modelRegistry.default');
    expect(problems[0]?.message).toContain('"opus"');
    expect(problems[0]?.message).toContain('Configured models: sonnet.');
    // `MODEL_ROLE_NAMES` contains `default`, so the two keys are both legal and
    // mean different rungs. The refusal says so rather than leaving the operator
    // to discover it.
    expect(problems[0]?.message).toContain('`modelRegistry.roles.default`');
    expect(problems[0]?.message).toContain('rung 5');
    expect(problems[0]?.message).toContain('rung 4');
  });

  it('unknown role binding is refused, naming the role, the alias and the configured set', () => {
    const registry = registryOf([entry('sonnet')], { default: 'sonnet', roles: { deep: 'opus' } });
    const problems = validateModelRegistry(registry, chain);
    expect(problems.map((p) => p.code)).toEqual(['unknown_role_binding']);
    expect(problems[0]?.alias).toBe('opus');
    expect(problems[0]?.key).toBe('modelRegistry.roles.deep');
    expect(problems[0]?.message).toContain('"opus"');
    expect(problems[0]?.message).toContain('Configured models: sonnet.');
    // Only the `default` role carries the disambiguation.
    expect(problems[0]?.message).not.toContain('rung 5');
  });

  it('an unknown roles.default binding disambiguates itself from modelRegistry.default', () => {
    const registry = registryOf([entry('sonnet')], {
      default: 'sonnet',
      roles: { default: 'opus' },
    });
    const problems = validateModelRegistry(registry, chain);
    expect(problems.map((p) => p.code)).toEqual(['unknown_role_binding']);
    expect(problems[0]?.key).toBe('modelRegistry.roles.default');
    expect(problems[0]?.message).toContain('`modelRegistry.default`');
    expect(problems[0]?.message).toContain('`modelRegistry.roles.default`');
  });

  it('a roster key naming a role instead of a model is refused by the same grammar', () => {
    // D25 — the wrapper over `parseModelDeclaration` reads these values, so a
    // role name here is recognised as a role rather than reported as a typo.
    const registry = registryOf([entry('sonnet')], { default: 'deep' });
    const problems = validateModelRegistry(registry, chain);
    expect(problems.map((p) => p.code)).toEqual(['unknown_default']);
    expect(problems[0]?.message).toContain('which is a role name and not a model');
    expect(problems[0]?.message).toContain('Configured models: sonnet.');
  });

  it('fallback across providers is refused', () => {
    // D6 — an expired local token must not become an egress event to a cloud
    // provider. Cross-provider failover stays the `providers.*` chain's job.
    const registry = registryOf([
      entry('qwen', { provider: 'local', modelId: 'qwen2.5-coder:32b', fallbacks: ['sonnet'] }),
      entry('qwen-small', { provider: 'local', modelId: 'qwen2.5-coder:7b' }),
      entry('sonnet'),
    ]);
    const problems = validateModelRegistry(registry, chain);
    expect(problems.map((p) => p.code)).toEqual(['cross_provider_fallback']);
    expect(problems[0]?.alias).toBe('qwen');
    expect(problems[0]?.message).toContain('"qwen"');
    expect(problems[0]?.message).toContain('"sonnet"');
    expect(problems[0]?.message).toContain('anthropic-work');
    expect(problems[0]?.message).toContain('local');
    // What WOULD have worked: the aliases on the same provider entry.
    expect(problems[0]?.message).toContain('Models on "local": qwen-small.');
    expect(problems[0]?.message).toContain('Configured models: qwen, qwen-small, sonnet.');
  });

  it('a fallback naming no configured model is refused', () => {
    const registry = registryOf([entry('sonnet', { fallbacks: ['sonnet-eu'] })]);
    const problems = validateModelRegistry(registry, chain);
    expect(problems.map((p) => p.code)).toEqual(['unknown_fallback']);
    expect(problems[0]?.message).toContain('"sonnet"');
    expect(problems[0]?.message).toContain('"sonnet-eu"');
    expect(problems[0]?.message).toContain('Configured models: sonnet.');
  });

  it('an alias cycle is refused once, with the whole path', () => {
    const registry = registryOf([
      entry('a', { fallbacks: ['b'] }),
      entry('b', { fallbacks: ['c'] }),
      entry('c', { fallbacks: ['a'] }),
    ]);
    const problems = validateModelRegistry(registry, chain);
    expect(problems.map((p) => p.code)).toEqual(['alias_cycle']);
    expect(problems[0]?.alias).toBe('a');
    expect(problems[0]?.message).toContain('a → b → c → a');
    expect(problems[0]?.message).toContain('Configured models: a, b, c.');
  });

  it('a model declaring itself as its own fallback is a cycle', () => {
    const registry = registryOf([entry('sonnet', { fallbacks: ['sonnet'] })]);
    const problems = validateModelRegistry(registry, chain);
    expect(problems.map((p) => p.code)).toEqual(['alias_cycle']);
    expect(problems[0]?.message).toContain('sonnet → sonnet');
  });

  it('an alias referencing an entry with no explicit id is refused with the line to add', () => {
    // D24 — the derived key is positional. Naming one binds an alias to a chain
    // POSITION, and a reorder then dangles it. The refusal names the entry's
    // index and the exact line that fixes it.
    const derivedChain: ProviderChainEntry[] = [
      { provider: 'anthropic', apiKey: 'sk' },
      { provider: 'ollama', id: 'local' },
    ];
    const registry = registryOf([entry('sonnet', { provider: 'anthropic' })]);
    const problems = validateModelRegistry(registry, derivedChain);
    expect(problems.map((p) => p.code)).toEqual(['derived_provider_key']);
    expect(problems[0]?.alias).toBe('sonnet');
    expect(problems[0]?.message).toContain('"sonnet"');
    expect(problems[0]?.message).toContain('"anthropic"');
    expect(problems[0]?.message).toContain('providers.0');
    expect(problems[0]?.message).toContain('Configured models: sonnet.');
    expect(problems[0]?.message).toContain('local');
    expect(problems[0]?.fix).toBe('providers.0.id: anthropic');
  });

  it('a derived key at a later index is refused with that index in the line to add', () => {
    const derivedChain: ProviderChainEntry[] = [
      { provider: 'anthropic', id: 'anthropic-work' },
      { provider: 'anthropic', apiKey: 'sk2' },
    ];
    const registry = registryOf([entry('opus', { provider: 'anthropic-1' })]);
    const problems = validateModelRegistry(registry, derivedChain);
    expect(problems.map((p) => p.code)).toEqual(['derived_provider_key']);
    expect(problems[0]?.fix).toBe('providers.1.id: anthropic-1');
  });

  it('reordering the chain leaves every alias resolving to the same entry', () => {
    // The point of D24, stated as a test: with an explicit `id:` on every entry,
    // the ordinary operation of changing failover priority is not a fleet-wide
    // outage.
    const registry = registryOf(
      [
        entry('sonnet', { provider: 'anthropic-work' }),
        entry('qwen', { provider: 'local', modelId: 'qwen2.5-coder:32b' }),
      ],
      { default: 'sonnet', roles: { trivial: 'qwen' } },
    );
    const reordered: ProviderChainEntry[] = [chain[1], chain[0]].filter(
      (e): e is ProviderChainEntry => e !== undefined,
    );

    expect(validateModelRegistry(registry, chain)).toEqual([]);
    expect(validateModelRegistry(registry, reordered)).toEqual([]);
    // "Resolving to the same entry" is the provider key each alias names, which
    // the reorder did not touch.
    expect(registry.entries.sonnet?.provider).toBe('anthropic-work');
    expect(registry.entries.qwen?.provider).toBe('local');
    expect(reordered.map((e) => e.id)).toEqual(['local', 'anthropic-work']);
  });

  it('two entries of the same provider type are distinguishable by id alone', () => {
    const twoAccounts: ProviderChainEntry[] = [
      { provider: 'anthropic', id: 'anthropic-work', apiKey: 'sk-work' },
      { provider: 'anthropic', id: 'anthropic-personal', apiKey: 'sk-personal' },
    ];
    const registry = registryOf([
      entry('sonnet', { provider: 'anthropic-work' }),
      entry('sonnet-personal', { provider: 'anthropic-personal' }),
    ]);
    expect(validateModelRegistry(registry, twoAccounts)).toEqual([]);
  });

  it('reports every problem in one pass rather than stopping at the first', () => {
    const registry = registryOf(
      [
        entry('sonnet', { provider: 'nope', modelId: '' }),
        entry('deep'),
        entry('qwen', { provider: 'local', modelId: 'q', fallbacks: ['sonnet'] }),
      ],
      { default: 'opus', roles: { deep: 'haiku' } },
    );
    expect(validateModelRegistry(registry, chain).map((p) => p.code)).toEqual([
      'missing_model_id',
      'unknown_provider_key',
      'reserved_alias',
      'unknown_default',
      'unknown_role_binding',
      'cross_provider_fallback',
    ]);
  });
});
