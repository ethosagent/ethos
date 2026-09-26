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

// plan engine-ask-per-engine-bindings D15 — a tool with SEVERAL secret-binding
// fields, each scoped by `provider` to one namespace (`engine_ask`'s shape).
// Without the per-field reading, `secretSchemaFor` returns `undefined` for it
// (`bindings.length !== 1`, several own prefixes) and a recipe silently loses
// the ability to bind its key. No shipped bundle requires an `engine_ask`
// secret, so this is a regression guard over an invented tool and bundle.

vi.mock('@ethosagent/recipes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ethosagent/recipes')>();
  return {
    ...actual,
    RECIPES: [
      ...actual.RECIPES,
      {
        id: 'fake-engines',
        version: 1,
        title: 'Fake engines',
        summary: 'A bundle whose one tool binds a key per engine.',
        tags: [],
        personality: {
          mode: 'create',
          id: 'engine-tester',
          name: 'Engine tester',
          description: 'Exercises per-field credential preflight.',
          soulMd: 'I test engines.',
          toolset: ['fake_engine_ask'],
        },
        requires: {
          mcpServers: [],
          plugins: [],
          channels: [],
          tools: ['fake_engine_ask'],
          secrets: [{ toolName: 'fake_engine_ask', label: 'Engine key', why: 'Test.' }],
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
const RECIPE = 'fake-engines';

const fakeEngineAsk = {
  name: 'fake_engine_ask',
  description: 'fake',
  toolset: 'test',
  capabilities: { secrets: ['providers/fake-openai/*', 'providers/fake-pplx/*'] },
  settingsSchema: {
    fields: [
      {
        kind: 'secret-binding',
        key: 'chatgpt',
        label: 'OpenAI key (chatgpt answer engine)',
        secretKind: 'answer-engine',
        provider: 'fake-openai',
        providerLabel: 'Fake OpenAI',
      },
      {
        kind: 'secret-binding',
        key: 'perplexity',
        label: 'Perplexity key (perplexity answer engine)',
        secretKind: 'answer-engine',
        provider: 'fake-pplx',
        providerLabel: 'Fake Perplexity',
      },
    ],
  },
} as Tool;

// A tool whose settings key IS `engine_ask`, so the legacy `secret` alias rule
// (`LEGACY_FIELD_ALIASES`, apps/web-api/src/services/tool-settings.service.ts)
// applies to its binding — `fake_engine_ask` above sits outside it.
const engineAsk = { ...fakeEngineAsk, name: 'engine_ask' } as Tool;

function keyStore(stored: string[]): RecipesServiceOptions['keys'] {
  const entries = stored.map((ref) => ({
    id: `custom:${ref}`,
    category: 'custom' as const,
    label: ref,
    shape: 'single' as const,
    fields: [{ key: 'value', label: ref, ref, preview: '…key', set: true }],
    set: true,
    canSet: true,
    canClear: true,
  }));
  return {
    list: async () => ({
      categories: entries.length > 0 ? [{ id: 'custom' as const, entries }] : [],
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
  const toolRegistry = { getAvailable: () => [fakeEngineAsk, engineAsk] };
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
  return { recipes, registry, storage, toolSettings };
}

describe('recipes — per-field provider credentials (engine_ask shape)', () => {
  it('offers the FIRST field and its provider instead of reporting SECRET_STATUS_UNKNOWN', async () => {
    const { recipes } = makeWorld();
    const report = await recipes.preflight({ id: RECIPE });
    const unknown = report.warnings.some((w) => w.code === 'SECRET_STATUS_UNKNOWN');
    expect(unknown).toBe(false);
    const row = report.needsInput.find((r) => r.key === 'secret:fake_engine_ask');
    expect(row?.secretKind).toBe('answer-engine');
    expect(row?.credentialOptions).toEqual([
      { provider: 'fake-openai', label: 'Fake OpenAI', defaultSecretName: 'apiKey' },
    ]);
  });

  it('writes the binding under the first engine field — engine_ask.chatgpt, not secret', async () => {
    const { recipes, registry } = makeWorld(['providers/fake-openai/brand']);
    const report = await recipes.install({
      id: RECIPE,
      version: 1,
      inputs: {},
      secretBindings: { fake_engine_ask: { provider: 'fake-openai', secret: 'brand' } },
    });
    expect(report.ok).toBe(true);
    expect(registry.getToolsConfig('engine-tester')).toEqual({
      fake_engine_ask: { chatgpt: 'brand' },
    });
  });
});

// A recipe's credential write is patched field by field, and writing `chatgpt`
// retires the legacy `secret` alias. Its undo must therefore restore the exact
// prior binding of the key it touched — re-sending the prior values alone
// leaves the field the write ADDED in place, and a retired alias gone.
describe('recipes — undo of a credential binding restores the prior binding exactly', () => {
  type BindSecrets = (
    bundle: unknown,
    personalityId: string,
    bindings: Record<string, { provider: string; secret: string }>,
  ) => Promise<Array<{ run: () => Promise<void> }>>;

  const bundle = {
    requires: { secrets: [{ toolName: 'engine_ask', label: 'Key', why: 'Test.' }] },
  };

  async function bindThenUndo(recipes: RecipesService, personalityId: string): Promise<void> {
    // The private stage `install` runs; its undo entries are what a failed
    // install replays. Reached directly so each store can be seeded with a
    // legacy binding the install path's own preflight never produces.
    const bindSecrets = (recipes as unknown as { bindSecrets: BindSecrets }).bindSecrets.bind(
      recipes,
    );
    const undo = await bindSecrets(bundle, personalityId, {
      engine_ask: { provider: 'fake-openai', secret: 'new-key' },
    });
    for (const step of undo.reverse()) await step.run();
  }

  const priors: Array<[string, Record<string, string> | undefined]> = [
    ['a legacy { secret } binding', { secret: 'openai-key' }],
    ['a binding with only another engine', { perplexity: 'pplx-key' }],
    ['a binding that already named chatgpt', { chatgpt: 'old-key', perplexity: 'pplx-key' }],
    ['no binding at all', undefined],
  ];

  it.each(priors)('custom personality (tools.yaml): %s', async (_label, prior) => {
    const { recipes, registry, storage, toolSettings } = makeWorld();
    await storage.mkdir(`${DATA}/personalities/mine`);
    await storage.write(`${DATA}/personalities/mine/config.yaml`, 'name: Mine\n');
    await storage.write(`${DATA}/personalities/mine/SOUL.md`, '# Mine\n');
    if (prior) {
      const fields = Object.entries(prior)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      await storage.write(`${DATA}/personalities/mine/tools.yaml`, `engine_ask: { ${fields} }\n`);
    }
    await registry.loadFromDirectory(`${DATA}/personalities`);

    const before = (await toolSettings.getForPersonality('mine')).values;
    expect(before.engine_ask).toEqual(prior);
    await bindThenUndo(recipes, 'mine');
    expect((await toolSettings.getForPersonality('mine')).values).toEqual(before);
  });

  it.each(priors)('built-in personality (config.yaml toolSettings): %s', async (_label, prior) => {
    const { recipes, registry, storage, toolSettings } = makeWorld();
    await storage.mkdir('/builtins/scout');
    await storage.write('/builtins/scout/config.yaml', 'name: Scout\n');
    await storage.write('/builtins/scout/SOUL.md', '# Scout\n');
    await registry.loadFromDirectory('/builtins');
    await storage.mkdir(DATA);
    await storage.write(
      `${DATA}/config.yaml`,
      [
        'provider: anthropic',
        ...Object.entries(prior ?? {}).map(([k, v]) => `toolSettings.scout.engine_ask.${k}: ${v}`),
        '',
      ].join('\n'),
    );

    const before = (await toolSettings.getForPersonality('scout')).values;
    expect(before.engine_ask).toEqual(prior);
    await bindThenUndo(recipes, 'scout');
    expect((await toolSettings.getForPersonality('scout')).values).toEqual(before);
  });
});
