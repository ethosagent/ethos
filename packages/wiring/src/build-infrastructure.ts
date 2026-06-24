import { join } from 'node:path';
import {
  applySafeMode,
  BUILTIN_PERSONALITY_IDS,
  enforceConstitution,
  loadConstitution,
} from '@ethosagent/constitution';
import {
  type CapabilityBackends,
  ClarifyBridge,
  DefaultExecutionBackendRegistry,
  DefaultHookRegistry,
  DefaultLLMProviderRegistry,
  DefaultMemoryProviderRegistry,
  DefaultStorageRegistry,
  DefaultToolRegistry,
  DefaultToolResultReducerRegistry,
  FileClarifyStore,
} from '@ethosagent/core';
import { DockerExecutionBackend } from '@ethosagent/execution-docker';
import { LocalExecutionBackend } from '@ethosagent/execution-local';
import { SshExecutionBackend } from '@ethosagent/execution-ssh';
import {
  PROVIDER_CONTRACT_MAJOR as ANTHROPIC_CONTRACT,
  activate as activateAnthropic,
} from '@ethosagent/llm-anthropic';
import {
  PROVIDER_CONTRACT_MAJOR as AZURE_CONTRACT,
  activate as activateAzure,
} from '@ethosagent/llm-azure';
import {
  activate as activateCodex,
  PROVIDER_CONTRACT_MAJOR as CODEX_CONTRACT,
} from '@ethosagent/llm-codex';
import {
  activate as activateOpenaiCompat,
  PROVIDER_CONTRACT_MAJOR as OPENAI_COMPAT_CONTRACT,
} from '@ethosagent/llm-openai-compat';
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
  Constitution,
  ConstitutionEnforcement,
  ExecutionBackendRegistry,
  HookRegistry,
  LLMProviderRegistry,
  MemoryProviderRegistry,
  PersonalityConfig,
  StorageRegistry,
} from '@ethosagent/types';
import { activateFirstPartyPlugins } from './activate-first-party';
import type { CreateAgentLoopOptions, WiringConfig } from './index';
import { registerRemainingBuiltinProviders } from './register-builtin-providers';
import type { WiringContext } from './types';

export interface InfrastructureResult {
  llmProviders: LLMProviderRegistry;
  executionBackends: ExecutionBackendRegistry;
  memoryProviders: MemoryProviderRegistry;
  storageBackends: StorageRegistry;
  personalities: PersonalityCompose['personalities'];
  activePerson: PersonalityConfig;
  sandbox: DockerSandbox;
  hooks: HookRegistry;
  sessionCompose: ReturnType<typeof composeSession>;
  capabilityBackends: CapabilityBackends;
  tools: DefaultToolRegistry;
  clarifyBridge: ClarifyBridge;
  constitutionEnforcement?: ConstitutionEnforcement;
  /**
   * The loaded operator constitution. `undefined` only in SAFE MODE (malformed
   * constitution). Threaded to compose-tools so the execution-posture resolver
   * and docker backend enforce `execution.*` and `filesystem.*` at runtime, not
   * just at load time.
   */
  constitution?: Constitution;
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
  await activateFirstPartyPlugins(
    [
      {
        id: '@ethosagent/llm-anthropic',
        activate: activateAnthropic,
        contractMajor: ANTHROPIC_CONTRACT,
      },
      {
        id: '@ethosagent/llm-openai-compat',
        activate: activateOpenaiCompat,
        contractMajor: OPENAI_COMPAT_CONTRACT,
      },
      {
        id: '@ethosagent/llm-azure',
        activate: activateAzure,
        contractMajor: AZURE_CONTRACT,
      },
      {
        id: '@ethosagent/llm-codex',
        activate: activateCodex,
        contractMajor: CODEX_CONTRACT,
      },
    ],
    llmProviders,
    log,
  );
  registerRemainingBuiltinProviders(llmProviders);

  // Execution backend registry — built-ins registered here.
  // backends resolved on demand in Lane B/c
  const executionBackends = new DefaultExecutionBackendRegistry();
  executionBackends.register('local', (ctx) => new LocalExecutionBackend(ctx));
  executionBackends.register('docker', (ctx) => new DockerExecutionBackend(ctx));
  executionBackends.register('ssh', (ctx) => new SshExecutionBackend(ctx));

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

  // Storage backend registry — built-ins registered here; plugins add more
  // via registerStorage.
  const storageBackends = new DefaultStorageRegistry();
  storageBackends.register('fs', () => new FsStorage());

  // -------------------------------------------------------------------------
  // Personalities
  // -------------------------------------------------------------------------

  const { personalities, activePerson } = await composePersonalities(wiringCtx, {
    personality: config.personality,
  });

  // ---------------------------------------------------------------------------
  // Constitution — operator-authoritative ceiling layered over personalities.
  // Malformed constitution → SAFE MODE: only built-ins load, read-only tools.
  // Hard violations throw ConstitutionViolationError and abort the run.
  // ---------------------------------------------------------------------------
  const constLoad = await loadConstitution(wiringCtx.storage, dataDir);
  let constitutionEnforcement: ConstitutionEnforcement | undefined;
  let constitution: Constitution | undefined;
  let effectiveActivePerson = activePerson;
  if (constLoad.status === 'malformed') {
    log.error(
      `Constitution malformed — entering SAFE MODE: ${constLoad.error} (see docs/content/using/how-to/safe-mode.md)`,
    );
    const safe = applySafeMode(personalities.list(), BUILTIN_PERSONALITY_IDS);
    const survivors = new Set(safe.map((p) => p.id));
    for (const p of personalities.list()) {
      if (!survivors.has(p.id)) personalities.remove(p.id);
    }
    effectiveActivePerson = personalities.getDefault();
  } else {
    constitution = constLoad.constitution;
    const result = enforceConstitution({
      constitution: constLoad.constitution,
      personalities: personalities.list(),
      ethosHome: dataDir,
      workingDir: wiringCtx.workingDir,
      log,
    });
    constitutionEnforcement = result.enforcement;
  }

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
  const { safeFetch } = await import('@ethosagent/safety-network');
  const { defaultAlwaysDeny } = await import('@ethosagent/storage-fs');

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
    storage: await storageBackends.resolve(config.storage?.backend ?? 'fs', {
      config: config.storage ?? {},
      secrets: config.secretsResolver ?? {
        get: async () => null,
        set: async () => {},
        delete: async () => {},
        list: async () => [],
      },
      logger: log,
    }),
    personalityFsReach: {
      read: effectiveActivePerson.fs_reach?.read ?? [],
      write: effectiveActivePerson.fs_reach?.write ?? [],
    },
    personalityNetworkPolicy: effectiveActivePerson.safety?.network ?? {},
    safeFetch,
    alwaysDenyPaths: defaultAlwaysDeny(),
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
    executionBackends,
    memoryProviders,
    storageBackends,
    personalities,
    activePerson: effectiveActivePerson,
    sandbox,
    hooks,
    sessionCompose,
    capabilityBackends,
    tools,
    clarifyBridge,
    constitutionEnforcement,
    constitution,
  };
}
