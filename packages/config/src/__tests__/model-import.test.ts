import type { ModelRegistry } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  type ChainModelImportSource,
  type ProviderChainEntry,
  parseConfigYaml,
  planChainModelImport,
  slugifyModelAlias,
  uniqueModelAlias,
  validateModelRegistry,
} from '../index';

// D11(a) — the one chain-model importer (plan/phases/model-registry.md).

/** A `${secrets:…}` reference, assembled so no string literal carries `${`. */
function ref(path: string): string {
  return ['${', 'secrets:', path, '}'].join('');
}

/** The user's real config: a chain model and NO registry. */
const USER_CONFIG = [
  'provider: codex',
  'model: gpt-5.6-terra',
  'personality: researcher',
  'providers.0.provider: codex',
  'providers.0.id: codex-gpt-terra',
  'providers.0.model: gpt-5.6-terra',
].join('\n');

const catalog = (provider: string, modelId: string) =>
  provider === 'codex' && modelId === 'gpt-5.6-terra'
    ? { label: 'everyday, balanced', contextWindow: 1_050_000 }
    : undefined;

function registry(entries: ModelRegistry['entries'], extra: Partial<ModelRegistry> = {}) {
  return { entries, roles: {}, ...extra } satisfies ModelRegistry;
}

describe('slugifyModelAlias / uniqueModelAlias', () => {
  it('maps a vendor id into the alias charset', () => {
    expect(slugifyModelAlias('gpt-5.6-terra')).toBe('gpt-5-6-terra');
    expect(slugifyModelAlias('qwen2.5-coder:32b')).toBe('qwen2-5-coder-32b');
    expect(slugifyModelAlias('Qwen/Qwen2.5--72B')).toBe('qwen-qwen2-5-72b');
    expect(slugifyModelAlias('  .claude.  ')).toBe('claude');
    expect(slugifyModelAlias('...')).toBe('model');
    expect(slugifyModelAlias('snake_case_id')).toBe('snake_case_id');
  });

  it('suffixes with the provider key on collision, then counts', () => {
    expect(uniqueModelAlias('gpt-4o', 'work', new Set())).toBe('gpt-4o');
    expect(uniqueModelAlias('gpt-4o', 'work', new Set(['gpt-4o']))).toBe('gpt-4o-work');
    expect(uniqueModelAlias('gpt-4o', 'work', new Set(['gpt-4o', 'gpt-4o-work']))).toBe(
      'gpt-4o-work-2',
    );
  });

  it('never returns a role name or an object-model key', () => {
    for (const reserved of ['default', 'deep', 'trivial', 'dreaming', 'constructor']) {
      expect(uniqueModelAlias(reserved, 'local', new Set())).toBe(`${reserved}-local`);
    }
    expect(uniqueModelAlias('__proto__', 'local', new Set())).toBe('__proto__-local');
  });
});

describe('planChainModelImport', () => {
  it("adopts the user's chain model: alias gpt-5-6-terra on codex-gpt-terra, default set", () => {
    const config = parseConfigYaml(USER_CONFIG);
    const plan = planChainModelImport(config, { lookupCatalog: catalog });

    expect(plan.candidates).toEqual([
      {
        providerKey: 'codex-gpt-terra',
        index: 0,
        provider: 'codex',
        modelId: 'gpt-5.6-terra',
        suggestedAlias: 'gpt-5-6-terra',
        idIsExplicit: true,
      },
    ]);
    expect(plan.adopted).toEqual([
      { alias: 'gpt-5-6-terra', providerKey: 'codex-gpt-terra', modelId: 'gpt-5.6-terra' },
    ]);
    expect(plan.defaultSet).toBe('gpt-5-6-terra');
    expect(plan.idsWritten).toEqual([]);
    expect(plan.registry).toEqual({
      entries: {
        'gpt-5-6-terra': {
          alias: 'gpt-5-6-terra',
          provider: 'codex-gpt-terra',
          modelId: 'gpt-5.6-terra',
          label: 'everyday, balanced',
          contextWindow: 1_050_000,
        },
      },
      roles: {},
      default: 'gpt-5-6-terra',
    });
    // The chain already had its id: nothing about it changes.
    expect(plan.providers).toEqual(config.providers);
    expect(plan.diff).toEqual([
      '+ modelRegistry.gpt-5-6-terra.provider: codex-gpt-terra',
      '+ modelRegistry.gpt-5-6-terra.modelId: gpt-5.6-terra',
      '+ modelRegistry.gpt-5-6-terra.label: everyday, balanced',
      '+ modelRegistry.gpt-5-6-terra.contextWindow: 1050000',
      '+ modelRegistry.default: gpt-5-6-terra',
    ]);
    expect(validateModelRegistry(plan.registry, plan.providers)).toEqual([]);
  });

  it('is a no-op once applied', () => {
    const config = parseConfigYaml(USER_CONFIG);
    const first = planChainModelImport(config, { lookupCatalog: catalog });
    const again = planChainModelImport(
      { ...config, providers: first.providers, modelRegistry: first.registry },
      { lookupCatalog: catalog },
    );
    expect(again.candidates).toEqual([]);
    expect(again.adopted).toEqual([]);
    expect(again.diff).toEqual([]);
    expect(again.defaultSet).toBeNull();
    expect(again.registry).toBe(first.registry);
  });

  it('writes an explicit id for an adopted entry that has none, and lists it in the diff', () => {
    const plan = planChainModelImport({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      providers: [
        { provider: 'anthropic', id: 'work', model: 'claude-sonnet-5' },
        { provider: 'openai', model: 'gpt-4o', apiKey: ref('providers/1/openai/apiKey') },
      ],
    });
    expect(plan.candidates.map((c) => [c.providerKey, c.suggestedAlias, c.idIsExplicit])).toEqual([
      ['work', 'claude-sonnet-5', true],
      ['openai-1', 'gpt-4o', false],
    ]);
    expect(plan.idsWritten).toEqual(['openai-1']);
    expect(plan.providers[1]?.id).toBe('openai-1');
    expect(plan.diff).toContain('+ providers.1.id: openai-1');
    expect(plan.defaultSet).toBe('claude-sonnet-5');
    expect(validateModelRegistry(plan.registry, plan.providers)).toEqual([]);
  });

  it('does not take an id another entry already claims', () => {
    const plan = planChainModelImport({
      providers: [
        { provider: 'anthropic', model: 'claude-sonnet-5' },
        { provider: 'anthropic', id: 'anthropic', model: 'claude-opus-5' },
      ],
    });
    expect(plan.providers.map((p) => p.id)).toEqual(['anthropic-2', 'anthropic']);
    expect(validateModelRegistry(plan.registry, plan.providers)).toEqual([]);
  });

  it('suffixes an alias with the provider key on collision', () => {
    const plan = planChainModelImport({
      providers: [
        { provider: 'openai', id: 'personal', model: 'gpt-4o' },
        { provider: 'openai', id: 'work', model: 'gpt-4o' },
      ],
      modelRegistry: registry(
        { 'gpt-4o-old': { alias: 'gpt-4o-old', provider: 'personal', modelId: 'gpt-4' } },
        { default: 'gpt-4o-old' },
      ),
    });
    expect(plan.adopted.map((a) => a.alias)).toEqual(['gpt-4o', 'gpt-4o-work']);
    // An existing default is never replaced.
    expect(plan.defaultSet).toBeNull();
    expect(plan.registry?.default).toBe('gpt-4o-old');
  });

  it('skips a pair the registry already has, an entry without a model, and keeps roles', () => {
    const plan = planChainModelImport({
      providers: [
        { provider: 'anthropic', id: 'work', model: 'claude-sonnet-5' },
        { provider: 'ollama', id: 'local' },
        { provider: 'openai', id: 'oa', model: 'gpt-4o' },
      ],
      modelRegistry: registry(
        { sonnet: { alias: 'sonnet', provider: 'work', modelId: 'claude-sonnet-5' } },
        { roles: { deep: 'sonnet' } },
      ),
    });
    expect(plan.candidates.map((c) => c.providerKey)).toEqual(['oa']);
    expect(plan.registry?.roles).toEqual({ deep: 'sonnet' });
    // No default existed: entry 0's model is already present as `sonnet`.
    expect(plan.defaultSet).toBe('sonnet');
  });

  it('materializes a top-level-only config as providers.0 with an explicit id', () => {
    const plan = planChainModelImport({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      apiKey: ref('providers/anthropic/apiKey'),
      region: 'eu-west-1',
    });
    expect(plan.candidates[0]).toMatchObject({ providerKey: 'anthropic', idIsExplicit: false });
    expect(plan.providers).toEqual([
      {
        provider: 'anthropic',
        id: 'anthropic',
        apiKey: ref('providers/anthropic/apiKey'),
        model: 'claude-sonnet-5',
        region: 'eu-west-1',
      },
    ] satisfies ProviderChainEntry[]);
    expect(plan.idsWritten).toEqual(['anthropic']);
    expect(plan.defaultSet).toBe('claude-sonnet-5');
    expect(plan.diff).toContain(`+ providers.0.apiKey: ${ref('providers/anthropic/apiKey')}`);
    expect(validateModelRegistry(plan.registry, plan.providers)).toEqual([]);
  });

  it('never prints a plaintext credential in the diff', () => {
    const plan = planChainModelImport({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      apiKey: 'sk-ant-plaintext-0123456789',
    });
    expect(plan.diff.join('\n')).not.toContain('sk-ant-plaintext');
    expect(plan.diff).toContain('+ providers.0.apiKey: <redacted>');
  });

  it('adopts only the selected provider keys, and still reports every candidate', () => {
    const source: ChainModelImportSource = {
      providers: [
        { provider: 'anthropic', id: 'work', model: 'claude-sonnet-5' },
        { provider: 'openai', id: 'oa', model: 'gpt-4o' },
      ],
    };
    const plan = planChainModelImport(source, { providerKeys: ['oa'] });
    expect(plan.candidates).toHaveLength(2);
    expect(plan.adopted.map((a) => a.alias)).toEqual(['gpt-4o']);
    // Entry 0 has no alias and the registry was empty: the first adopted alias
    // becomes the default, so the roster is never non-empty without one.
    expect(plan.defaultSet).toBe('gpt-4o');

    const none = planChainModelImport(source, { providerKeys: ['nope'] });
    expect(none.adopted).toEqual([]);
    expect(none.diff).toEqual([]);
  });

  it('does not mutate its input', () => {
    const providers = [{ provider: 'openai', model: 'gpt-4o' }];
    const snapshot = structuredClone(providers);
    planChainModelImport({ providers });
    expect(providers).toEqual(snapshot);
  });

  it('plans nothing for a config with no provider at all', () => {
    const plan = planChainModelImport({});
    expect(plan).toMatchObject({ candidates: [], adopted: [], diff: [], providers: [] });
  });
});
