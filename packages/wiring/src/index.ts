import { join } from 'node:path';
import { type AgentLoop, ChainedProvider, type SummarizerFn, validateUrl } from '@ethosagent/core';
import type { CronScheduler } from '@ethosagent/cron';
import type { GoalRunner } from '@ethosagent/goal-runner';
import type { TrustPolicy } from '@ethosagent/kanban-store';
import { AnthropicProvider, AuthRotatingProvider } from '@ethosagent/llm-anthropic';
import { AzureOpenAIProvider } from '@ethosagent/llm-azure';
import { CodexProvider, ensureValidToken } from '@ethosagent/llm-codex';
import { OpenAICompatProvider } from '@ethosagent/llm-openai-compat';
import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import type { PluginLoader } from '@ethosagent/plugin-loader';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import type { TeamRole } from '@ethosagent/tools-kanban';
import type { McpManager } from '@ethosagent/tools-mcp';
import type { MessagingSendFn } from '@ethosagent/tools-messaging';
import type {
  GlobalMemoryStore,
  LLMProvider,
  Logger,
  MemoryProvider,
  SecretsResolver,
  SessionStore,
  ToolRegistry,
} from '@ethosagent/types';

export type { WiringContext } from './types';

import { buildAgentLoop } from './build-agent-loop';
import { buildWiringContext } from './build-context';
import { buildInfrastructure } from './build-infrastructure';
import { composeAllTools } from './compose-tools';
import { loadPlugins } from './load-plugins';
import type { EthosObservability } from './observability/ethos-observability';
import { capSummary, renderMiddleForSummary, SUMMARIZER_SYSTEM_PROMPT } from './summarizer-prompt';

// ---------------------------------------------------------------------------
// Messaging gateway — send function type re-exported for callers
// ---------------------------------------------------------------------------

export type { MessagingSendFn } from '@ethosagent/tools-messaging';

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
  /** Storage-layer settings. When `encryption` is true, the primary FsStorage
   *  is wrapped in CryptoStorage using ETHOS_STORAGE_KEY. */
  storage?: {
    encryption?: boolean;
  };
  /**
   * Remote model catalog configuration. When provided with `enabled !== false`,
   * the wiring loads the remote catalog (with cache/fallback) and uses it
   * instead of the static bundled MODEL_CATALOG.
   */
  modelCatalogConfig?: {
    enabled?: boolean;
    url?: string;
    ttlHours?: number;
    providers?: Record<string, { url: string }>;
  };
  /** Whether to auto-install plugins from plugins.lock on personality load. */
  pluginsAutoInstall?: boolean;
}

export type WiringProfile = 'cli' | 'tui' | 'web' | 'acp';

/**
 * Minimal structural shape of the app-layer slash command registry. Wiring
 * must not import the apps' concrete class (layering: apps depend on wiring,
 * never the reverse), so this declares exactly what plugin loading needs to
 * surface plugin-registered commands in autocomplete + /help.
 */
export interface WiringSlashRegistry {
  register(cmd: { name: string; description: string; usage: string; prefix?: string }): void;
  get(name: string): { description?: string; usage?: string } | undefined;
}

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
  /**
   * Shared CronScheduler for agent-callable cron tools. When provided, the
   * 6 tools from `@ethosagent/tools-cron` (`create_cron_job`,
   * `list_cron_jobs`, `delete_cron_job`, `pause_cron_job`,
   * `resume_cron_job`, `run_cron_job_now`) are registered on this
   * AgentLoop's tool registry. Personalities opt in by listing the tool
   * names in their `toolset.yaml` — the same scheduler instance that fires
   * operator-created jobs also accepts agent-created ones.
   *
   * When unset, the cron tools are not registered, and personalities that
   * list them get an "unknown tool" error at call time. CLI / standalone
   * `ethos chat` profiles typically leave this unset; `ethos gateway` and
   * `ethos serve` pass their scheduler instance through.
   */
  cronScheduler?: CronScheduler;
  /**
   * App-layer slash command registry. When provided, plugins that call
   * `registerSlashCommand` during loading land their commands here so the
   * CLI's autocomplete and /help can surface them. Omit for surfaces with
   * no slash command UI (web, ACP).
   */
  slashRegistry?: WiringSlashRegistry;
}

// ---------------------------------------------------------------------------
// LLM provider construction
// ---------------------------------------------------------------------------

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
  // SSRF gate: validate user-supplied base URLs before handing them to SDK
  // clients. `allowLocalhost` is true because local providers (Ollama, LM
  // Studio) are a legitimate use case for OpenAI-compat providers.
  if (cfg.baseUrl) {
    validateUrl(cfg.baseUrl, { allowLocalhost: true });
  }

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
  if (cfg.provider === 'codex') {
    return new CodexProvider({
      model: cfg.model,
      getAccessToken: async () => {
        const creds = await ensureValidToken(globalThis.fetch);
        return creds.accessToken;
      },
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

export interface CreateAgentLoopResult {
  loop: AgentLoop;
  toolRegistry: ToolRegistry;
  /** The McpManager instance from tool composition. Pass to createWebApi so
   *  re-auth via the web UI hits the live manager and updates the tool registry. */
  mcpManager: McpManager;
  /** Replace the messaging tool's send implementation with the real gateway.
   *  Called from gateway.ts after Gateway construction. Scoped to this loop
   *  instance — multiple loops in the same process are independent. */
  setMessagingSend: (fn: MessagingSendFn) => void;
  /** Set by the web-api chat service to receive SSE notifications when the
   *  improvement fork proposes a new skill candidate. */
  setOnSkillProposed?: (fn: (skillId: string, personalityId: string) => void) => void;
  /** Set by the web-api chat service to receive SSE notifications when the
   *  improvement fork auto-promotes a skill to the live library. */
  setOnSkillApplied?: (fn: (skillId: string, personalityId: string) => void) => void;
  /** v2.2 — Notification router for registering per-session adapters.
   *  CLI/TUI/web-api register a NotificationAdapter on this router so plugin
   *  monitors can deliver messages to the active surface. */
  notificationRouter: import('@ethosagent/types').NotificationRouter;
  /** v2.2 — Plugin loader instance for health checks and diagnostics. */
  pluginLoader: PluginLoader;
  /** Loop-bearing goal runner — always present (backed by the shared goals.db).
   *  Shared with the web-api GoalsService so web-created goals execute on the same runner+store. */
  goalRunner: GoalRunner;
}

export async function createAgentLoop(
  config: WiringConfig,
  opts: CreateAgentLoopOptions,
): Promise<CreateAgentLoopResult> {
  const { wiringCtx, profile, log } = buildWiringContext(config, opts);

  // -------------------------------------------------------------------------
  // Infrastructure: registries, personalities, sandbox, hooks, session,
  // capability backends, tool registry, clarify bridge
  // -------------------------------------------------------------------------

  const infra = await buildInfrastructure(wiringCtx, config, opts);

  // -------------------------------------------------------------------------
  // Tool composition: all tool groups, hooks, skills, MCP, design tools,
  // guard hooks, team memory.
  // -------------------------------------------------------------------------

  const toolsResult = await composeAllTools(wiringCtx, config, opts, { infra, profile });
  const { skillPool, injectors, skillScanner } = toolsResult;

  // -------------------------------------------------------------------------
  // Plugin loading: context engines + plugin registries + plugin loader
  // -------------------------------------------------------------------------

  const pluginsResult = await loadPlugins(wiringCtx, config, opts, {
    tools: infra.tools,
    hooks: infra.hooks,
    injectors,
    personalities: infra.personalities,
    llmProviders: infra.llmProviders,
    memoryProviders: infra.memoryProviders,
    activePerson: infra.activePerson,
    skillScanner,
    skillPool,
    buildCompressionSummarizer: () =>
      config.auxiliaryCompression?.model
        ? buildCompressionSummarizer(infra.llmProviders, config, opts.observability, log)
        : undefined,
    ...(opts.slashRegistry ? { slashRegistry: opts.slashRegistry } : {}),
  });

  // -------------------------------------------------------------------------
  // Resolve LLM AFTER plugin loading so plugin-contributed providers are
  // available for config-level selection.
  // -------------------------------------------------------------------------

  const llm = await createLLMFromRegistry(infra.llmProviders, config, log);

  // -------------------------------------------------------------------------
  // Final assembly: memory, vision, improvement fork, safety, AgentLoop.
  // -------------------------------------------------------------------------

  return buildAgentLoop(wiringCtx, config, opts, {
    infra,
    toolsResult,
    pluginsResult,
    llm,
    profile,
  });
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

export { IdentityMap, type IdentityMapEntry, type IdentityMapOptions } from './identity-map';
export {
  ETHOS_EVENT_CATEGORIES,
  ETHOS_TRACE_KINDS,
  type EthosEventCategory,
  EthosObservability,
  type EthosTraceKind,
} from './observability/ethos-observability';
