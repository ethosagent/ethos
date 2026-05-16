import { join } from 'node:path';
import {
  AgentLoop,
  type CapabilityBackends,
  ChainedProvider,
  ClarifyBridge,
  DefaultHookRegistry,
  DefaultToolRegistry,
  EagerPrefetchPolicy,
  FileClarifyStore,
  LastWriteWinsPolicy,
  LazyOnDemandPolicy,
  type SummarizerFn,
} from '@ethosagent/core';
import { KanbanStore } from '@ethosagent/kanban-store';
import { AnthropicProvider, AuthRotatingProvider } from '@ethosagent/llm-anthropic';
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
import { FsStorage } from '@ethosagent/storage-fs';
import { createBrowserTools } from '@ethosagent/tools-browser';
import { createCodeTools } from '@ethosagent/tools-code';
import { createDelegationTools } from '@ethosagent/tools-delegation';
import { createFileTools } from '@ethosagent/tools-file';
import { createImageTools } from '@ethosagent/tools-image';
import { createInteractiveTools } from '@ethosagent/tools-interactive';
import {
  createKanbanRoleGateHook,
  createKanbanTools,
  type TeamRole,
} from '@ethosagent/tools-kanban';
import { loadMcpConfig, McpManager } from '@ethosagent/tools-mcp';
import { createMemoryTools, createTeamMemoryTools, isSafeTopicKey } from '@ethosagent/tools-memory';
import { createProcessTools } from '@ethosagent/tools-process';
import { createTerminalGuardHook, createTerminalTools } from '@ethosagent/tools-terminal';
import { createTodoTools, InMemoryTodoStore } from '@ethosagent/tools-todo';
import { createVisionTools } from '@ethosagent/tools-vision';
import { createWebTools } from '@ethosagent/tools-web';
import type {
  ContextInjector,
  GlobalMemoryStore,
  InjectionResult,
  LLMProvider,
  Logger,
  MemoryContext,
  MemoryEntryRef,
  MemoryProvider,
  PromptContext,
  SecretsResolver,
  SessionStore,
} from '@ethosagent/types';
import { resolveKanbanDbPath } from './kanban-path';
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
}

export interface WiringConfig {
  provider: string;
  model: string;
  apiKey: string;
  personality?: string;
  memory?: 'markdown' | 'vector';
  baseUrl?: string;
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

function createSingleProvider(cfg: {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
}): LLMProvider {
  if (cfg.provider === 'anthropic') {
    return new AnthropicProvider({ apiKey: cfg.apiKey, model: cfg.model });
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
  config: WiringConfig,
  observability: EthosObservability | undefined,
  log: Logger,
): SummarizerFn {
  const aux = config.auxiliaryCompression;
  const provider = createSingleProvider({
    provider: aux?.provider ?? config.provider,
    model: aux?.model ?? config.model,
    apiKey: aux?.apiKey ?? config.apiKey,
    ...((aux?.baseUrl ?? config.baseUrl) ? { baseUrl: aux?.baseUrl ?? config.baseUrl } : {}),
  });
  return async (middle, targetTokens) => {
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
        baseUrl: p.baseUrl,
      }),
    );
    return new ChainedProvider(instances);
  }

  // Single provider (legacy path + rotation keys).
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
    return new AnthropicProvider({ apiKey: config.apiKey, model: config.model });
  }
  return new OpenAICompatProvider({
    name: config.provider,
    model: config.model,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl ?? 'https://openrouter.ai/api/v1',
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

  const llm = await createLLM(config);

  const session = new SQLiteSessionStore(join(dataDir, 'sessions.db'));
  // Personality memory uses eager prefetch: all content is injected at session
  // start.  EagerPrefetchPolicy is a pass-through that makes the intent explicit.
  const memory = new EagerPrefetchPolicy(
    config.memory === 'vector'
      ? new VectorMemoryProvider({ dir: dataDir })
      : new MarkdownFileMemoryProvider({ dir: dataDir }),
  );
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
  };
  const tools = new DefaultToolRegistry(capabilityBackends);
  for (const tool of createFileTools()) tools.register(tool);
  for (const tool of createTerminalTools()) tools.register(tool);
  for (const tool of createWebTools()) tools.register(tool);
  for (const tool of createMemoryTools(memory, session)) tools.register(tool);
  // One InMemoryTodoStore per process — lifetime tied to the AgentLoop; all
  // five todo_* tools share the same Map, keyed by ToolContext.sessionKey.
  const todoStore = new InMemoryTodoStore();
  for (const tool of createTodoTools(todoStore)) tools.register(tool);

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
    for (const tool of createKanbanTools({ store: kanbanStore, hooks })) tools.register(tool);
  }
  for (const tool of createProcessTools(dataDir)) tools.register(tool);
  for (const tool of createImageTools({
    openaiApiKey: config.provider === 'openai' ? config.apiKey : undefined,
  }))
    tools.register(tool);

  // tools-vision P3 — register `vision_analyze`. The capability table
  // (`@ethosagent/tools-vision`'s pricing.ts) gates per-model support; the
  // `resolveProvider` callback maps the resolved model id back to a concrete
  // LLMProvider. v1 routes two models: the personality's main model
  // (`config.model`) goes to the primary `llm`, and `auxiliary.vision.model`
  // (when set) goes to a freshly built aux provider that mirrors the
  // compression pattern — `provider`/`apiKey`/`baseUrl` default to the
  // primary's values. Other models resolve to null, which the tool maps to
  // VISION_NOT_SUPPORTED. The toolset gate filters out `vision_analyze`
  // entirely for personalities that don't list it.
  const auxVisionConfig = config.auxiliaryVision;
  // Honesty gate: the resolver routes by model id. If auxiliary.vision.model
  // matches the primary model but the user also set provider / apiKey /
  // baseUrl overrides, the primary-branch always wins and those overrides
  // silently never fire. Warn at boot so the misconfiguration surfaces
  // instead of wasting the user's debug session — and skip building the
  // dead auxiliary provider entirely, so its credentials are never even
  // exercised (no cost, no surprise auth side-effects).
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
  const auxVisionProvider: LLMProvider | null =
    auxVisionConfig && !auxVisionCollidesWithPrimary
      ? createSingleProvider({
          provider: auxVisionConfig.provider ?? config.provider,
          model: auxVisionConfig.model,
          apiKey: auxVisionConfig.apiKey ?? config.apiKey,
          ...((auxVisionConfig.baseUrl ?? config.baseUrl)
            ? { baseUrl: auxVisionConfig.baseUrl ?? config.baseUrl }
            : {}),
        })
      : null;
  for (const tool of createVisionTools({
    resolveProvider: (model) => {
      if (model === config.model) return llm;
      if (auxVisionProvider && auxVisionConfig && model === auxVisionConfig.model) {
        return auxVisionProvider;
      }
      return null;
    },
    defaultModel: config.model,
    // Skip threading the aux model when it collides with the primary: the
    // fallback chain already collapses (both right operands resolve to
    // `defaultModel`), so the spread would be dead. Keep the call honest about
    // whether an auxiliary model is actually in effect.
    ...(auxVisionConfig && !auxVisionCollidesWithPrimary
      ? { auxiliaryVisionModel: auxVisionConfig.model }
      : {}),
  })) {
    tools.register(tool);
  }

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
    ? buildCompressionSummarizer(config, opts.observability, log)
    : undefined;
  const contextEngines = new DefaultContextEngineRegistry(summarize ? { summarize } : {});

  // Discover and activate installed plugins. Plugins register tools/hooks/
  // injectors into the same registries the AgentLoop uses; the personality
  // gate (allowedPlugins) decides which actually fire per turn.
  const injectorPluginIds = new Map<ContextInjector, string>();
  const pluginLoader = new PluginLoader(
    { tools, hooks, injectors, injectorPluginIds, personalities, contextEngines },
    { storage: new FsStorage(), logger: log },
  );
  await pluginLoader.loadAll();

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
    watcher,
    injectionClassifier,
    contextEngines,
    clarifyBridge,
    ...(config.teamName ? { teamId: config.teamName } : {}),
    ...(opts.observability ? { observability: opts.observability } : {}),
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
