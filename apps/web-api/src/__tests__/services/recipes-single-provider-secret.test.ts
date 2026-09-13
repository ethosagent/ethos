import type { CronScheduler } from '@ethosagent/cron';
import { FilePersonalityRegistry } from '@ethosagent/personalities';
import { SkillsLibrary } from '@ethosagent/skills';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import type { Tool, ToolRegistry } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { ConfigRepository } from '../../repositories/config.repository';
import { CronService } from '../../services/cron.service';
import { PersonalitiesService } from '../../services/personalities.service';
import { RecipesService, type RecipesServiceOptions } from '../../services/recipes.service';
import { ToolSettingsService } from '../../services/tool-settings.service';

// P-T5 (plan/phases/trust-before-reach.md) — credential setup for a tool that
// binds ONE provider's secret. `secretSchemaFor` used to require an `enum`
// provider field, so every such tool fell to SECRET_STATUS_UNKNOWN with no
// inline setup. The provider now comes from the tool's own
// `capabilities.secrets` prefix.
//
// Every tool here is invented. The recipe catalog is first-party and static, so
// a test bundle naming them is appended to `RECIPES` through the module mock.

vi.mock('@ethosagent/recipes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ethosagent/recipes')>();
  const tools = ['fake_answer_engine', 'fake_serp', 'fake_multi_search', 'fake_offline'];
  const secret = (toolName: string) => ({ toolName, label: `${toolName} key`, why: 'Test.' });
  return {
    ...actual,
    RECIPES: [
      ...actual.RECIPES,
      {
        id: 'fake-credentials',
        version: 1,
        title: 'Fake credentials',
        summary: 'A bundle whose tools each need a different kind of credential.',
        tags: [],
        personality: {
          mode: 'create',
          id: 'credential-tester',
          name: 'Credential tester',
          description: 'Exercises credential preflight.',
          soulMd: 'I test credentials.',
          toolset: tools,
        },
        requires: {
          mcpServers: [],
          plugins: [],
          channels: [],
          tools,
          secrets: tools.map(secret),
          inputs: [],
        },
        cronJobs: [],
        starterPrompt: 'Hello.',
        examplePrompts: [],
        notes: [],
        postInstall: [],
      },
    ],
  };
});

const DATA = '/data';
const RECIPE = 'fake-credentials';

/** Single provider, no `settingsKey`, the conventional `apiKey` fallback. */
const fakeAnswerEngine = {
  name: 'fake_answer_engine',
  description: 'fake',
  toolset: 'test',
  capabilities: { secrets: ['providers/fake-answer/*'] },
  settingsSchema: {
    fields: [
      {
        kind: 'secret-binding',
        key: 'secret',
        label: 'Fake answer key',
        secretKind: 'fake-answer',
        providerLabel: 'Fake Answer Engine',
        getKeyUrl: 'https://example.invalid/fake-answer',
      },
    ],
  },
} as Tool;

/** Single provider, a shared `settingsKey` and a non-default fallback name. */
const fakeSerp = {
  name: 'fake_serp',
  description: 'fake',
  toolset: 'test',
  settingsKey: 'fake-serp-settings',
  capabilities: { secrets: ['providers/fake-serp/*'] },
  settingsSchema: {
    fields: [
      {
        kind: 'secret-binding',
        key: 'secret',
        label: 'Fake SERP login',
        secretKind: 'fake-serp',
        providerLabel: 'Fake SERP',
        defaultSecretName: 'login',
      },
    ],
  },
} as Tool;

/** Multi-provider, `web_search`'s shape: an enum picks the namespace. */
const fakeMultiSearch = {
  name: 'fake_multi_search',
  description: 'fake',
  toolset: 'test',
  capabilities: { secrets: ['providers/alpha/*', 'providers/beta/*'] },
  settingsSchema: {
    fields: [
      {
        kind: 'enum',
        key: 'provider',
        label: 'Provider',
        options: [
          { value: 'alpha', label: 'Alpha' },
          { value: 'beta', label: 'Beta' },
        ],
      },
      { kind: 'secret-binding', key: 'secret', label: 'API key', secretKind: 'fake-search' },
    ],
  },
} as Tool;

/** Declares no secret at all. */
const fakeOffline = { name: 'fake_offline', description: 'fake', toolset: 'test' } as Tool;

const TOOLS = [fakeAnswerEngine, fakeSerp, fakeMultiSearch, fakeOffline];

/**
 * `keys.list`, reduced to what the credential check reads. The catalog claims
 * only `providers/alpha/apiKey` — a catalog row for `beta` is deliberately
 * absent, and neither fake single-provider namespace has one, which is the
 * position every plugin's namespace is in. `stored` refs surface under `custom`.
 */
function keyStore(stored: string[]): RecipesServiceOptions['keys'] {
  const custom = stored.map((ref) => ({
    id: `custom:${ref}`,
    category: 'custom' as const,
    label: ref,
    shape: 'single' as const,
    fields: [{ key: 'value', label: ref, ref, preview: '…key', set: true }],
    set: true,
    canSet: true,
    canClear: true,
  }));
  const alphaSet = stored.includes('providers/alpha/apiKey');
  return {
    list: async () => ({
      categories: [
        {
          id: 'tools' as const,
          entries: [
            {
              id: 'tools.alpha',
              category: 'tools' as const,
              label: 'Alpha',
              shape: 'single' as const,
              fields: [
                {
                  key: 'apiKey',
                  label: 'Alpha',
                  ref: 'providers/alpha/apiKey',
                  preview: alphaSet ? '…key' : '<unset>',
                  set: alphaSet,
                },
              ],
              set: alphaSet,
              canSet: true,
              canClear: true,
              getKeyUrl: 'https://example.invalid/alpha',
            },
          ],
        },
        ...(custom.length > 0
          ? [
              {
                id: 'custom' as const,
                entries: custom.filter((c) => c.label !== 'providers/alpha/apiKey'),
              },
            ]
          : []),
      ],
    }),
  };
}

function makeWorld(stored: string[] = []) {
  const storage = new InMemoryStorage();
  const registry = new FilePersonalityRegistry(storage, DATA);
  const personalitiesService = new PersonalitiesService({
    personalities: registry,
    library: new SkillsLibrary({ dataDir: DATA, storage }),
  });
  const scheduler = {
    createJob: async () => {
      throw new Error('this bundle schedules nothing');
    },
    listJobs: async () => [],
    deleteJob: async () => {},
  } as unknown as CronScheduler;
  const cron = new CronService({
    scheduler,
    deliveryWorld: {
      listBots: async () => [],
      teamMembers: async () => [],
      channelFilter: async () => ({ enabled: true, ownerUserId: 'owner', allowlist: [] }),
      approvedSenders: async () => [],
      observedChatIds: async () => [],
    },
  });
  const mcp: RecipesServiceOptions['mcp'] = {
    list: async () => ({ servers: [] }),
    catalog: () => ({ remote: [], local: [] }),
    addServer: async () => ({ ok: true as const, serverName: 'unused' }),
    attachPersonalities: async () => ({ updated: [], failed: [] }),
    delete: async () => ({ ok: true as const }),
  };
  const toolRegistry = { getAvailable: () => TOOLS };
  // The real service WITH the registry, so `assertClaimedKeys` is live: a
  // binding written under the tool name instead of its `settingsKey` is refused.
  const toolSettings = new ToolSettingsService({
    config: new ConfigRepository({
      dataDir: DATA,
      storage,
      secrets: new InMemorySecretsResolver(),
    }),
    personalities: personalitiesService,
    secrets: new InMemorySecretsResolver(),
    toolRegistry: toolRegistry as unknown as ToolRegistry,
  });
  const recipes = new RecipesService({
    personalities: {
      list: personalitiesService.list.bind(personalitiesService),
      exists: personalitiesService.exists.bind(personalitiesService),
      get: personalitiesService.get.bind(personalitiesService),
      config: personalitiesService.config.bind(personalitiesService),
      create: personalitiesService.create.bind(personalitiesService),
      update: personalitiesService.update.bind(personalitiesService),
      delete: personalitiesService.delete.bind(personalitiesService),
    },
    cron,
    mcp,
    toolRegistry,
    keys: keyStore(stored),
    toolSettings,
    storage,
    dataDir: DATA,
  });
  return { recipes, registry };
}

async function credentialRow(recipes: RecipesService, toolName: string) {
  const report = await recipes.preflight({ id: RECIPE });
  return {
    report,
    row: report.needsInput.find((r) => r.kind === 'credential' && r.key === `secret:${toolName}`),
    unknown: report.warnings.some(
      (w) => w.code === 'SECRET_STATUS_UNKNOWN' && w.message.includes(`'${toolName}'`),
    ),
  };
}

describe('recipes — single-provider credentials (P-T5)', () => {
  it('gives a single-provider tool a needsInput credential row instead of SECRET_STATUS_UNKNOWN', async () => {
    const { recipes } = makeWorld();
    const { row, unknown } = await credentialRow(recipes, 'fake_answer_engine');
    expect(unknown).toBe(false);
    expect(row?.label).toBe('fake_answer_engine key');
    expect(row?.secretKind).toBe('fake-answer');
    // Provider from `providers/fake-answer/*`; label and key URL from the
    // binding field via the derived roster; no catalog row was needed.
    expect(row?.credentialOptions).toEqual([
      {
        provider: 'fake-answer',
        label: 'Fake Answer Engine',
        defaultSecretName: 'apiKey',
        getKeyUrl: 'https://example.invalid/fake-answer',
      },
    ]);

    // The tool's fallback key present ⇒ the row clears.
    const set = makeWorld(['providers/fake-answer/apiKey']);
    expect((await credentialRow(set.recipes, 'fake_answer_engine')).row).toBeUndefined();
  });

  it('resolves a second single-provider tool to its own provider and fallback name', async () => {
    // A key stored under the OTHER tool's namespace must not satisfy this one,
    // and a key under this namespace with a non-default name is offered, not
    // mistaken for the tool's `login` fallback.
    const { recipes } = makeWorld(['providers/fake-answer/apiKey', 'providers/fake-serp/work']);
    const { row, unknown } = await credentialRow(recipes, 'fake_serp');
    expect(unknown).toBe(false);
    expect(row?.secretKind).toBe('fake-serp');
    expect(row?.credentialOptions).toEqual([
      { provider: 'fake-serp', label: 'Fake SERP', defaultSecretName: 'login' },
    ]);

    const picked = await recipes.preflight({
      id: RECIPE,
      secretBindings: { fake_serp: { provider: 'fake-serp', secret: 'work' } },
    });
    expect(picked.needsInput.find((r) => r.key === 'secret:fake_serp')).toBeUndefined();
  });

  it('writes a single-provider binding under settingsKey, with no provider field', async () => {
    const { recipes, registry } = makeWorld([
      'providers/fake-answer/apiKey',
      'providers/fake-serp/work',
      'providers/alpha/apiKey',
    ]);
    const report = await recipes.install({
      id: RECIPE,
      version: 1,
      inputs: {},
      secretBindings: { fake_serp: { provider: 'fake-serp', secret: 'work' } },
    });
    expect(report.ok).toBe(true);
    expect(registry.getToolsConfig('credential-tester')).toEqual({
      'fake-serp-settings': { secret: 'work' },
    });
  });

  it('keeps the multi-provider enum behaviour unchanged', async () => {
    const { recipes } = makeWorld();
    const { row, unknown } = await credentialRow(recipes, 'fake_multi_search');
    expect(unknown).toBe(false);
    expect(row?.secretKind).toBe('fake-search');
    // As before: the fallback name and key URL come from the catalog row, and a
    // provider with no row at all (`beta`) is not offered.
    expect(row?.credentialOptions).toEqual([
      {
        provider: 'alpha',
        label: 'Alpha',
        defaultSecretName: 'apiKey',
        getKeyUrl: 'https://example.invalid/alpha',
      },
    ]);

    const set = makeWorld(['providers/alpha/apiKey']);
    expect((await credentialRow(set.recipes, 'fake_multi_search')).row).toBeUndefined();
  });

  it('produces no credential row for a tool that declares no secret', async () => {
    const { recipes } = makeWorld();
    const { report, row, unknown } = await credentialRow(recipes, 'fake_offline');
    expect(row).toBeUndefined();
    expect(report.needsInput.some((r) => r.key === 'secret:fake_offline')).toBe(false);
    // Nothing to set up, so it stays a could-not-check warning rather than a
    // row nothing on the page could clear.
    expect(unknown).toBe(true);
  });
});
