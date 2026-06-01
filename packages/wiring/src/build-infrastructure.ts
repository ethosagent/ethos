import { join } from 'node:path';
import {
  type CapabilityBackends,
  ClarifyBridge,
  DefaultHookRegistry,
  DefaultLLMProviderRegistry,
  DefaultMemoryProviderRegistry,
  DefaultToolRegistry,
  DefaultToolResultReducerRegistry,
  FileClarifyStore,
} from '@ethosagent/core';
import { AnthropicProvider } from '@ethosagent/llm-anthropic';
import { AzureOpenAIProvider } from '@ethosagent/llm-azure';
import { CodexProvider, ensureValidToken } from '@ethosagent/llm-codex';
import { OpenAICompatProvider } from '@ethosagent/llm-openai-compat';
import { compose as composeMemory } from '@ethosagent/memory-markdown/compose';
import { VectorMemoryProvider } from '@ethosagent/memory-vector';
import type { PersonalityCompose } from '@ethosagent/personalities/compose';
import { compose as composePersonalities } from '@ethosagent/personalities/compose';
import { DockerSandbox } from '@ethosagent/sandbox-docker';
import { compose as composeSession } from '@ethosagent/session-sqlite/compose';
import { FsAttachmentCache, FsStorage, REF_TO_ENV } from '@ethosagent/storage-fs';
import { readFileReducer } from '@ethosagent/tools-code/reducers/read-file';
import { kanbanListReducer } from '@ethosagent/tools-kanban/reducers/kanban-list';
import { bashReducer } from '@ethosagent/tools-terminal/reducers/bash';
import type {
  HookRegistry,
  LLMProviderFactoryContext,
  LLMProviderRegistry,
  MemoryProviderRegistry,
  PersonalityConfig,
} from '@ethosagent/types';
import type { CreateAgentLoopOptions, WiringConfig } from './index';
import type { WiringContext } from './types';

// Default Azure REST API version. Picked to match the model lineup in model-catalog.ts.
// Older stable api-versions (2024-10-21 and earlier) don't know about the `file` content
// part required for PDF input through Chat Completions. Users override per-deployment via
// `apiVersion` in ~/.ethos/config.yaml.
const AZURE_DEFAULT_API_VERSION = '2024-12-01-preview';

export interface InfrastructureResult {
  llmProviders: LLMProviderRegistry;
  memoryProviders: MemoryProviderRegistry;
  personalities: PersonalityCompose['personalities'];
  activePerson: PersonalityConfig;
  sandbox: DockerSandbox;
  hooks: HookRegistry;
  sessionCompose: ReturnType<typeof composeSession>;
  capabilityBackends: CapabilityBackends;
  tools: DefaultToolRegistry;
  clarifyBridge: ClarifyBridge;
}

/**
 * Build the core infrastructure for createAgentLoop:
 *  - LLM + memory provider registries (built-ins registered)
 *  - Personalities loaded + active personality resolved
 *  - DockerSandbox initialized
 *  - HookRegistry created
 *  - Session compose (session store + kvStore factory)
 *  - CapabilityBackends constructed
 *  - ToolRegistry (DefaultToolRegistry) with reducers registered
 *  - ClarifyBridge
 */
export async function buildInfrastructure(
  wiringCtx: WiringContext,
  config: WiringConfig,
  opts: CreateAgentLoopOptions,
): Promise<InfrastructureResult> {
  const { dataDir, log } = wiringCtx;

  // -------------------------------------------------------------------------
  // Provider registries — created first so plugins can register into them.
  // -------------------------------------------------------------------------

  // LLM provider registry — built-ins registered here; plugins add more via
  // registerLLMProvider. Built-in factories resolve the API key through
  // SecretsResolver first (ref: `providers/<name>/apiKey`), falling back to
  // the raw config value for backward compatibility.
  const llmProviders = new DefaultLLMProviderRegistry();
  llmProviders.register('anthropic', async ({ config: cfg, secrets }) => {
    const apiKey = (await secrets.get('providers/anthropic/apiKey')) ?? (cfg.apiKey as string);
    return new AnthropicProvider({ apiKey, model: cfg.model as string });
  });
  llmProviders.register('azure', async ({ config: cfg, secrets }) => {
    if (!cfg.baseUrl) {
      throw new Error(
        'Azure provider requires `baseUrl` set to the resource endpoint ' +
          '(e.g. https://my-resource.openai.azure.com).',
      );
    }
    const apiKey = (await secrets.get('providers/azure/apiKey')) ?? (cfg.apiKey as string);
    return new AzureOpenAIProvider({
      name: 'azure',
      model: cfg.model as string,
      apiKey,
      endpoint: cfg.baseUrl as string,
      apiVersion: (cfg.apiVersion as string) ?? AZURE_DEFAULT_API_VERSION,
    });
  });
  llmProviders.register('codex', async ({ config: cfg }) => {
    return new CodexProvider({
      model: cfg.model as string,
      getAccessToken: async () => {
        const creds = await ensureValidToken(globalThis.fetch);
        return creds.accessToken;
      },
    });
  });
  const openaiCompatFactory = async ({ config: cfg, secrets }: LLMProviderFactoryContext) => {
    const providerName = (cfg.provider as string) ?? 'openai-compat';
    const apiKey =
      (await secrets.get(`providers/${providerName}/apiKey`)) ?? (cfg.apiKey as string);
    return new OpenAICompatProvider({
      name: providerName,
      model: cfg.model as string,
      apiKey,
      baseUrl: (cfg.baseUrl as string) ?? 'https://openrouter.ai/api/v1',
    });
  };
  llmProviders.register('openai-compat', openaiCompatFactory);
  for (const id of ['openai', 'openrouter', 'gemini', 'groq', 'deepseek', 'ollama']) {
    llmProviders.register(id, openaiCompatFactory);
  }

  // Memory provider registry — built-ins registered here; plugins add more via
  // registerMemoryProvider.
  const memoryProviders = new DefaultMemoryProviderRegistry();
  memoryProviders.register('markdown', ({ dataDir: dir }) => {
    const { memoryProvider } = composeMemory({ ...wiringCtx, dataDir: dir });
    return memoryProvider;
  });
  memoryProviders.register('vector', ({ dataDir: dir }) => {
    return new VectorMemoryProvider({ dir });
  });

  // -------------------------------------------------------------------------
  // Personalities
  // -------------------------------------------------------------------------

  const { personalities, activePerson } = await composePersonalities(wiringCtx, {
    personality: config.personality,
  });

  // -------------------------------------------------------------------------
  // Sandbox — shared by browser and code tools
  // -------------------------------------------------------------------------

  // init() is non-blocking when Docker is absent; tool sets gate themselves on isAvailable().
  const sandbox = new DockerSandbox();
  if (!opts.disableDocker) {
    await sandbox.init();
    if (!sandbox.isAvailable()) log.warn('Docker not available — run_code tool disabled');
  }

  // -------------------------------------------------------------------------
  // Hook registry — created early so kanban tools can be wired with it
  // -------------------------------------------------------------------------

  const hooks = new DefaultHookRegistry();

  // -------------------------------------------------------------------------
  // Session compose — session store + kvStore share the same DB path
  // -------------------------------------------------------------------------

  const sessionCompose = composeSession(wiringCtx);

  // -------------------------------------------------------------------------
  // Capability backends
  // -------------------------------------------------------------------------

  const resolver = config.secretsResolver;
  const capabilityBackends: CapabilityBackends = {
    kvStoreFactory: sessionCompose.kvStoreFactory,
    secretsBackend: async (ref: string) => {
      if (resolver) {
        const val = await resolver.get(ref);
        if (val !== null) return val;
      }
      // Self-contained env fallback so callers without MergedSecretsResolver still get env support
      const envKey = REF_TO_ENV.get(ref);
      if (envKey) {
        const envVal = process.env[envKey];
        if (envVal) return envVal;
      }
      throw new Error(`Secret ${ref} not found`);
    },
    storage: new FsStorage(),
    personalityFsReach: {
      read: activePerson.fs_reach?.read ?? [],
      write: activePerson.fs_reach?.write ?? [],
    },
    personalityNetworkPolicy: activePerson.safety?.network ?? {},
    attachmentCache: new FsAttachmentCache(new FsStorage(), join(dataDir, 'cache', 'attachments')),
  };

  // -------------------------------------------------------------------------
  // Tool registry with reducers
  // -------------------------------------------------------------------------

  const reducerRegistry = new DefaultToolResultReducerRegistry();
  reducerRegistry.register(bashReducer);
  reducerRegistry.register(readFileReducer);
  reducerRegistry.register(kanbanListReducer);
  const tools = new DefaultToolRegistry(capabilityBackends, reducerRegistry);

  // -------------------------------------------------------------------------
  // Clarify bridge
  // -------------------------------------------------------------------------

  const clarifyBridge = new ClarifyBridge(
    new FileClarifyStore(new FsStorage(), join(dataDir, 'clarify')),
  );

  return {
    llmProviders,
    memoryProviders,
    personalities,
    activePerson,
    sandbox,
    hooks,
    sessionCompose,
    capabilityBackends,
    tools,
    clarifyBridge,
  };
}
