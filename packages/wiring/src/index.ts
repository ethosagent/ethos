import { join } from 'node:path';
import {
  AgentLoop,
  ChainedProvider,
  DefaultHookRegistry,
  DefaultToolRegistry,
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
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { createInjectors, UniversalScanner } from '@ethosagent/skills';
import { bundledCodingSkillsSource } from '@ethosagent/skills-coding';
import { FsStorage } from '@ethosagent/storage-fs';
import { createBrowserTools } from '@ethosagent/tools-browser';
import { createCodeTools } from '@ethosagent/tools-code';
import { createDelegationTools } from '@ethosagent/tools-delegation';
import { createFileTools } from '@ethosagent/tools-file';
import { createImageTools } from '@ethosagent/tools-image';
import {
  createKanbanRoleGateHook,
  createKanbanTools,
  type TeamRole,
} from '@ethosagent/tools-kanban';
import { loadMcpConfig, McpManager } from '@ethosagent/tools-mcp';
import { createMemoryTools } from '@ethosagent/tools-memory';
import { createProcessTools } from '@ethosagent/tools-process';
import { createTerminalGuardHook, createTerminalTools } from '@ethosagent/tools-terminal';
import { createTodoTools, InMemoryTodoStore } from '@ethosagent/tools-todo';
import { createWebTools } from '@ethosagent/tools-web';
import type {
  ContextInjector,
  GlobalMemoryStore,
  LLMProvider,
  Logger,
  MemoryProvider,
  SessionStore,
} from '@ethosagent/types';
import { resolveKanbanDbPath } from './kanban-path';
import { applySkillPassthrough, deriveSkillPassthrough } from './skill-passthrough';

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
  const memory =
    config.memory === 'vector'
      ? new VectorMemoryProvider({ dir: dataDir })
      : new MarkdownFileMemoryProvider({ dir: dataDir });
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

  const tools = new DefaultToolRegistry();
  for (const tool of createFileTools()) tools.register(tool);
  for (const tool of createTerminalTools()) tools.register(tool);
  for (const tool of createWebTools()) tools.register(tool);
  for (const tool of createMemoryTools(memory, session)) tools.register(tool);
  // One InMemoryTodoStore per process — lifetime tied to the AgentLoop; all
  // five todo_* tools share the same Map, keyed by ToolContext.sessionKey.
  const todoStore = new InMemoryTodoStore();
  for (const tool of createTodoTools(todoStore)) tools.register(tool);

  // Kanban tools are wired only when the active personality actually uses them.
  // The DB is per-personality in Plan A (one solo board); Plan B's team-supervisor
  // overrides kanbanDbPath to point at a shared team board.
  // KanbanStore handles its own parent-directory creation (same raw-fs exception
  // session-sqlite gets — see CLAUDE.md "Storage abstraction" exceptions).
  let kanbanStore: KanbanStore | null = null;
  if (personalityWantsKanban(activePerson)) {
    const kanbanDbPath = resolveKanbanDbPath(config, dataDir, activePerson.id);
    kanbanStore = new KanbanStore(kanbanDbPath);
    for (const tool of createKanbanTools({ store: kanbanStore })) tools.register(tool);
  }
  for (const tool of createProcessTools(dataDir)) tools.register(tool);
  for (const tool of createImageTools()) tools.register(tool);
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

  const hooks = new DefaultHookRegistry();

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

  // E4 — context-engine registry. Built-ins register at construction; the
  // PluginLoader exposes it so plugins can contribute custom engines via
  // `EthosPluginApi.registerContextEngine`.
  const { DefaultContextEngineRegistry } = await import('@ethosagent/core');
  const contextEngines = new DefaultContextEngineRegistry();

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

  return loop;
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
