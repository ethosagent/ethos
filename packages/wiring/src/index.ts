import { join } from 'node:path';
import {
  AgentLoop,
  ChainedProvider,
  DefaultHookRegistry,
  DefaultToolRegistry,
} from '@ethosagent/core';
import { AnthropicProvider, AuthRotatingProvider } from '@ethosagent/llm-anthropic';
import { OpenAICompatProvider } from '@ethosagent/llm-openai-compat';
import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import { VectorMemoryProvider } from '@ethosagent/memory-vector';
import { createPersonalityRegistry } from '@ethosagent/personalities';
import { PluginLoader } from '@ethosagent/plugin-loader';
import { DockerSandbox } from '@ethosagent/sandbox-docker';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { createInjectors, filterSkill, UniversalScanner } from '@ethosagent/skills';
import { FsStorage } from '@ethosagent/storage-fs';
import { createBrowserTools } from '@ethosagent/tools-browser';
import { createCodeTools } from '@ethosagent/tools-code';
import { createDelegationTools } from '@ethosagent/tools-delegation';
import { createFileTools } from '@ethosagent/tools-file';
import { createImageTools } from '@ethosagent/tools-image';
import { loadMcpConfig, McpManager } from '@ethosagent/tools-mcp';
import { createMemoryTools } from '@ethosagent/tools-memory';
import { createProcessTools } from '@ethosagent/tools-process';
import {
  checkCommand,
  createTerminalGuardHook,
  createTerminalTools,
} from '@ethosagent/tools-terminal';
import { createWebTools } from '@ethosagent/tools-web';
import type { BeforeToolCallPayload, ContextInjector, LLMProvider } from '@ethosagent/types';

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
   * Fallback provider chain. When 2+ entries are provided, `createLLM` wraps
   * them in a `ChainedProvider` with cooldown-based automatic failover.
   * Takes precedence over `provider`/`apiKey`/`model` when present.
   */
  providers?: WiringProviderConfig[];
}

export type WiringProfile = 'cli' | 'tui' | 'web' | 'acp';

export interface WiringLogger {
  warn: (msg: string) => void;
}

const NOOP_LOGGER: WiringLogger = { warn: () => {} };

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
  logger?: WiringLogger;
  /** Absolute path to the mesh registry file this agent belongs to.
   *  Controls which peers route_to_agent and broadcast_to_agents can see.
   *  Defaults to the 'default' mesh (~/.ethos/meshes/default/registry.json).
   *  Set by ethos serve --mesh <name> so team members route within their mesh. */
  meshRegistryPath?: string;
  /**
   * Optional observability service. When provided, passed through to
   * AgentLoop so LLM calls, tool calls, and hook blocks are recorded.
   * When absent, no observability writes occur.
   */
  observability?: import('@ethosagent/observability-sqlite').ObservabilityService;
}

// ---------------------------------------------------------------------------
// LLM provider construction
// ---------------------------------------------------------------------------

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
  const log: WiringLogger = opts.logger ?? NOOP_LOGGER;

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
  const activePerson = personalities.getDefault();
  const skillPool = await new UniversalScanner().scan();
  // Use the personality's declared toolset as an approximation for capability
  // filtering at boot time (MCP tools aren't registered yet).
  const bootToolNames = new Set(activePerson.toolset ?? []);
  const attachedServers = new Set(activePerson.mcp_servers ?? []);
  const skillPassthrough = new Set<string>();
  for (const skill of skillPool.values()) {
    const decision = filterSkill(skill, activePerson, bootToolNames);
    if (!decision.include) continue;
    for (const v of skill.permissions?.mcp_env_passthrough ?? []) {
      skillPassthrough.add(v);
    }
  }

  const rawMcpConfig = await loadMcpConfig();
  const mcpConfig =
    skillPassthrough.size === 0
      ? rawMcpConfig
      : rawMcpConfig.map((cfg) => {
          // Only grant extra passthrough to servers this personality can reach.
          if (attachedServers.size > 0 && !attachedServers.has(cfg.name)) return cfg;
          return {
            ...cfg,
            mcpEnvPassthrough: [
              ...new Set([...(cfg.mcpEnvPassthrough ?? []), ...skillPassthrough]),
            ],
          };
        });
  const mcpManager = new McpManager(mcpConfig);
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
  });
  for (const tool of skillTools) tools.register(tool);

  const hooks = new DefaultHookRegistry();
  // CLI/TUI/ACP get the synchronous block-and-explain guard. Web replaces it
  // with an interactive approval flow registered after createAgentLoop returns
  // (see @ethosagent/web-api). Both call sites share `checkCommand` via
  // `createDangerPredicate` below.
  if (profile !== 'web') {
    hooks.registerModifying('before_tool_call', createTerminalGuardHook());
  }

  // Discover and activate installed plugins. Plugins register tools/hooks/
  // injectors into the same registries the AgentLoop uses; the personality
  // gate (allowedPlugins) decides which actually fire per turn.
  const injectorPluginIds = new Map<ContextInjector, string>();
  const pluginLoader = new PluginLoader(
    { tools, hooks, injectors, injectorPluginIds, personalities },
    { storage: new FsStorage() },
  );
  await pluginLoader.loadAll();

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
// Danger predicate (shared between CLI guard + web approval flow)
// ---------------------------------------------------------------------------

/** Result returned by a danger predicate. `null` = no approval needed. */
export type DangerReason = string | null;
export type DangerPredicate = (payload: BeforeToolCallPayload) => DangerReason;

/**
 * Default danger predicate. Returns the human-readable reason when a tool
 * call should require explicit user approval (web profile) or be blocked
 * outright (CLI/TUI fallback path). Today only the `terminal` tool is
 * checked, but `alwaysAsk` lets surfaces opt additional tools into the
 * always-prompt set without baking the list in here.
 */
export function createDangerPredicate(
  opts: { alwaysAsk?: ReadonlyArray<string> } = {},
): DangerPredicate {
  const alwaysAsk = new Set(opts.alwaysAsk ?? []);
  return (payload) => {
    if (alwaysAsk.has(payload.toolName)) {
      return `${payload.toolName} requires explicit approval`;
    }
    if (payload.toolName === 'terminal') {
      const args = payload.args as { command?: string } | null | undefined;
      if (args?.command) {
        const result = checkCommand(args.command);
        if (result.dangerous) return result.reason;
      }
    }
    return null;
  };
}

export type { ModelSource, ModelTarget, ResolveModelInput } from './model-resolver';
// Re-export the resolver so callers don't need a separate import.
export { resolveModelTarget } from './model-resolver';
