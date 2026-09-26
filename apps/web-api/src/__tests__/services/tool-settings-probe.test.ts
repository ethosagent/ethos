import { DefaultToolRegistry, resolveToolSecretRef } from '@ethosagent/core';
import { FilePersonalityRegistry } from '@ethosagent/personalities';
import { SkillsLibrary } from '@ethosagent/skills';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import type { Tool } from '@ethosagent/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigRepository } from '../../repositories/config.repository';
import { PersonalitiesService } from '../../services/personalities.service';
import { ToolSettingsService } from '../../services/tool-settings.service';

const DATA = '/data';

/** Distinctive vault payload — must never appear in the probe JSON. */
const SENTINEL = 'sk-PROBE-LEAK-SENTINEL-9f3a2b7c1d';

function secretBindingTool(
  name: string,
  opts: {
    settingsKey?: string;
    secrets: string[];
    defaultSecretName?: string;
    secretKind?: string;
  },
): Tool {
  return {
    name,
    description: 'stub',
    schema: {},
    capabilities: { secrets: opts.secrets },
    ...(opts.settingsKey ? { settingsKey: opts.settingsKey } : {}),
    settingsSchema: {
      fields: [
        {
          kind: 'secret-binding',
          key: 'secret',
          label: 'Key',
          secretKind: opts.secretKind ?? 'test',
          ...(opts.defaultSecretName ? { defaultSecretName: opts.defaultSecretName } : {}),
        },
      ],
    },
    async execute() {
      return { ok: true, value: '' };
    },
  };
}

const webSearchStub: Tool = {
  name: 'web_search',
  description: 'stub',
  schema: {},
  capabilities: {
    secrets: ['providers/exa/*', 'providers/tavily/*', 'providers/brave/*'],
  },
  settingsSchema: {
    fields: [
      {
        kind: 'enum',
        key: 'provider',
        label: 'Provider',
        options: [{ value: 'exa' }, { value: 'tavily' }, { value: 'brave' }],
      },
      { kind: 'secret-binding', key: 'secret', label: 'API key', secretKind: 'web-search' },
    ],
  },
  async execute() {
    return { ok: true, value: '' };
  },
};

const xSearchStub = secretBindingTool('x_search', {
  secrets: ['providers/xai/*'],
  secretKind: 'xai-api-key',
});

const searchConsoleStub = secretBindingTool('gsc_sites', {
  settingsKey: 'search_console',
  secrets: ['providers/google-search-console/*'],
  defaultSecretName: 'serviceAccount',
  secretKind: 'gsc-service-account',
});

const infoOnlyStub: Tool = {
  name: 'quora_search',
  description: 'stub',
  schema: {},
  capabilities: {},
  settingsSchema: {
    fields: [
      {
        kind: 'info',
        label: 'Uses web search',
        text: 'This tool reads the web_search binding.',
      },
    ],
  },
  async execute() {
    return { ok: true, value: '' };
  },
};

describe('ToolSettingsService.probeCredentials', () => {
  let storage: InMemoryStorage;
  let config: ConfigRepository;
  let personalities: PersonalitiesService;
  let secrets: InMemorySecretsResolver;
  let service: ToolSettingsService;

  beforeEach(async () => {
    storage = new InMemoryStorage();
    secrets = new InMemorySecretsResolver();
    await storage.mkdir(DATA);
    await storage.mkdir('/data/personalities/mine');
    await storage.write('/data/personalities/mine/config.yaml', 'name: Mine\n');
    await storage.write('/data/personalities/mine/SOUL.md', '# Mine\n');
    await storage.write(
      '/data/personalities/mine/toolset.yaml',
      ['- web_search', '- x_search', '- gsc_sites', '- quora_search'].join('\n'),
    );
    await storage.mkdir('/builtins/scout');
    await storage.write('/builtins/scout/config.yaml', 'name: Scout\n');
    await storage.write('/builtins/scout/SOUL.md', '# Scout\n');
    await storage.write('/builtins/scout/toolset.yaml', ['- web_search', '- x_search'].join('\n'));

    const registry = new FilePersonalityRegistry(storage, DATA);
    await registry.loadFromDirectory('/builtins');
    await registry.loadFromDirectory('/data/personalities');

    const library = new SkillsLibrary({ dataDir: DATA, storage });
    personalities = new PersonalitiesService({ personalities: registry, library });
    config = new ConfigRepository({ dataDir: DATA, storage, secrets });

    const toolRegistry = new DefaultToolRegistry();
    toolRegistry.register(webSearchStub);
    toolRegistry.register(xSearchStub);
    toolRegistry.register(searchConsoleStub);
    toolRegistry.register(infoOnlyStub);
    service = new ToolSettingsService({ config, personalities, secrets, toolRegistry });
  });

  it('ref equals resolveToolSecretRef across four rungs, including defaultSecretName', async () => {
    // personality (tools.yaml)
    await service.setForPersonality('mine', { x_search: { secret: 'xai-here' } });
    // global-default
    await service.setDefault({ search_console: { secret: 'gsc-global' } });
    // Leave web_search unbound → tool-default (providers/exa/apiKey).
    // Leave gsc at _default only; x_search at personality.

    await secrets.set('providers/xai/xai-here', SENTINEL);
    await secrets.set('providers/google-search-console/gsc-global', `${SENTINEL}-gsc`);

    const { credentials } = await service.probeCredentials('mine');
    const byKey = Object.fromEntries(credentials.map((c) => [c.key, c]));

    const xRungs = [{ secret: 'xai-here' }, undefined, undefined];
    expect(byKey.x_search?.ref).toBe(
      resolveToolSecretRef({
        rungs: xRungs,
        prefix: 'providers/xai/',
        defaultRef: 'providers/xai/apiKey',
      }),
    );
    expect(byKey.x_search).toMatchObject({
      rung: 'personality',
      present: true,
      origin: 'set-here',
      toolNames: ['x_search'],
    });

    const gscRungs = [undefined, undefined, { secret: 'gsc-global' }];
    expect(byKey.search_console?.ref).toBe(
      resolveToolSecretRef({
        rungs: gscRungs,
        prefix: 'providers/google-search-console/',
        defaultRef: 'providers/google-search-console/serviceAccount',
      }),
    );
    expect(byKey.search_console).toMatchObject({
      rung: 'global-default',
      present: true,
      origin: 'inherited',
      toolNames: ['gsc_sites'],
    });

    expect(byKey.web_search?.ref).toBe('providers/exa/apiKey');
    expect(byKey.web_search).toMatchObject({
      rung: 'tool-default',
      present: false,
      origin: 'unset',
    });

    // info-only schema is not a credential group
    expect(byKey).not.toHaveProperty('quora_search');
  });

  it('labels rungs correctly and falls through an invalid name', async () => {
    // config.yaml parse does NOT validate secret names (tools.yaml does and
    // drops the binding). Seed an invalid name at the per-pid slot so the
    // probe's resolveToolSecretRef walk must fall through rather than jump
    // to the tool default.
    await storage.write(
      '/data/config.yaml',
      [
        'toolSettings.mine.x_search.secret: ../escape',
        'toolSettings._default.x_search.secret: fallback-ok',
        'toolSettings.scout.x_search.secret: scout-key',
      ].join('\n'),
    );
    await secrets.set('providers/xai/fallback-ok', SENTINEL);
    await secrets.set('providers/xai/scout-key', SENTINEL);

    const custom = await service.probeCredentials('mine');
    const xCustom = custom.credentials.find((c) => c.key === 'x_search');
    expect(xCustom).toMatchObject({
      ref: 'providers/xai/fallback-ok',
      rung: 'global-default',
      origin: 'inherited',
      present: true,
    });
    // Invalid rung must not jump straight to the tool default.
    expect(xCustom?.ref).not.toBe('providers/xai/apiKey');
    expect(
      resolveToolSecretRef({
        rungs: [{ secret: '../escape' }, { secret: 'fallback-ok' }],
        prefix: 'providers/xai/',
        defaultRef: 'providers/xai/apiKey',
      }),
    ).toBe('providers/xai/fallback-ok');

    const builtin = await service.probeCredentials('scout');
    const xBuiltin = builtin.credentials.find((c) => c.key === 'x_search');
    expect(xBuiltin).toMatchObject({
      ref: 'providers/xai/scout-key',
      rung: 'global-personality',
      origin: 'set-here',
    });
  });

  it('serialized response never carries a secret value', async () => {
    await service.setForPersonality('mine', {
      web_search: { provider: 'exa', secret: 'exa-main' },
      x_search: { secret: 'xai-main' },
    });
    await secrets.set('providers/exa/exa-main', SENTINEL);
    await secrets.set('providers/xai/xai-main', `${SENTINEL}-x`);

    const result = await service.probeCredentials('mine');
    const json = JSON.stringify(result);
    expect(json).not.toContain(SENTINEL);
    expect(json).not.toContain('sk-PROBE');
    for (const row of result.credentials) {
      expect(row).not.toHaveProperty('value');
      expect(Object.keys(row).sort()).toEqual(
        ['key', 'origin', 'present', 'ref', 'rung', 'toolNames'].sort(),
      );
    }
  });

  it('present is false when the vault holds an empty string', async () => {
    await service.setForPersonality('mine', { x_search: { secret: 'empty-name' } });
    await secrets.set('providers/xai/empty-name', '');

    const { credentials } = await service.probeCredentials('mine');
    const row = credentials.find((c) => c.key === 'x_search');
    expect(row).toMatchObject({
      ref: 'providers/xai/empty-name',
      rung: 'personality',
      present: false,
      origin: 'unset',
    });
  });

  it('web_search prefix follows the bound provider', async () => {
    await service.setForPersonality('mine', {
      web_search: { provider: 'brave', secret: 'brave-main' },
    });
    await secrets.set('providers/brave/brave-main', SENTINEL);

    const { credentials } = await service.probeCredentials('mine');
    const ws = credentials.find((c) => c.key === 'web_search');
    expect(ws?.ref).toBe('providers/brave/brave-main');
    expect(ws?.rung).toBe('personality');
  });
});

// plan engine-ask-per-engine-bindings D14 — the probe keeps one row per
// settings group, and for `engine_ask` that row is the ChatGPT credential: it
// reads the group's first binding field key (`chatgpt`) with the legacy
// `secret` fallback, under the prefix matching that field's `provider`.
describe('ToolSettingsService.probeCredentials — engine_ask', () => {
  function engineAskStub(grants: string[]): Tool {
    return {
      name: 'engine_ask',
      description: 'stub',
      schema: {},
      capabilities: { secrets: grants },
      settingsSchema: {
        fields: [
          {
            kind: 'secret-binding',
            key: 'chatgpt',
            label: 'OpenAI key (chatgpt answer engine)',
            secretKind: 'answer-engine',
            provider: 'openai',
          },
          {
            kind: 'secret-binding',
            key: 'perplexity',
            label: 'Perplexity key (perplexity answer engine)',
            secretKind: 'answer-engine',
            provider: 'perplexity',
          },
        ],
      },
      async execute() {
        return { ok: true, value: '' };
      },
    };
  }

  async function setup(grants: string[], toolsYaml?: string) {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await storage.mkdir(DATA);
    await storage.mkdir('/data/personalities/mine');
    await storage.write('/data/personalities/mine/config.yaml', 'name: Mine\n');
    await storage.write('/data/personalities/mine/SOUL.md', '# Mine\n');
    await storage.write('/data/personalities/mine/toolset.yaml', '- engine_ask\n');
    if (toolsYaml) await storage.write('/data/personalities/mine/tools.yaml', toolsYaml);
    await storage.mkdir('/builtins/scout');
    await storage.write('/builtins/scout/config.yaml', 'name: Scout\n');
    await storage.write('/builtins/scout/SOUL.md', '# Scout\n');
    await storage.write('/builtins/scout/toolset.yaml', '- engine_ask\n');
    const registry = new FilePersonalityRegistry(storage, DATA);
    await registry.loadFromDirectory('/builtins');
    await registry.loadFromDirectory('/data/personalities');
    const library = new SkillsLibrary({ dataDir: DATA, storage });
    const personalities = new PersonalitiesService({ personalities: registry, library });
    const config = new ConfigRepository({ dataDir: DATA, storage, secrets });
    const toolRegistry = new DefaultToolRegistry();
    toolRegistry.register(engineAskStub(grants));
    return {
      storage,
      secrets,
      service: new ToolSettingsService({ config, personalities, secrets, toolRegistry }),
    };
  }

  const GRANTS = ['providers/openai/*', 'providers/perplexity/*'];

  it('a legacy { secret } binding probes providers/openai/<name> at the personality rung', async () => {
    const { service, secrets } = await setup(GRANTS, 'engine_ask: { secret: openai-key }\n');
    await secrets.set('providers/openai/openai-key', SENTINEL);
    const { credentials } = await service.probeCredentials('mine');
    expect(credentials).toHaveLength(1);
    expect(credentials[0]).toMatchObject({
      key: 'engine_ask',
      ref: 'providers/openai/openai-key',
      rung: 'personality',
      present: true,
    });
  });

  it('a { chatgpt } binding probes providers/openai/<name>, and wins over secret in its rung', async () => {
    const { service } = await setup(
      GRANTS,
      'engine_ask: { chatgpt: openai-brand, perplexity: pplx-brand, secret: legacy }\n',
    );
    const { credentials } = await service.probeCredentials('mine');
    expect(credentials[0]).toMatchObject({
      ref: 'providers/openai/openai-brand',
      rung: 'personality',
    });
  });

  it('reads the legacy and per-engine forms at the global rungs too', async () => {
    const { service } = await setup(GRANTS);
    await service.setForPersonality('scout', { engine_ask: { secret: 'openai-scout' } });
    await service.setDefault({ engine_ask: { chatgpt: 'openai-default' } });
    const scout = await service.probeCredentials('scout');
    expect(scout.credentials[0]).toMatchObject({
      ref: 'providers/openai/openai-scout',
      rung: 'global-personality',
    });
    const mine = await service.probeCredentials('mine');
    expect(mine.credentials[0]).toMatchObject({
      ref: 'providers/openai/openai-default',
      rung: 'global-default',
    });
  });

  it("takes the prefix from the field's provider, not from grant order", async () => {
    const forward = await setup(GRANTS);
    const reversed = await setup([...GRANTS].reverse());
    const a = await forward.service.probeCredentials('mine');
    const b = await reversed.service.probeCredentials('mine');
    expect(a.credentials[0]?.ref).toBe('providers/openai/apiKey');
    expect(b.credentials[0]?.ref).toBe('providers/openai/apiKey');
  });
});
