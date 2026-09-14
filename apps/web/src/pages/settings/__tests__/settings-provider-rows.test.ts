import { describe, expect, it } from 'vitest';
import { getCatalogEntry, PROVIDER_CATALOG } from '../../../onboarding/catalog/providers';
import {
  addedProviderMessage,
  addProviderRequest,
  aliasFromModelId,
  catalogPicks,
  connectBlocker,
  connectFields,
  extraFieldValues,
  fallbackModelChoice,
  importLines,
  orderLabel,
  parseModelIds,
  previewAliases,
  providerAuthView,
  providerExtraFields,
  providerGroups,
  SETTINGS_PROVIDER_TYPES,
  settingsProviderType,
  unadoptedBannerText,
  uniqueAlias,
  uniqueProviderId,
} from '../lib/providers-and-models';
import { CATALOG, chainModel, entry, providerEntry, registryList } from './model-registry-fixture';

// Settings → Models › providers & models, the pure half (the approved
// "Providers & models" mockup). What the DOM does with these is pinned in
// `models-pane.test.ts`.

describe('providerGroups', () => {
  it('groups every model under its provider, in chain order', () => {
    const list = registryList({
      providerEntries: [
        providerEntry('local-ollama', 1, 'ollama'),
        providerEntry('anthropic-work', 0, 'anthropic'),
      ],
    });
    const { groups, orphans } = providerGroups(list);
    expect(groups.map((g) => [g.entry.key, g.position, g.models.map((m) => m.alias)])).toEqual([
      ['anthropic-work', 0, ['sonnet', 'opus']],
      ['local-ollama', 1, ['qwen']],
    ]);
    // `gpt` names `openai-main`, which this chain no longer has. Never hidden.
    expect(orphans.map((m) => m.alias)).toEqual(['gpt']);
    expect(groups.map((g) => orderLabel(g.position))).toEqual(['Primary', 'Fallback 1']);
  });

  it('puts a chain model not in the registry under the provider at its chain position', () => {
    const pending = chainModel({ providerKey: 'anthropic', index: 3, modelId: 'claude-opus-4-7' });
    const { groups } = providerGroups(registryList({ chainModels: [pending] }));
    expect(groups.find((g) => g.entry.index === 3)?.pending).toEqual([pending]);
    expect(groups.filter((g) => g.pending.length > 0)).toHaveLength(1);
  });
});

describe('the provider header', () => {
  it('reads the credential, and names device auth rather than a missing key', () => {
    expect(providerAuthView({ provider: 'anthropic', credential: 'set' }).text).toBe('✓ key set');
    expect(providerAuthView({ provider: 'openai', credential: 'missing' }).text).toBe('✗ no key');
    expect(providerAuthView({ provider: 'codex', credential: 'not_needed' }).text).toBe(
      'device auth, no key',
    );
    expect(providerAuthView({ provider: 'ollama', credential: 'not_needed' }).text).toBe(
      'no key needed',
    );
    expect(providerAuthView({ provider: 'bedrock', credential: 'not_needed' }).text).toBe(
      'AWS credentials, no key',
    );
  });

  it('matches the Fallback model to one of this provider’s own models by model id', () => {
    const models = [entry('sonnet', 'w', 'claude-sonnet-5'), entry('opus', 'w', 'claude-opus-5')];
    const at = (model: string | null) =>
      fallbackModelChoice({ entry: providerEntry('w', 0, 'anthropic', { model }), models });
    expect(at('claude-opus-5')).toEqual({ alias: 'opus', unmatched: null });
    expect(at(null)).toEqual({ alias: null, unmatched: null });
    expect(at('claude-3-haiku')).toEqual({ alias: null, unmatched: 'claude-3-haiku' });
  });
});

describe('Add all to models', () => {
  it('says one or many, as the mockup words it', () => {
    expect(unadoptedBannerText(1).lead).toBe("1 model in your provider chain isn't in models yet.");
    expect(unadoptedBannerText(2)).toEqual({
      lead: "2 models in your provider chain aren't in models yet.",
      rest: 'Turns already run on them; adding them lets personalities and roles choose them.',
    });
  });

  it('lists the providers.N.id line only for an entry that has no explicit id', () => {
    expect(
      importLines([
        chainModel({ suggestedAlias: 'gpt-5-6-terra', providerKey: 'codex-gpt-terra', index: 0 }),
        chainModel({
          suggestedAlias: 'llama3',
          providerKey: 'openrouter-1',
          index: 1,
          modelId: 'meta/llama3',
          idIsExplicit: false,
        }),
      ]),
    ).toEqual([
      {
        alias: 'gpt-5-6-terra',
        providerKey: 'codex-gpt-terra',
        modelId: 'gpt-5.6-terra',
        writesId: null,
      },
      {
        alias: 'llama3',
        providerKey: 'openrouter-1',
        modelId: 'meta/llama3',
        writesId: 'providers.1.id: openrouter-1',
      },
    ]);
  });
});

describe('Add provider — aliases and ids', () => {
  it('slugs a model id the way the mockup previews it', () => {
    expect(aliasFromModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(aliasFromModelId('gpt-5.6-terra')).toBe('gpt-5-6-terra');
    expect(aliasFromModelId('qwen2.5-coder:32b')).toBe('qwen2-5-coder-32b');
  });

  it('appends the provider id on a collision, and never proposes a role name', () => {
    expect(uniqueAlias('sonnet', 'anthropic-personal', new Set(['sonnet']))).toBe(
      'sonnet-anthropic-personal',
    );
    expect(uniqueAlias('deep', 'p', new Set())).toBe('deep-p');
    expect(uniqueAlias('x', 'p', new Set(['x', 'x-p']))).toBe('x-p-2');
  });

  it('previews each chosen id, keeping a typed alias and de-duplicating within the list', () => {
    expect(
      previewAliases(
        ['claude-sonnet-5', 'claude-sonnet-5-20250101', 'claude-opus-5'],
        'anthropic-personal',
        ['opus-x'],
        { 'claude-opus-5': ' big ' },
      ),
    ).toEqual({
      'claude-sonnet-5': 'claude-sonnet-5',
      'claude-sonnet-5-20250101': 'claude-sonnet-5-anthropic-personal',
      'claude-opus-5': 'big',
    });
  });

  it('prefills a provider id that is not taken', () => {
    expect(uniqueProviderId('anthropic', ['anthropic-work'])).toBe('anthropic');
    expect(uniqueProviderId('anthropic', ['anthropic', 'anthropic-2'])).toBe('anthropic-3');
  });

  it('asks only for the fields the auth type needs', () => {
    expect(connectFields(getCatalogEntry('anthropic'))).toEqual({
      apiKey: true,
      baseUrl: null,
      deviceAuth: false,
      testable: true,
    });
    expect(connectFields(getCatalogEntry('openai-compat')).baseUrl).toBe('required');
    expect(connectFields(getCatalogEntry('ollama'))).toMatchObject({
      apiKey: false,
      testable: true,
    });
    expect(connectFields(getCatalogEntry('codex'))).toMatchObject({
      apiKey: false,
      deviceAuth: true,
      testable: false,
    });
  });

  it('adds azure and bedrock for Settings only, leaving the onboarding catalog as it was', () => {
    expect(SETTINGS_PROVIDER_TYPES.map((p) => p.id)).toEqual([
      ...PROVIDER_CATALOG.map((p) => p.id),
      'azure',
      'bedrock',
    ]);
    expect(PROVIDER_CATALOG.map((p) => p.id)).not.toContain('azure');
    expect(PROVIDER_CATALOG.map((p) => p.id)).not.toContain('bedrock');
  });

  it('asks azure for key and base URL and bedrock for neither; neither is testable', () => {
    expect(connectFields(settingsProviderType('azure'))).toEqual({
      apiKey: true,
      baseUrl: 'required',
      deviceAuth: false,
      testable: false,
    });
    expect(connectFields(settingsProviderType('bedrock'))).toEqual({
      apiKey: false,
      baseUrl: null,
      deviceAuth: false,
      testable: false,
    });
    const bedrock = settingsProviderType('bedrock');
    expect(
      addProviderRequest({
        entry: bedrock,
        fields: connectFields(bedrock),
        draft: {
          catalogId: 'bedrock',
          id: 'bedrock-us',
          apiKey: 'typed-anyway',
          baseUrl: 'https://ignored',
          extras: { region: 'us-west-2', awsProfile: 'sso-dev', apiVersion: 'v1' },
        },
        models: [],
        aliases: {},
      }),
    ).toEqual({
      provider: 'bedrock',
      id: 'bedrock-us',
      region: 'us-west-2',
      awsProfile: 'sso-dev',
      models: [],
    });
  });

  it('blocks Continue until the id is new and the required fields are filled', () => {
    const fields = connectFields(getCatalogEntry('anthropic'));
    const draft = { catalogId: 'anthropic' as const, id: 'anthropic', apiKey: '', baseUrl: '' };
    expect(connectBlocker(draft, fields, [])).toBe('Paste the API key.');
    expect(connectBlocker({ ...draft, apiKey: 'sk' }, fields, ['anthropic'])).toBe(
      'A provider named anthropic already exists.',
    );
    expect(connectBlocker({ ...draft, apiKey: 'sk' }, fields, [])).toBeNull();
  });

  it('lists the catalog models for the chosen type', () => {
    expect(catalogPicks(CATALOG, getCatalogEntry('anthropic')).map((p) => p.modelId)).toEqual([
      'claude-sonnet-5',
      'claude-haiku-4-5',
    ]);
    expect(catalogPicks(CATALOG, getCatalogEntry('xai'))).toEqual([]);
  });

  it('reads several typed model ids at once, skipping ones already listed', () => {
    expect(parseModelIds('a, b  a\nc', ['c'])).toEqual(['a', 'b']);
  });

  it('offers apiVersion only to azure, and region and awsProfile only to bedrock', () => {
    const fields = (type: string) => providerExtraFields(type).map((f) => f.field);
    expect(fields('azure')).toEqual(['apiVersion']);
    expect(fields('bedrock')).toEqual(['region', 'awsProfile']);
    expect(fields('anthropic')).toEqual([]);
    expect(fields('constructor')).toEqual([]);
  });

  it('sends only the non-blank extra fields the type takes', () => {
    expect(
      extraFieldValues('bedrock', { region: ' us-west-2 ', awsProfile: '  ', apiVersion: 'v1' }),
    ).toEqual({ region: 'us-west-2' });
    expect(extraFieldValues('anthropic', { region: 'us-west-2' })).toEqual({});
    expect(extraFieldValues('azure', undefined)).toEqual({});
  });

  it('confirms an added provider, naming its models when there are any', () => {
    expect(
      addedProviderMessage({
        providerKey: 'anthropic-team',
        models: [{ alias: 'claude-haiku-4-5' }, { alias: 'claude-opus-5' }],
      }),
    ).toBe('Added provider anthropic-team with 2 models: claude-haiku-4-5, claude-opus-5.');
    expect(addedProviderMessage({ providerKey: 'openai-x', models: [{ alias: 'gpt' }] })).toBe(
      'Added provider openai-x with 1 model: gpt.',
    );
    expect(addedProviderMessage({ providerKey: 'anthropic-personal', models: [] })).toBe(
      'Added provider anthropic-personal. Add models to it below.',
    );
  });
});
