import { join } from 'node:path';
import {
  AgentLoop,
  type CapabilityBackends,
  ChainedProvider,
  ClarifyBridge,
  DefaultHookRegistry,
  DefaultLLMProviderRegistry,
  DefaultMemoryProviderRegistry,
  DefaultToolRegistry,
  EagerPrefetchPolicy,
  FileClarifyStore,
  LastWriteWinsPolicy,
  LazyOnDemandPolicy,
  type SummarizerFn,
} from '@ethosagent/core';
import { autonomyTier, KanbanStore, type TrustPolicy } from '@ethosagent/kanban-store';
import { AnthropicProvider, AuthRotatingProvider } from '@ethosagent/llm-anthropic';
import { AzureOpenAIProvider } from '@ethosagent/llm-azure';
import { OpenAICompatProvider } from '@ethosagent/llm-openai-compat';
import { noopLogger } from '@ethosagent/logger';
import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import { VectorMemoryProvider } from '@ethosagent/memory-vector';
import { createPersonalityRegistry } from '@ethosagent/personalities';
import { PluginLoader } from '@ethosagent/plugin-loader';
import { DockerSandbox } from '@ethosagent/sandbox-docker';
import { createKvStoreFactory, SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { createInjectors, UniversalScanner } from '@ethosagent/skills';
import { bundledCodingSkillsSource } from '@ethosagent/skills-coding';
import { FsAttachmentCache, FsStorage } from '@ethosagent/storage-fs';
import { createBrowserTools } from '@ethosagent/tools-browser';
import { createCodeTools } from '@ethosagent/tools-code';
import { createDelegationTools } from '@ethosagent/tools-delegation';
import { createFileTools } from '@ethosagent/tools-file';
import { createImageTools } from '@ethosagent/tools-image';
import { createInteractiveTools } from '@ethosagent/tools-interactive';
import {
  createKanbanRoleGateHook,
  createKanbanTools,
  registerPostmortemHandler,
  type TeamRole,
} from '@ethosagent/tools-kanban';
import { loadMcpConfig, McpManager } from '@ethosagent/tools-mcp';
import { createMemoryTools, createTeamMemoryTools, isSafeTopicKey } from '@ethosagent/tools-memory';
import {
  createPersonalityDesignTools,
  createTeamDesignTools,
} from '@ethosagent/tools-personality-design';
import { createProcessTools } from '@ethosagent/tools-process';
import { createTerminalGuardHook, createTerminalTools } from '@ethosagent/tools-terminal';
import { createThinkDeeperTool } from '@ethosagent/tools-tier';
import { createTodoTools, InMemoryTodoStore } from '@ethosagent/tools-todo';
import { createVisionTools } from '@ethosagent/tools-vision';
import { createWebTools } from '@ethosagent/tools-web';
import type {
  ContextInjector,
  GlobalMemoryStore,
  InjectionResult,
  LLMProvider,
  LLMProviderFactoryContext,
  Logger,
  MemoryContext,
  MemoryEntryRef,
  MemoryProvider,
  PromptContext,
  RequestDumpStore,
  SecretsResolver,
  SessionStore,
} from '@ethosagent/types';
import { resolveKanbanDbPath } from './kanban-path';
import { MODEL_CATALOG } from './model-catalog';
import type { EthosObservability } from './observability/ethos-observability';
import { applySkillPassthrough, deriveSkillPassthrough } from './skill-passthrough';
import { capSummary, renderMiddleForSummary, SUMMARIZER_SYSTEM_PROMPT } from './summarizer-prompt';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RotationKey {
  apiKey: string;
  priority: number;
  label?: string;
}

export interface WiringProviderConfig {
  provider: string;
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Azure-only: REST API version (e.g. `2024-10-21`). Required when
   *  `provider === 'azure'`; ignored otherwise. */
  apiVersion?: string;
}

export interface WiringConfig {
  provider: string;
  model: string;
  apiKey: string;
  personality?: string;
  memory?: 'markdown' | 'vector';
  baseUrl?: string;
  /** Azure-only: REST API version (e.g. `2024-10-21`). Required when
   *  `provider === 'azure'`; ignored otherwise. */
  apiVersion?: string;
  /** Maps personality ID → model ID for per-personality model overrides. */
  modelRouting?: Record<string, string>;
  /** Anthropic key rotation pool. Empty / absent = single-key provider. */
  rotationKeys?: RotationKey[];
  /**
   * Override path to the kanban SQLite database. When unset, the path resolves
   * based on `teamName`:
   *   - `teamName` set → `${dataDir}/teams/<teamName>/board.db` (shared team board)
   *   - `teamName` unset → `${dataDir}/personalities/<active-personality-id>/kanban.db` (solo)
   * `kanbanDbPath` always wins when explicitly set.
   */
  kanbanDbPath?: string;
  /**
   * Team this AgentLoop belongs to. When set, the kanban store points at the
   * team's shared board (`${dataDir}/teams/<name>/board.db`) and a `before_tool_call`
   * role hook gets registered (Plan B). When unset, the loop runs solo (Plan A).
   */
  teamName?: string;
  /**
   * Caller's role within the team. Drives the kanban role-gate hook:
   *   - `coordinator` can call kanban_create/_create_goal/_assign/_link/_archive
   *   - `member` cannot, and can only complete/block/unblock/heartbeat their own
   *     assigned tasks. Both roles can comment/list/show/update_status.
   * Only honored when `teamName` is also set.
   */
  role?: TeamRole;
  /** Enable postmortem entries in team memory on ticket revision. */
  postmortems?: boolean;
  /** Reputation-aware autonomy tiers for team members. */
  trustPolicy?: TrustPolicy;
  /**
   * P3 observability — request dump store configuration. When enabled, every
   * LLM request/response is logged to JSONL files for offline debugging.
   */
  observabilityRequestDump?: {
    enabled?: boolean;
    dir?: string;
    includeContent?: boolean;
    rotation?: { maxBytes?: number };
  };
  /**
   * Fallback provider chain. When 2+ entries are provided, `createLLM` wraps
   * them in a `ChainedProvider` with cooldown-based automatic failover.
   * Takes precedence over `provider`/`apiKey`/`model` when present.
   */
  providers?: WiringProviderConfig[];
  /**
   * context_compression F1 — auxiliary compression summarizer. When `model`
   * is set, `semantic_summary` is wired with a real LLM summarizer running on
   * this (typically cheap) model instead of the placeholder. `provider` /
   * `apiKey` / `baseUrl` default to the primary provider's values when unset.
   */
  auxiliaryCompression?: {
    model: string;
    provider?: string;
    apiKey?: string;
    baseUrl?: string;
  };
  /**
   * tools-vision P3 — auxiliary vision model wiring. When `model` is set,
   * `vision_analyze` routes to this (typically vision-capable) provider when
   * the active personality's primary model can't handle images / PDFs.
   * `provider` / `apiKey` / `baseUrl` default to the primary provider's
   * values when unset, mirroring `auxiliaryCompression`.
   */
  auxiliaryVision?: {
    model: string;
    provider?: string;
    apiKey?: string;
    baseUrl?: string;
  };
  /** File-backed secrets resolver. When provided, the capability backend
   *  resolves secrets from ~/.ethos/secrets/ before falling back to env vars. */
  secretsResolver?: SecretsResolver;
}

export type WiringProfile = 'cli' | 'tui' | 'web' | 'acp';

export interface CreateAgentLoopOptions {
  /** Root data directory (typically `~/.ethos`). Sessions DB, memory, and
   *  user personalities all resolve under this path. */
  dataDir: string;
  /** Working directory tools see. Defaults to `process.cwd()`. */
  workingDir?: string;
  /** Surface label surfaced to tools/hooks as `AgentLoop.options.platform`.
   *  Pure metadata — no behavioral branches keyed on it. */
  profile?: WiringProfile;
  /** Skip Docker init and the tools that depend on it (run_code, browser).
   *  Useful in containers / CI / web profiles where Docker isn't reachable. */
  disableDocker?: boolean;
  /** Optional log sink for non-fatal warnings (e.g. Docker missing, skill
   *  skipped). Defaults to a no-op so the package stays headless. */
  logger?: Logger;
  /** Absolute path to the mesh registry file this agent belongs to.
   *  Controls which peers route_to_agent and broadcast_to_agents can see.
   *  Defaults to the 'default' mesh (~/.ethos/meshes/default/registry.json).
   *  Set by ethos serve --mesh <name> so team members route within their mesh. */
  meshRegistryPath?: string;
  /**
   * Optional observability adapter. When provided, passed through to
   * AgentLoop so LLM calls, tool calls, and hook blocks are recorded via
   * typed domain helpers. When absent, no observability writes occur.
   *
   * Construct as `new EthosObservability(observabilityService)` at the
   * call site; the adapter owns the ethos vocabulary while the underlying
   * service stays vocabulary-agnostic.
   */
  observability?: import('./observability/ethos-observability').EthosObservability;
}

// ---------------------------------------------------------------------------
// LLM provider construction
// ---------------------------------------------------------------------------

function personalityWantsKanban(p: { toolset?: readonly string[] }): boolean {
  return (p.toolset ?? []).some((name) => name.startsWith('kanban_'));
}

export { resolveKanbanDbPath } from './kanban-path';

// Default Azure REST API version. Picked to match the model lineup in
// `model-catalog.ts` — older stable api-versions (2024-10-21 and earlier)
// don't know about the `file` content part required for PDF input through
// Chat Completions, so requests against gpt-5.4 / Claude-on-Azure with a
// PDF attachment fail with a 500. Preview suffix is intentional: stable
// GA api-versions lag the model-feature surface by ~6 months. Users
// override per-deployment via `apiVersion` in ~/.ethos/config.yaml.
const AZURE_DEFAULT_API_VERSION = '2024-12-01-preview';

function createSingleProvider(cfg: {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  apiVersion?: string;
}): LLMProvider {
  if (cfg.provider === 'anthropic') {
    return new AnthropicProvider({ apiKey: cfg.apiKey, model: cfg.model });
  }
  if (cfg.provider === 'azure') {
    if (!cfg.baseUrl) {
      throw new Error(
        'Azure provider requires `baseUrl` set to the resource endpoint (e.g. https://my-resource.openai.azure.com).',
      );
    }
    return new AzureOpenAIProvider({
      name: cfg.provider,
      model: cfg.model,
      apiKey: cfg.apiKey,
      endpoint: cfg.baseUrl,
      apiVersion: cfg.apiVersion ?? AZURE_DEFAULT_API_VERSION,
    });
  }
  return new OpenAICompatProvider({
    name: cfg.provider,
    model: cfg.model,
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl ?? 'https://openrouter.ai/api/v1',
  });
}

// Hard ceiling on a single summarizer call. The summarizer runs on the turn's
// critical path before the main provider call, so a hung auxiliary provider
// would otherwise hang the whole turn. On timeout the call aborts and throws,
// which `maybeCompact` catches and fails open to the un-compacted history.
// (Q6 will add a tighter timeout + a fallback model; this is the floor.)
const SUMMARIZER_TIMEOUT_MS = 30_000;

// context_compression F1 — build the real LLM summarizer for `semantic_summary`.
// Runs on the auxiliary (typically cheap) model so a compacting turn costs
// ~one Haiku-tier call rather than a full main-model re-prompt. Fails open: a
// throw here is caught by the engine's caller (`maybeCompact`), which ships
// the un-compacted history and records a degradation event.
function buildCompressionSummarizer(
  registry: import('@ethosagent/types').LLMProviderRegistry,
  config: WiringConfig,
  observability: EthosObservability | undefined,
  log: Logger,
): SummarizerFn {
  const aux = config.auxiliaryCompression;
  const providerName = aux?.provider ?? config.provider;
  let cachedProvider: LLMProvider | undefined;

  const getProvider = async (): Promise<LLMProvider> => {
    if (cachedProvider) return cachedProvider;
    const factory = registry.get(providerName);
    if (!factory) {
      throw new Error(
        `LLM provider "${providerName}" is not registered (compression summarizer). ` +
          `Available: ${registry.list().join(', ')}`,
      );
    }
    const NOOP: import('@ethosagent/types').SecretsResolver = {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
    };
    cachedProvider = await factory({
      config: {
        provider: providerName,
        model: aux?.model ?? config.model,
        apiKey: aux?.apiKey ?? config.apiKey,
        ...((aux?.baseUrl ?? config.baseUrl) ? { baseUrl: aux?.baseUrl ?? config.baseUrl } : {}),
        ...(config.apiVersion ? { apiVersion: config.apiVersion } : {}),
      },
      secrets: config.secretsResolver ?? NOOP,
      logger: log,
    });
    return cachedProvider;
  };

  return async (middle, targetTokens) => {
    const provider = await getProvider();
    const startedAt = Date.now();
    let text = '';
    let costUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      const stream = provider.complete(
        [{ role: 'user', content: renderMiddleForSummary(middle) }],
        [],
        {
          system: SUMMARIZER_SYSTEM_PROMPT,
          maxTokens: Math.ceil(targetTokens * 1.5),
          abortSignal: AbortSignal.timeout(SUMMARIZER_TIMEOUT_MS),
        },
      );
      for await (const chunk of stream) {
        if (chunk.type === 'text_delta') {
          text += chunk.text;
        } else if (chunk.type === 'usage') {
          costUsd = chunk.usage.estimatedCostUsd;
          inputTokens = chunk.usage.inputTokens;
          outputTokens = chunk.usage.outputTokens;
        }
      }
    } catch (err) {
      log.warn(
        `compression summarizer failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
    const trimmed = text.trim();
    if (!trimmed) {
      log.warn('compression summarizer returned empty output');
      throw new Error('compression summarizer returned empty output');
    }
    const summary = capSummary(trimmed, targetTokens);
    observability?.recordCompaction({
      code: 'compaction_summarized',
      cause: `${provider.model}: summarized ${middle.length} message(s)`,
      details: {
        model: provider.model,
        inputTokens,
        outputTokens,
        costUsd,
        durationMs: Date.now() - startedAt,
      },
    });
    return summary;
  };
}

export async function createLLM(config: WiringConfig): Promise<LLMProvider> {
  // Multi-provider chain: 2+ entries → ChainedProvider with automatic failover.
  if (config.providers && config.providers.length >= 2) {
    const instances = config.providers.map((p) =>
      createSingleProvider({
        provider: p.provider,
        model: p.model ?? config.model,
        apiKey: p.apiKey,
        ...(p.baseUrl !== undefined ? { baseUrl: p.baseUrl } : {}),
        ...(p.apiVersion !== undefined ? { apiVersion: p.apiVersion } : {}),
      }),
    );
    return new ChainedProvider(instances);
  }

  // Anthropic rotation pool is provider-specific (rotates across API keys for
  // the same model). Handled inline; everything else goes through
  // `createSingleProvider` so Azure / OpenAI-compat / future providers share
  // one construction path.
  if (config.provider === 'anthropic') {
    const rotation = config.rotationKeys ?? [];
    if (rotation.length > 0) {
      return new AuthRotatingProvider(
        [
          { id: 'primary', apiKey: config.apiKey, priority: 100 },
          ...rotation.map((k, i) => ({
            id: k.label ?? `key-${i + 1}`,
            apiKey: k.apiKey,
            priority: k.priority,
          })),
        ],
        config.model,
      );
    }
  }
  return createSingleProvider({
    provider: config.provider,
    model: config.model,
    apiKey: config.apiKey,
    ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    ...(config.apiVersion !== undefined ? { apiVersion: config.apiVersion } : {}),
  });
}

/**
 * Registry-aware LLM creation — used internally by `createAgentLoop` after
 * plugins have loaded. Falls through to the registry for each provider name,
 * so plugin-contributed providers participate in chained failover.
 */
async function createLLMFromRegistry(
  registry: import('@ethosagent/types').LLMProviderRegistry,
  config: WiringConfig,
  log: Logger,
): Promise<LLMProvider> {
  const secrets: import('@ethosagent/types').SecretsResolver = {
    get: async () => null,
    set: async () => {},
    delete: async () => {},
    list: async () => [],
  };

  const resolveOne = async (cfg: {
    provider: string;
    model: string;
    apiKey: string;
    baseUrl?: string;
    apiVersion?: string;
  }): Promise<LLMProvider> => {
    const factory = registry.get(cfg.provider);
    if (!factory) {
      throw new Error(
        `LLM provider "${cfg.provider}" is not registered. ` +
          `Available: ${registry.list().join(', ')}`,
      );
    }
    const provider = await factory({
      config: cfg as unknown as Record<string, unknown>,
      secrets: config.secretsResolver ?? secrets,
      logger: log,
    });
    // Capability validation: LLMProvider requires supportsCaching,
    // supportsThinking, and maxContextTokens. TypeScript enforces this for
    // typed plugins. For JS plugins, a missing field would surface as
    // undefined reads in the agent loop — fail-loud at resolution time.
    if (
      typeof provider.supportsCaching !== 'boolean' ||
      typeof provider.supportsThinking !== 'boolean' ||
      typeof provider.maxContextTokens !== 'number'
    ) {
      throw new Error(
        `LLM provider "${cfg.provider}" is missing required capability declarations ` +
          `(supportsCaching, supportsThinking, maxContextTokens). ` +
          `These must be declared on the provider instance.`,
      );
    }
    return provider;
  };

  if (config.providers && config.providers.length >= 2) {
    const instances = await Promise.all(
      config.providers.map((p) =>
        resolveOne({
          provider: p.provider,
          model: p.model ?? config.model,
          apiKey: p.apiKey,
          ...(p.baseUrl !== undefined ? { baseUrl: p.baseUrl } : {}),
          ...(p.apiVersion !== undefined ? { apiVersion: p.apiVersion } : {}),
        }),
      ),
    );
    return new ChainedProvider(instances);
  }

  // Anthropic rotation pool is provider-specific (rotates across API keys for
  // the same model). Handled inline — rotation is an Anthropic concern, not a
  // registry concern.
  if (config.provider === 'anthropic') {
    const rotation = config.rotationKeys ?? [];
    if (rotation.length > 0) {
      return new AuthRotatingProvider(
        [
          { id: 'primary', apiKey: config.apiKey, priority: 100 },
          ...rotation.map((k, i) => ({
            id: k.label ?? `key-${i + 1}`,
            apiKey: k.apiKey,
            priority: k.priority,
          })),
        ],
        config.model,
      );
    }
  }

  return resolveOne({
    provider: config.provider,
    model: config.model,
    apiKey: config.apiKey,
    ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    ...(config.apiVersion !== undefined ? { apiVersion: config.apiVersion } : {}),
  });
}

// Skill passthrough helpers live in a separate file so tests can import them
// without pulling in the heavy plugin-loader / docker / mcp dependency chain.
export { applySkillPassthrough, deriveSkillPassthrough } from './skill-passthrough';

// ---------------------------------------------------------------------------
// AgentLoop assembly
// ---------------------------------------------------------------------------

export async function createAgentLoop(
  config: WiringConfig,
  opts: CreateAgentLoopOptions,
): Promise<AgentLoop> {
  const { dataDir } = opts;
  const workingDir = opts.workingDir ?? process.cwd();
  const profile: WiringProfile = opts.profile ?? 'cli';
  const log: Logger = opts.logger ?? noopLogger;

  const NOOP_SECRETS: SecretsResolver = {
    get: async () => null,
    set: async () => {},
    delete: async () => {},
    list: async () => [],
  };

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
    return new MarkdownFileMemoryProvider({ dir });
  });
  memoryProviders.register('vector', ({ dataDir: dir }) => {
    return new VectorMemoryProvider({ dir });
  });

  // -------------------------------------------------------------------------
  // Personality + hooks + tools (infrastructure needed before plugin loading)
  // -------------------------------------------------------------------------

  const personalities = await createPersonalityRegistry();
  await personalities.loadFromDirectory(join(dataDir, 'personalities'));

  if (config.personality) {
    try {
      personalities.setDefault(config.personality);
    } catch {
      // Unknown personality — fall back to built-in default.
    }
  }

  // Capture the active personality once. Downstream wiring (kanban, MCP, skill
  // passthrough, watcher boot) all branch off this same value.
  const activePerson = personalities.getDefault();

  // Sandbox is shared by the browser and code tools. init() is non-blocking
  // when Docker is absent; the tool sets gate themselves on isAvailable().
  const sandbox = new DockerSandbox();
  if (!opts.disableDocker) {
    await sandbox.init();
    if (!sandbox.isAvailable()) log.warn('Docker not available — run_code tool disabled');
  }

  // The hook registry is created early so the kanban tools can be wired with it
  // (kanban_complete fires `before_ticket_complete`); later wiring registers the
  // skill injectors, terminal guard, kanban role gate, and plugin hooks onto it.
  const hooks = new DefaultHookRegistry();

  const secretsEnvMap: Record<string, string> = {
    'providers/exa/apiKey': 'ETHOS_EXA_API_KEY',
    'providers/openai/apiKey': 'OPENAI_API_KEY',
    'providers/replicate/apiToken': 'REPLICATE_API_TOKEN',
  };
  const resolver = config.secretsResolver;
  const capabilityBackends: CapabilityBackends = {
    kvStoreFactory: createKvStoreFactory(join(dataDir, 'sessions.db')),
    secretsBackend: async (ref) => {
      if (resolver) {
        const val = await resolver.get(ref);
        if (val !== null) return val;
      }
      const envVar = secretsEnvMap[ref];
      if (envVar) {
        const value = process.env[envVar];
        if (value) return value;
      }
      throw new Error(`Secret ${ref} not found (checked secrets store + env)`);
    },
    storage: new FsStorage(),
    personalityFsReach: {
      read: activePerson.fs_reach?.read ?? [],
      write: activePerson.fs_reach?.write ?? [],
    },
    personalityNetworkPolicy: activePerson.safety?.network ?? {},
    attachmentCache: new FsAttachmentCache(new FsStorage(), join(dataDir, 'cache', 'attachments')),
  };
  const tools = new DefaultToolRegistry(capabilityBackends);
  for (const tool of createFileTools()) tools.register(tool);
  for (const tool of createTerminalTools()) tools.register(tool);
  for (const tool of createWebTools()) tools.register(tool);
  // Memory tools are registered after plugin loading (they need `memory`).
  // One InMemoryTodoStore per process — lifetime tied to the AgentLoop; all
  // five todo_* tools share the same Map, keyed by ToolContext.sessionKey.
  const todoStore = new InMemoryTodoStore();
  for (const tool of createTodoTools(todoStore)) tools.register(tool);
  tools.register(createThinkDeeperTool());

  // Clarify bridge — backs the `clarify` tool (ask the user mid-turn, wait).
  // The store persists pending requests so surfaces survive a restart. A
  // surface (TUI / CLI / web-api) registers a presenter on this bridge; until
  // one does, `clarify` reports CLARIFY_NO_SURFACE and the agent uses prose.
  const clarifyBridge = new ClarifyBridge(
    new FileClarifyStore(new FsStorage(), join(dataDir, 'clarify')),
  );
  for (const tool of createInteractiveTools(clarifyBridge)) tools.register(tool);

  // Kanban tools are wired only when the active personality actually uses them.
  // The DB is per-personality in Plan A (one solo board); Plan B's team-supervisor
  // overrides kanbanDbPath to point at a shared team board.
  // KanbanStore handles its own parent-directory creation (same raw-fs exception
  // session-sqlite gets — see CLAUDE.md "Storage abstraction" exceptions).
  let kanbanStore: KanbanStore | null = null;
  if (personalityWantsKanban(activePerson)) {
    const kanbanDbPath = resolveKanbanDbPath(config, dataDir, activePerson.id);
    kanbanStore = new KanbanStore(kanbanDbPath);
    const store = kanbanStore;
    const kanbanOpts: Parameters<typeof createKanbanTools>[0] = { store, hooks };
    if (config.trustPolicy?.mode === 'tiered') {
      const policy = config.trustPolicy;
      kanbanOpts.autonomyTierOf = (assignee) => {
        const stats = store.getMemberStats();
        const s = stats.get(assignee);
        if (!s) return undefined;
        const total = s.ticketsCompleted + s.ticketsFailed + s.ticketsOrphaned;
        const ratio = total > 0 ? s.ticketsCompleted / total : 0;
        return { tier: autonomyTier(s, policy), ratio };
      };
    }
    for (const tool of createKanbanTools(kanbanOpts)) tools.register(tool);
  }
  for (const tool of createProcessTools(dataDir)) tools.register(tool);
  for (const tool of createImageTools({
    openaiApiKey: config.provider === 'openai' ? config.apiKey : undefined,
  }))
    tools.register(tool);

  // Vision tools are registered after plugin loading (they need `llm`).

  if (!opts.disableDocker) {
    for (const tool of createCodeTools(sandbox)) tools.register(tool);
    for (const tool of createBrowserTools({
      visionApiKey: config.apiKey,
      visionProvider: config.provider,
      visionModel: config.model,
    }))
      tools.register(tool);
  }

  // Collect mcp_env_passthrough from skills that are actually admitted for the
  // active personality. Skills rejected by allowed_skill_permissions or the
  // ingest filter cannot contribute passthrough. Passthrough is then applied
  // only to MCP servers the personality is allowed to reach (mcp_servers
  // allowlist), not globally to every server.
  const codingBundleSource = bundledCodingSkillsSource();
  const skillPool = await new UniversalScanner({
    trustedFirstPartySources: [codingBundleSource],
  }).scan();
  // Use the personality's declared toolset as an approximation for capability
  // filtering at boot time (MCP tools aren't registered yet).
  const bootToolNames = new Set(activePerson.toolset ?? []);
  const attachedServers = new Set(activePerson.mcp_servers ?? []);
  const skillPassthrough = deriveSkillPassthrough(skillPool, activePerson, bootToolNames);

  const rawMcpConfig = await loadMcpConfig();
  const mcpConfig = applySkillPassthrough(
    rawMcpConfig,
    skillPassthrough,
    attachedServers,
  ) as Awaited<ReturnType<typeof loadMcpConfig>>;
  const mcpManager = new McpManager(mcpConfig, { logger: log });
  await mcpManager.connect();
  for (const tool of mcpManager.getTools()) tools.register(tool);

  // Risk #2: warn at boot when MCP servers are globally configured but the active
  // personality has no mcp_servers allowlist — the tools will be registered but
  // the personality filter will hide them on every turn.
  if (mcpConfig.length > 0) {
    const attached = activePerson.mcp_servers ?? [];
    if (attached.length === 0) {
      const names = mcpConfig.map((s) => s.name).join(', ');
      log.warn(
        `MCP: 0 of ${mcpConfig.length} server(s) attached to "${activePerson.id}". ` +
          `Run 'ethos personality mcp ${activePerson.id} --attach <name>' to enable. ` +
          `Configured: ${names}`,
      );
    }
  }

  const designStorage = capabilityBackends.storage ?? new FsStorage();
  for (const tool of createPersonalityDesignTools({
    toolRegistry: tools,
    storage: designStorage,
    modelCatalog: MODEL_CATALOG,
    skills: [...skillPool.values()],
  })) {
    tools.register(tool);
  }
  for (const tool of createTeamDesignTools({
    personalityRegistry: personalities,
    storage: designStorage,
  })) {
    tools.register(tool);
  }

  const { injectors, tools: skillTools } = createInjectors(personalities, {
    onSkillSkip: (skillId, reason) => log.warn(`skill ${skillId} skipped: ${reason}`),
    trustedFirstPartySources: [codingBundleSource],
    hooks,
  });
  for (const tool of skillTools) tools.register(tool);

  // CLI/TUI/ACP get the synchronous block-and-explain guard. Web replaces it
  // with an interactive approval flow registered after createAgentLoop returns
  // (see @ethosagent/web-api). Both call sites share `checkCommand` via
  // `createDangerPredicate` below.
  if (profile !== 'web') {
    hooks.registerModifying('before_tool_call', createTerminalGuardHook());
  }

  // Plan B — kanban role gate: enforce coordinator-only / assignee-only rules
  // when the loop runs inside a team. Solo personalities (no teamName) bypass
  // entirely, so Plan A semantics are unchanged.
  if (kanbanStore !== null && config.teamName !== undefined && config.role !== undefined) {
    hooks.registerModifying(
      'before_tool_call',
      createKanbanRoleGateHook({
        role: config.role,
        personalityId: activePerson.id,
        store: kanbanStore,
      }),
    );
  }

  // Phase 3 — team memory: when running inside a team, wire a team-scoped
  // MarkdownFileMemoryProvider, register the three team_memory_* tools, seed
  // the memory directory if empty, and register a lazy index injector.
  if (config.teamName) {
    if (!isSafeTeamName(config.teamName)) {
      throw new Error(
        `Invalid teamName "${config.teamName}": must match [a-zA-Z0-9_-]+ (no path separators or traversal)`,
      );
    }
    const teamMemoryDir = join(dataDir, 'teams', config.teamName, 'memory');
    // Team memory uses lazy on-demand policy (prefetch suppressed; topic index
    // is injected via createTeamMemoryIndexInjector instead) and last-write-wins
    // conflict detection to prevent silent concurrent overwrites.
    const teamMemory = new LazyOnDemandPolicy(
      new LastWriteWinsPolicy(new MarkdownFileMemoryProvider({ dir: teamMemoryDir })),
    );

    // Seed bootstrap topic files if the directory has no .md files yet.
    await seedTeamMemory(teamMemory, config.teamName);

    for (const tool of createTeamMemoryTools(teamMemory)) tools.register(tool);

    if (config.postmortems !== false) {
      registerPostmortemHandler({ teamName: config.teamName, memory: teamMemory, hooks });
    }

    // Lazy index injector: injects a short list of available team memory
    // topics into the system prompt instead of loading all content upfront.
    injectors.push(createTeamMemoryIndexInjector(teamMemory, config.teamName));
  }

  // E4 — context-engine registry. Built-ins register at construction; the
  // PluginLoader exposes it so plugins can contribute custom engines via
  // `EthosPluginApi.registerContextEngine`. context_compression F1 — when an
  // auxiliary compression model is configured, `semantic_summary` gets a real
  // LLM summarizer instead of the placeholder.
  const { DefaultContextEngineRegistry } = await import('@ethosagent/core');
  const summarize = config.auxiliaryCompression?.model
    ? buildCompressionSummarizer(llmProviders, config, opts.observability, log)
    : undefined;
  const contextEngines = new DefaultContextEngineRegistry(summarize ? { summarize } : {});

  // Discover and activate installed plugins. Plugins register tools/hooks/
  // injectors into the same registries the AgentLoop uses; the personality
  // gate (allowedPlugins) decides which actually fire per turn.
  const injectorPluginIds = new Map<ContextInjector, string>();
  const pluginLoader = new PluginLoader(
    {
      tools,
      hooks,
      injectors,
      injectorPluginIds,
      personalities,
      contextEngines,
      llmProviders,
      memoryProviders,
    },
    { storage: new FsStorage(), logger: log },
  );
  await pluginLoader.loadAll();

  // -------------------------------------------------------------------------
  // Resolve LLM and memory AFTER plugin loading so plugin-contributed
  // providers are available for config-level selection.
  // -------------------------------------------------------------------------

  const llm = await createLLMFromRegistry(llmProviders, config, log);

  const session = new SQLiteSessionStore(join(dataDir, 'sessions.db'));
  const memoryName = config.memory ?? 'markdown';
  const memoryFactory = memoryProviders.get(memoryName);
  if (!memoryFactory) {
    throw new Error(
      `Memory provider "${memoryName}" is not registered. ` +
        `Available: ${memoryProviders.list().join(', ')}`,
    );
  }
  const memory = new EagerPrefetchPolicy(
    await memoryFactory({
      config: {},
      dataDir,
      secrets: config.secretsResolver ?? NOOP_SECRETS,
      logger: log,
    }),
  );
  for (const tool of createMemoryTools(memory, session)) tools.register(tool);

  // tools-vision P3 — register `vision_analyze`. The resolveProvider callback
  // maps model id to a concrete LLMProvider.
  const auxVisionConfig = config.auxiliaryVision;
  const auxVisionCollidesWithPrimary =
    auxVisionConfig !== undefined && auxVisionConfig.model === config.model;
  if (
    auxVisionConfig &&
    auxVisionCollidesWithPrimary &&
    (auxVisionConfig.provider !== undefined ||
      auxVisionConfig.apiKey !== undefined ||
      auxVisionConfig.baseUrl !== undefined)
  ) {
    log.warn(
      `auxiliary.vision.model ("${auxVisionConfig.model}") matches the primary model; ` +
        'auxiliary.vision.provider/apiKey/baseUrl overrides will be ignored. ' +
        'Either change the model id or drop the overrides.',
    );
  }
  let auxVisionProvider: LLMProvider | null = null;
  if (auxVisionConfig && !auxVisionCollidesWithPrimary) {
    const auxProviderName = auxVisionConfig.provider ?? config.provider;
    const auxFactory = llmProviders.get(auxProviderName);
    if (auxFactory) {
      auxVisionProvider = await auxFactory({
        config: {
          provider: auxProviderName,
          model: auxVisionConfig.model,
          apiKey: auxVisionConfig.apiKey ?? config.apiKey,
          ...((auxVisionConfig.baseUrl ?? config.baseUrl)
            ? { baseUrl: auxVisionConfig.baseUrl ?? config.baseUrl }
            : {}),
          ...(config.apiVersion ? { apiVersion: config.apiVersion } : {}),
        },
        secrets: config.secretsResolver ?? NOOP_SECRETS,
        logger: log,
      });
    } else {
      log.warn(
        `auxiliary.vision provider "${auxProviderName}" not registered; ` +
          `vision_analyze won't use auxiliary model`,
      );
    }
  }
  for (const tool of createVisionTools({
    resolveProvider: (model) => {
      if (model === config.model) return llm;
      if (auxVisionProvider && auxVisionConfig && model === auxVisionConfig.model) {
        return auxVisionProvider;
      }
      return null;
    },
    defaultModel: config.model,
    ...(auxVisionConfig && !auxVisionCollidesWithPrimary
      ? { auxiliaryVisionModel: auxVisionConfig.model }
      : {}),
  })) {
    tools.register(tool);
  }

  // E3 — auto-trigger for skill evolution. Only fires when the active
  // personality opts in via `skill_evolution.enabled`. Built-ins
  // (engineer, coordinator) ship with it on; everything else stays off.
  const { registerSkillEvolutionAutoTrigger } = await import('@ethosagent/skill-evolver');
  registerSkillEvolutionAutoTrigger({ hooks, personalities, dataDir });

  // Ch.6a — In-process watcher. Built with the default rule set
  // (rate-limit + token-budget + compounding-error + suspicious-
  // sequence). When an observability writer is wired, watcher
  // decisions land as audit.watcher events in observability.db.
  const { Watcher: WatcherClass, defaultRules: watcherDefaultRules } = await import(
    '@ethosagent/safety-watcher'
  );
  const watcher = new WatcherClass({
    rules: watcherDefaultRules(),
    ...(opts.observability ? { observability: opts.observability } : {}),
  });

  // Ch.3c Tier-2 — LLM injection classifier. Reuses the same LLM
  // provider as the agent loop. The personality's
  // safety.injectionDefense.classifier.alwaysCallLLM flag toggles
  // forced-on; AgentLoop also fires the classifier when content
  // > 500 chars or the Tier-1 pattern check hits.
  const { createLLMClassifier } = await import('@ethosagent/safety-injection');
  const injectionClassifier = createLLMClassifier({ llm });

  // P3 observability — request dump store. Lazily import so the package is
  // only loaded when the feature is enabled.
  let requestDumpStore: RequestDumpStore | undefined;
  if (config.observabilityRequestDump?.enabled) {
    const { JsonlRequestDumpStore } = await import('@ethosagent/request-dump');
    const dumpDir = config.observabilityRequestDump.dir ?? join(dataDir, 'request-dumps');
    requestDumpStore = new JsonlRequestDumpStore({
      dir: dumpDir,
      maxBytes: config.observabilityRequestDump.rotation?.maxBytes,
    });
  }

  // Adapt the registry into the Map shape AgentLoop expects for per-personality
  // memory resolution. Each factory gets the shared wiring context pre-bound.
  const memoryProviderMap = new Map<
    string,
    (options?: Record<string, unknown>) => MemoryProvider | Promise<MemoryProvider>
  >();
  for (const name of memoryProviders.list()) {
    const factory = memoryProviders.get(name);
    if (factory) {
      memoryProviderMap.set(name, (options) =>
        factory({
          config: options ?? {},
          dataDir,
          secrets: config.secretsResolver ?? NOOP_SECRETS,
          logger: log,
        }),
      );
    }
  }

  const loop = new AgentLoop({
    llm,
    tools,
    session,
    memory,
    personalities,
    injectors,
    injectorPluginIds,
    hooks,
    storage: new FsStorage(),
    dataDir,
    modelRouting: config.modelRouting,
    memoryProviders: memoryProviderMap,
    watcher,
    injectionClassifier,
    contextEngines,
    clarifyBridge,
    ...(config.teamName ? { teamId: config.teamName } : {}),
    ...(opts.observability ? { observability: opts.observability } : {}),
    ...(requestDumpStore ? { requestDumpStore } : {}),
    options: {
      platform: profile,
      workingDir,
    },
  });

  // Delegation tools need the loop reference; register after loop creation.
  // The registry is shared by reference, so the loop sees them on next turn.
  // meshRegistryPath scopes routing to the caller's mesh (CC — mesh isolation).
  for (const tool of createDelegationTools(loop, opts.meshRegistryPath)) tools.register(tool);

  // Phase tool-cap P1 — fail-loud-at-boot validation. Every tool reachable
  // for the active personality has its declared capabilities intersected
  // with the personality's policy (network.allow, fs_reach). A mismatch
  // here means a tool would silently surface HOST_NOT_ALLOWED /
  // PATH_NOT_REACHABLE at first call — fix the personality config or drop
  // the tool from its toolset.
  const validationErrors = tools.validateToolsForPersonality(activePerson);
  if (validationErrors.length > 0) {
    const summary = validationErrors
      .map((e) => `  ${e.tool} [${e.capability}]: ${e.message}`)
      .join('\n');
    throw new Error(
      `Tool capability validation failed for personality "${activePerson.id}":\n${summary}\n` +
        `Adjust the personality's safety.network.allow / fs_reach, or remove the tool from toolset.yaml.`,
    );
  }

  return loop;
}

// ---------------------------------------------------------------------------
// Phase 3 — team memory helpers (used only by createAgentLoop)
// ---------------------------------------------------------------------------

/** Reject team names that could be used for path traversal or directory aliasing. */
function isSafeTeamName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

const TEAM_MEMORY_BOOTSTRAP_TOPICS = [
  { key: 'onboarding', placeholder: '# Onboarding\n' },
  { key: 'decisions', placeholder: '# Decisions\n' },
] as const;

/**
 * Seed empty topic files via the team memory provider if no .md files exist
 * yet. Called once at AgentLoop wiring time (before the loop starts) so
 * agents always see at least the bootstrap topics in the lazy index.
 */
async function seedTeamMemory(teamMemory: MemoryProvider, teamName: string): Promise<void> {
  const seedCtx: MemoryContext = {
    scopeId: `team:${teamName}`,
    sessionId: 'seed',
    sessionKey: 'seed',
    platform: 'cli',
    workingDir: '',
  };
  try {
    const refs = await teamMemory.list(seedCtx);
    if (refs.length === 0) {
      for (const topic of TEAM_MEMORY_BOOTSTRAP_TOPICS) {
        // Seed with a minimal placeholder header so agents get something
        // meaningful back when they read the bootstrap topics on first use.
        await teamMemory.sync(
          [{ action: 'add', key: `${topic.key}.md`, content: topic.placeholder }],
          seedCtx,
        );
      }
    }
  } catch {
    // Non-fatal — team memory still works; agents just won't see bootstrap topics in the index.
  }
}

/**
 * ContextInjector that injects a short list of available team memory topics
 * into the system prompt at session start. Uses lazy mode — only topic names
 * are injected; content is loaded on demand via team_memory_read.
 */
function createTeamMemoryIndexInjector(
  teamMemory: MemoryProvider,
  teamName: string,
): ContextInjector {
  return {
    id: `team-memory-index:${teamName}`,
    priority: 70,

    async inject(ctx: PromptContext): Promise<InjectionResult | null> {
      const memCtx: MemoryContext = {
        scopeId: `team:${teamName}`,
        sessionId: ctx.sessionId,
        sessionKey: ctx.sessionKey,
        platform: ctx.platform,
        workingDir: ctx.workingDir ?? '',
      };

      let refs: MemoryEntryRef[];
      try {
        refs = await teamMemory.list(memCtx);
      } catch {
        return null;
      }

      // Filter to safe, non-USER topic keys only. isSafeTopicKey guards against
      // crafted filenames that could inject content into the system prompt.
      const topics = refs
        .filter((r) => r.key !== 'USER.md' && isSafeTopicKey(r.key))
        .map((r) => r.key.replace(/\.md$/i, ''));

      if (topics.length === 0) return null;

      const lines = topics.map((t) => `- ${t}`).join('\n');
      return {
        content: `Team memory topics available (call team_memory_read to load):\n${lines}`,
        position: 'append',
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Session / memory factories
// ---------------------------------------------------------------------------
// Apps that need a SessionStore or MemoryProvider before they build a full
// AgentLoop (e.g. the TUI session picker) ask wiring for one. Wiring keeps
// the choice of concrete backend; the app does not import session-sqlite or
// memory-markdown directly.

export interface CreateSessionStoreOptions {
  /** Root data directory (typically `~/.ethos`). */
  dataDir: string;
}

export function createSessionStore(opts: CreateSessionStoreOptions): SessionStore {
  return new SQLiteSessionStore(join(opts.dataDir, 'sessions.db'));
}

export interface CreateMemoryProviderOptions {
  /** Root data directory (typically `~/.ethos`). */
  dataDir: string;
}

// The markdown backend supports MEMORY.md / USER.md direct read/write
// (GlobalMemoryStore) alongside the contract methods. The factory
// advertises both via intersection so apps that need only one half
// narrow at the use site.
export function createMemoryProvider(
  opts: CreateMemoryProviderOptions,
): MemoryProvider & GlobalMemoryStore {
  return new MarkdownFileMemoryProvider({ dir: opts.dataDir });
}

// ---------------------------------------------------------------------------
// Danger predicate (shared between CLI guard + web approval flow)
// ---------------------------------------------------------------------------

export {
  type CreateDangerPredicateOptions,
  createDangerPredicate,
  type DangerPredicate,
  type DangerReason,
  type SmartApprovalCallback,
} from './danger-predicate';

export type { ModelSource, ModelTarget, ResolveModelInput } from './model-resolver';
// Re-export the resolver so callers don't need a separate import.
export { resolveModelTarget } from './model-resolver';

// ---------------------------------------------------------------------------
// Ethos observability adapter
// ---------------------------------------------------------------------------

export {
  ETHOS_EVENT_CATEGORIES,
  ETHOS_TRACE_KINDS,
  type EthosEventCategory,
  EthosObservability,
  type EthosTraceKind,
} from './observability/ethos-observability';
