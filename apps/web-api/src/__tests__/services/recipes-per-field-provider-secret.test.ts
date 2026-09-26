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
  const toolRegistry = { getAvailable: () => [fakeEngineAsk] };
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
