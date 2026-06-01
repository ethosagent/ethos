import { join } from 'node:path';
import {
  AgentLoop,
  ChainedProvider,
  ClarifyBridge,
  DefaultHookRegistry,
  DefaultLLMProviderRegistry,
  DefaultMemoryProviderRegistry,
  DefaultNotificationRouter,
  DefaultToolRegistry,
  DefaultToolResultReducerRegistry,
  EagerPrefetchPolicy,
  FileClarifyStore,
  LastWriteWinsPolicy,
  LazyOnDemandPolicy,
  SimpleCompletionImpl,
  validateUrl,
} from '@ethosagent/core';
import { autonomyTier, KanbanStore } from '@ethosagent/kanban-store';
import { AnthropicProvider, AuthRotatingProvider } from '@ethosagent/llm-anthropic';
import { AzureOpenAIProvider } from '@ethosagent/llm-azure';
import { OpenAICompatProvider } from '@ethosagent/llm-openai-compat';
import { noopLogger } from '@ethosagent/logger';
import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import { VectorMemoryProvider } from '@ethosagent/memory-vector';
import { createPersonalityRegistry } from '@ethosagent/personalities';
import {
  platformId as discordId,
  platformPrompt as discordPrompt,
} from '@ethosagent/platform-discord/format';
import {
  platformId as emailId,
  platformPrompt as emailPrompt,
} from '@ethosagent/platform-email/format';
import {
  platformId as slackId,
  platformPrompt as slackPrompt,
} from '@ethosagent/platform-slack/format';
import {
  platformId as telegramId,
  platformPrompt as telegramPrompt,
} from '@ethosagent/platform-telegram/format';
import { PluginLoader } from '@ethosagent/plugin-loader';
import { DiagnosticStore, OAuthCoordinatorImpl, PluginEventBus } from '@ethosagent/plugin-sdk';
import { DockerSandbox } from '@ethosagent/sandbox-docker';
import { createKvStoreFactory, SQLiteSessionStore } from '@ethosagent/session-sqlite';
import {
  bundledSkillsSource,
  createInjectors,
  PlatformFormattingInjector,
  UniversalScanner,
} from '@ethosagent/skills';
import { createCryptoStorage } from '@ethosagent/storage-crypto';
import { FsAttachmentCache, FsStorage, REF_TO_ENV } from '@ethosagent/storage-fs';
import { createBrowserTools } from '@ethosagent/tools-browser';
import { createCodeTools } from '@ethosagent/tools-code';
import { readFileReducer } from '@ethosagent/tools-code/reducers/read-file';
import { createCronTool } from '@ethosagent/tools-cron';
import { createDelegationTools } from '@ethosagent/tools-delegation';
import { createFileTools } from '@ethosagent/tools-file';
import { createImageTools } from '@ethosagent/tools-image';
import { createInteractiveTools } from '@ethosagent/tools-interactive';
import {
  createKanbanRoleGateHook,
  createKanbanTools,
  registerPostmortemHandler,
} from '@ethosagent/tools-kanban';
import { kanbanListReducer } from '@ethosagent/tools-kanban/reducers/kanban-list';
import { loadMcpConfig, McpManager } from '@ethosagent/tools-mcp';
import { createMemoryTools, createTeamMemoryTools, isSafeTopicKey } from '@ethosagent/tools-memory';
import { createMessagingTools } from '@ethosagent/tools-messaging';
import {
  createPersonalityDesignTools,
  createTeamDesignTools,
} from '@ethosagent/tools-personality-design';
import { createProcessGuardHook, createProcessTools } from '@ethosagent/tools-process';
import { createSkillsTools } from '@ethosagent/tools-skills';
import { createTerminalGuardHook, createTerminalTools } from '@ethosagent/tools-terminal';
import { bashReducer } from '@ethosagent/tools-terminal/reducers/bash';
import { createThinkDeeperTool } from '@ethosagent/tools-tier';
import { createTodoTools, InMemoryTodoStore } from '@ethosagent/tools-todo';
import { createTtsTools } from '@ethosagent/tools-tts';
import { createVisionTools } from '@ethosagent/tools-vision';
import { createWebTools } from '@ethosagent/tools-web';
import { resolveKanbanDbPath } from './kanban-path';
import { MODEL_CATALOG } from './model-catalog';
import { fetchManifest, loadModelCatalog, manifestToEntries } from './model-catalog-loader';
import { applySkillPassthrough, deriveSkillPassthrough } from './skill-passthrough';
import { capSummary, renderMiddleForSummary, SUMMARIZER_SYSTEM_PROMPT } from './summarizer-prompt';

// ---------------------------------------------------------------------------
// LLM provider construction
// ---------------------------------------------------------------------------
function personalityWantsKanban(p) {
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
function createSingleProvider(cfg) {
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
function buildCompressionSummarizer(registry, config, observability, log) {
  const aux = config.auxiliaryCompression;
  const providerName = aux?.provider ?? config.provider;
  let cachedProvider;
  const getProvider = async () => {
    if (cachedProvider) return cachedProvider;
    const factory = registry.get(providerName);
    if (!factory) {
      throw new Error(
        `LLM provider "${providerName}" is not registered (compression summarizer). ` +
          `Available: ${registry.list().join(', ')}`,
      );
    }
    const NOOP = {
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
export async function createLLM(config) {
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
async function createLLMFromRegistry(registry, config, log) {
  const secrets = {
    get: async () => null,
    set: async () => {},
    delete: async () => {},
    list: async () => [],
  };
  const resolveOne = async (cfg) => {
    const factory = registry.get(cfg.provider);
    if (!factory) {
      throw new Error(
        `LLM provider "${cfg.provider}" is not registered. ` +
          `Available: ${registry.list().join(', ')}`,
      );
    }
    const provider = await factory({
      config: cfg,
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

const WEB_PROMPT = `## Output format — Web UI

You are responding in a web application with rich markdown rendering. Follow these rules:

- Use full GitHub-flavoured markdown: **bold**, *italic*, # headers, ## subheaders,
  bullet lists (- or *), numbered lists, \`inline code\`, \`\`\`code blocks\`\`\`, tables,
  and horizontal rules (---).
- Structure multi-part answers with ## headers. Use ### for sub-sections.
- Use tables for comparisons with 3+ attributes.
- Code blocks must include the language identifier: \`\`\`typescript.
- Links: [text](url). Images: ![alt](url) when relevant.
- Aim for visual hierarchy — readers scan before they read.
- Length is not constrained by platform. Match depth to complexity.
- Use > blockquotes for direct quotations or highlighted callouts.`;
const platformPrompts = new Map([
  [slackId, slackPrompt],
  [telegramId, telegramPrompt],
  [discordId, discordPrompt],
  [emailId, emailPrompt],
  ['web', WEB_PROMPT],
]);
export async function createAgentLoop(config, opts) {
  const { dataDir } = opts;
  const workingDir = opts.workingDir ?? process.cwd();
  const profile = opts.profile ?? 'cli';
  const log = opts.logger ?? noopLogger;
  // Storage encryption — fail fast if enabled without the required env var.
  if (config.storage?.encryption) {
    const key = process.env.ETHOS_STORAGE_KEY;
    if (!key) {
      console.error(
        'Error: storage encryption is enabled but ETHOS_STORAGE_KEY is not set.\n' +
          'Set it in your environment or EnvironmentFile before starting Ethos.',
      );
      process.exit(1);
    }
  }
  const NOOP_SECRETS = {
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
    const apiKey = (await secrets.get('providers/anthropic/apiKey')) ?? cfg.apiKey;
    return new AnthropicProvider({ apiKey, model: cfg.model });
  });
  llmProviders.register('azure', async ({ config: cfg, secrets }) => {
    if (!cfg.baseUrl) {
      throw new Error(
        'Azure provider requires `baseUrl` set to the resource endpoint ' +
          '(e.g. https://my-resource.openai.azure.com).',
      );
    }
    const apiKey = (await secrets.get('providers/azure/apiKey')) ?? cfg.apiKey;
    return new AzureOpenAIProvider({
      name: 'azure',
      model: cfg.model,
      apiKey,
      endpoint: cfg.baseUrl,
      apiVersion: cfg.apiVersion ?? AZURE_DEFAULT_API_VERSION,
    });
  });
  const openaiCompatFactory = async ({ config: cfg, secrets }) => {
    const providerName = cfg.provider ?? 'openai-compat';
    const apiKey = (await secrets.get(`providers/${providerName}/apiKey`)) ?? cfg.apiKey;
    return new OpenAICompatProvider({
      name: providerName,
      model: cfg.model,
      apiKey,
      baseUrl: cfg.baseUrl ?? 'https://openrouter.ai/api/v1',
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
  const resolver = config.secretsResolver;
  const capabilityBackends = {
    kvStoreFactory: createKvStoreFactory(join(dataDir, 'sessions.db')),
    secretsBackend: async (ref) => {
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
  const reducerRegistry = new DefaultToolResultReducerRegistry();
  reducerRegistry.register(bashReducer);
  reducerRegistry.register(readFileReducer);
  reducerRegistry.register(kanbanListReducer);
  const tools = new DefaultToolRegistry(capabilityBackends, reducerRegistry);
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
  let kanbanStore = null;
  if (personalityWantsKanban(activePerson)) {
    const kanbanDbPath = resolveKanbanDbPath(config, dataDir, activePerson.id);
    kanbanStore = new KanbanStore(kanbanDbPath);
    const store = kanbanStore;
    const kanbanOpts = { store, hooks };
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
  // Messaging tools — send_message for cross-platform outbound.
  // The actual `send` function is injected later when the Gateway is constructed
  // (see apps/ethos/src/commands/gateway.ts). When no gateway is active (CLI mode),
  // the tool returns "not_available" via the default gatewaySendFn.
  // The mutable is scoped to this createAgentLoop invocation (not module-global)
  // so multiple loops in the same process don't share send state.
  let gatewaySendFn = async () => ({
    ok: false,
    error: 'Gateway not active — send_message requires gateway mode',
  });
  // Per-personality outbound allowlist. Read once from `<dataDir>/messaging.json`
  // (operator-level, sibling of mcp.json). Shape: `{ "<personality-id>": [<targets>] }`
  // where each target is `<platform>:<id>` (e.g. `slack:C0123ABC`,
  // `telegram:-100123`) or the wildcard `*`. Personalities absent from the
  // file deny every send — same default-deny posture as before this hook
  // existed. Per-channel adapter config is explicitly NOT part of
  // PersonalityConfig (see CLAUDE.md §"What does NOT belong on
  // PersonalityConfig"), so this lives alongside the personality but outside
  // its frozen schema.
  const messagingAllowlist = await loadMessagingAllowlist(dataDir);
  for (const tool of createMessagingTools({
    send: async (platform, target, body, botKey) => gatewaySendFn(platform, target, body, botKey),
    getAllowedTargets: (personalityId) => {
      if (!personalityId) return [];
      return messagingAllowlist.get(personalityId) ?? [];
    },
  }))
    tools.register(tool);
  // Cron tool — single action-dispatch `cron` tool for recurring jobs.
  // Registered only when a CronScheduler was threaded through (typically
  // by `ethos gateway` or `ethos serve`). Personalities opt in by listing
  // `cron` in their `toolset.yaml`.
  if (opts.cronScheduler) {
    for (const tool of createCronTool(opts.cronScheduler)) tools.register(tool);
  }
  // TTS tool — text_to_speech. Provider is wired from config.auxiliary?.tts.
  // Registers as unavailable when provider is null (no TTS configured).
  for (const tool of createTtsTools({ provider: null })) tools.register(tool);
  // Collect mcp_env_passthrough from skills that are actually admitted for the
  // active personality. Skills rejected by allowed_skill_permissions or the
  // ingest filter cannot contribute passthrough. Passthrough is then applied
  // only to MCP servers the personality is allowed to reach (mcp_servers
  // allowlist), not globally to every server.
  const codingBundleSource = bundledSkillsSource();
  const skillPool = await new UniversalScanner({
    trustedFirstPartySources: [codingBundleSource],
  }).scan();
  // Use the personality's declared toolset as an approximation for capability
  // filtering at boot time (MCP tools aren't registered yet).
  const bootToolNames = new Set(activePerson.toolset ?? []);
  const attachedServers = new Set(activePerson.mcp_servers ?? []);
  const skillPassthrough = deriveSkillPassthrough(skillPool, activePerson, bootToolNames);
  // Skill introspection tools — skills_list + skill_view.
  for (const tool of createSkillsTools({
    listSkills: () => {
      return [...skillPool.values()].map((s) => ({
        name: s.name,
        description: s.rawFrontmatter.description ?? s.body.split('\n')[0]?.slice(0, 120) ?? '',
        kind: s.dialect,
      }));
    },
    getSkillContent: (name) => {
      for (const skill of skillPool.values()) {
        if (skill.name === name || skill.qualifiedName === name) return skill.body;
      }
      return null;
    },
  }))
    tools.register(tool);
  const rawMcpConfig = await loadMcpConfig();
  const mcpConfig = applySkillPassthrough(rawMcpConfig, skillPassthrough, attachedServers);
  const mcpManager = new McpManager(mcpConfig, {
    logger: log,
    enableScopeProbe: process.env.ETHOS_MCP_SCOPE_PROBE === '1',
    innerSecrets: config.secretsResolver,
    // Phase A.5 — propagate runtime addServer/removeServer to the ToolRegistry
    // so an in-progress chat session sees new MCP tools on its next turn.
    onToolsChanged: (added, removedNames) => {
      for (const t of added) tools.register(t);
      for (const name of removedNames) tools.unregister(name);
    },
  });
  // Phase B — per-personality MCP connections. OAuth servers get isolated
  // token storage scoped to the active personality; stdio servers share a
  // single connection across all personalities.
  const mcpTools = await mcpManager.getToolsForPersonality(activePerson.id);
  for (const tool of mcpTools) tools.register(tool);
  // Risk #2: warn at boot when MCP servers are globally configured but the active
  // personality has no mcp_servers allowlist — the tools will be registered but
  // the personality filter will hide them on every turn.
  if (mcpConfig.length > 0) {
    const attached = activePerson.mcp_servers ?? [];
    if (attached.length === 0) {
      const names = mcpConfig.map((s) => s.name).join(', ');
      // Demoted from warn: not having MCP servers attached to a given
      // personality is a common, deliberate state (the operator chose which
      // personalities should see which servers). Surface the actionable
      // hint at info so it stays auditable without spamming the chat
      // console at every boot.
      log.info(
        `MCP: 0 of ${mcpConfig.length} server(s) attached to "${activePerson.id}". ` +
          `Run 'ethos personality mcp ${activePerson.id} --attach <name>' to enable. ` +
          `Configured: ${names}`,
      );
    }
  }
  let designStorage = capabilityBackends.storage ?? new FsStorage();
  if (config.storage?.encryption) {
    const passphrase = process.env.ETHOS_STORAGE_KEY ?? '';
    designStorage = createCryptoStorage(designStorage, passphrase);
  }
  // Remote model catalog: load from network/cache when configured, else fall back
  // to the bundled static array.
  let resolvedModelCatalog = MODEL_CATALOG;
  if (config.modelCatalogConfig && config.modelCatalogConfig.enabled !== false) {
    try {
      const catalogUrl =
        config.modelCatalogConfig.url ?? 'https://ethos-agent.ai/api/model-catalog.json';
      const ttlMs = (config.modelCatalogConfig.ttlHours ?? 24) * 3_600_000;
      const cachePath = join(dataDir, 'cache', 'model-catalog.json');
      const manifest = await loadModelCatalog({
        url: catalogUrl,
        ttlMs,
        storage: designStorage,
        cachePath,
        logger: log,
      });
      if (config.modelCatalogConfig.providers) {
        for (const [providerId, providerCfg] of Object.entries(
          config.modelCatalogConfig.providers,
        )) {
          try {
            const providerManifest = await fetchManifest(providerCfg.url);
            if (providerManifest.providers[providerId]) {
              manifest.providers[providerId] = providerManifest.providers[providerId];
            }
          } catch {
            log.warn(
              `model catalog: per-provider override for '${providerId}' failed; using main catalog`,
            );
          }
        }
      }
      resolvedModelCatalog = manifestToEntries(manifest);
    } catch {
      log.warn('model catalog: remote load failed during wiring; using bundled snapshot');
    }
  }
  for (const tool of createPersonalityDesignTools({
    toolRegistry: tools,
    storage: designStorage,
    modelCatalog: resolvedModelCatalog,
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
  const {
    injectors,
    tools: skillTools,
    scanner: skillScanner,
  } = createInjectors(personalities, {
    // Skipped at info level: a personality whose toolset lacks tools a
    // bundled skill requires is the common, expected case (e.g. the
    // personality-architect interviewer doesn't have read_file/terminal,
    // so coding skills filter out). Demoted from warn so the operator's
    // chat console isn't spammed at boot. Audit trail still flows via the
    // logger sink for anyone investigating "why didn't <skill> load?".
    onSkillSkip: (skillId, reason) => log.info(`skill ${skillId} skipped: ${reason}`),
    trustedFirstPartySources: [codingBundleSource],
    hooks,
  });
  for (const tool of skillTools) tools.register(tool);
  injectors.unshift(new PlatformFormattingInjector(platformPrompts));
  // CLI/TUI/ACP get the synchronous block-and-explain guard. Web replaces it
  // with an interactive approval flow registered after createAgentLoop returns
  // (see @ethosagent/web-api). Both call sites share `checkCommand` via
  // `createDangerPredicate` below.
  if (profile !== 'web') {
    hooks.registerModifying('before_tool_call', createTerminalGuardHook());
    // process_start invokes `spawn(command, [], { shell: true })` with an
    // LLM-controlled command string — structurally the same exposure as
    // `terminal`. The process guard mirrors the terminal guard's pattern
    // list; each hook gates only its own tool by toolName, so they coexist
    // safely under the modifying hook contract.
    hooks.registerModifying('before_tool_call', createProcessGuardHook());
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
  const injectorPluginIds = new Map();
  const pluginFilters = [];
  const pluginEvaluators = [];
  const pluginRoutes = [];
  const pluginEventBus = new PluginEventBus();
  const oauthCoordinator = new OAuthCoordinatorImpl();
  const notificationRouter = new DefaultNotificationRouter();
  const pluginDiagnostics = new DiagnosticStore();
  const pluginRegistries = {
    tools,
    hooks,
    injectors,
    injectorPluginIds,
    personalities,
    contextEngines,
    llmProviders,
    memoryProviders,
    filters: pluginFilters,
    evaluators: pluginEvaluators,
    routes: pluginRoutes,
    eventBus: pluginEventBus,
    oauthCoordinator,
    notificationRouter,
    diagnostics: pluginDiagnostics,
    // v2.2 — baseUrl provided by host at runtime (Desktop/Web-API set this;
    // CLI doesn't). Plugins read it via api.getBaseUrl() for OAuth callbacks
    // and webhook endpoints.
    baseUrl: config.baseUrl,
    pluginPages: new Map(),
    renderers: new Map(),
    // v2.2 — llmFactory is set after LLM resolution (below). Monitors only
    // start after full wiring, so lazy assignment is safe.
  };
  const pluginLoader = new PluginLoader(pluginRegistries, {
    storage: new FsStorage(),
    logger: log,
  });
  await pluginLoader.loadAll();
  // Merge skill dirs declared by plugins/tools into the live injector scanner
  // and the boot-time skill pool (for MCP passthrough + design tools).
  const pluginSkillSources = pluginLoader.getPluginSkillSources();
  if (pluginSkillSources.length > 0) {
    skillScanner.addExtraSources(pluginSkillSources);
    const pluginSkillPool = await new UniversalScanner({ sources: pluginSkillSources }).scan();
    for (const [k, v] of pluginSkillPool) skillPool.set(k, v);
  }
  // -------------------------------------------------------------------------
  // Resolve LLM and memory AFTER plugin loading so plugin-contributed
  // providers are available for config-level selection.
  // -------------------------------------------------------------------------
  const llm = await createLLMFromRegistry(llmProviders, config, log);
  // v2.2 — wire llmFactory now that the LLM provider is resolved. Monitors
  // call this lazily when they need LLM access, so it's always available by
  // the time a monitor starts.
  pluginRegistries.llmFactory = () =>
    new SimpleCompletionImpl(llm, config.model, ({ input, output }) => {
      pluginDiagnostics.pushMetric({
        pluginId: 'framework',
        name: 'monitor_llm_usage',
        value: output,
        labels: { type: 'output_tokens', input_tokens: String(input) },
        timestamp: new Date().toISOString(),
      });
    });
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
  let auxVisionProvider = null;
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
  // E3 — improvement fork. After every agent turn, analyses the
  // transcript and proposes memory updates or new skills when the
  // active personality opts in via `skill_evolution.enabled`.
  let onSkillProposedFn;
  let onSkillAppliedFn;
  const { ImprovementFork, loadEvolveConfig: loadEvolveConfigFn } = await import(
    '@ethosagent/skill-evolver'
  );
  const evolveConfigPath = join(dataDir, 'evolve-config.json');
  const wiringStorage = new FsStorage();
  const improvementFork = new ImprovementFork({
    hooks,
    runtime: {
      llm,
      model: config.model,
      memoryProvider: memory,
      sessionStore: session,
    },
    personalities,
    dataDir,
    storage: wiringStorage,
    onSkillProposed: (skillId, personalityId) => {
      onSkillProposedFn?.(skillId, personalityId);
    },
    autoApprove: () => {
      return autoApproveCache;
    },
    onSkillApplied: (skillId, personalityId) => {
      onSkillAppliedFn?.(skillId, personalityId);
    },
  });
  improvementFork.register();
  let autoApproveCache = false;
  (async () => {
    try {
      const cfg = await loadEvolveConfigFn(evolveConfigPath, wiringStorage);
      autoApproveCache = cfg.autoApprove;
    } catch {
      // Non-fatal — keep the default.
    }
  })();
  hooks.registerVoid('agent_done', async () => {
    try {
      const cfg = await loadEvolveConfigFn(evolveConfigPath, wiringStorage);
      autoApproveCache = cfg.autoApprove;
    } catch {
      // Non-fatal.
    }
  });
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
  let requestDumpStore;
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
  const memoryProviderMap = new Map();
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
  // Per-personality MCP tool policy from mcp.yaml (NOT on PersonalityConfig).
  const activeMcpPolicy = personalities.getMcpPolicy(activePerson.id);
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
    ...(activeMcpPolicy ? { mcpPolicy: activeMcpPolicy } : {}),
    onToolMetric: (metric) => {
      pluginDiagnostics.pushEvent({
        pluginId: metric.pluginId,
        level: 'info',
        message: 'tool_invocation',
        timestamp: new Date().toISOString(),
        data: {
          toolName: metric.toolName,
          ok: metric.ok,
          durationMs: metric.durationMs,
        },
        sessionId: metric.sessionId,
        turnId: metric.turnId,
      });
    },
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
  return {
    loop,
    toolRegistry: tools,
    setMessagingSend: (fn) => {
      gatewaySendFn = fn;
    },
    setOnSkillProposed: (fn) => {
      onSkillProposedFn = fn;
    },
    setOnSkillApplied: (fn) => {
      onSkillAppliedFn = fn;
    },
    notificationRouter,
    pluginLoader,
  };
}
// ---------------------------------------------------------------------------
// Messaging allowlist loader (used by createAgentLoop)
// ---------------------------------------------------------------------------
/**
 * Read `<dataDir>/messaging.json` and return a `Map<personalityId, targets[]>`.
 * Missing file or parse failure → empty map (everything stays default-deny).
 * Shape on disk:
 *   {
 *     "engineer": ["slack:C0123ABC", "telegram:-100123"],
 *     "researcher": ["*"]
 *   }
 * Each target is `<platform>:<id>` or the literal `*` wildcard. Mirrors the
 * `mcp.json` pattern — a flat JSON file, operator-edited, read at AgentLoop
 * boot, no schema bump on PersonalityConfig required.
 */
async function loadMessagingAllowlist(dataDir) {
  const storage = new FsStorage();
  const path = join(dataDir, 'messaging.json');
  const raw = await storage.read(path);
  if (!raw) return new Map();
  try {
    const data = JSON.parse(raw);
    const out = new Map();
    for (const [personalityId, value] of Object.entries(data)) {
      if (!Array.isArray(value)) continue;
      const targets = value.filter((t) => typeof t === 'string');
      out.set(personalityId, targets);
    }
    return out;
  } catch {
    return new Map();
  }
}
// ---------------------------------------------------------------------------
// Phase 3 — team memory helpers (used only by createAgentLoop)
// ---------------------------------------------------------------------------
/** Reject team names that could be used for path traversal or directory aliasing. */
function isSafeTeamName(name) {
  return /^[a-zA-Z0-9_-]+$/.test(name);
}
const TEAM_MEMORY_BOOTSTRAP_TOPICS = [
  { key: 'onboarding', placeholder: '# Onboarding\n' },
  { key: 'decisions', placeholder: '# Decisions\n' },
];
/**
 * Seed empty topic files via the team memory provider if no .md files exist
 * yet. Called once at AgentLoop wiring time (before the loop starts) so
 * agents always see at least the bootstrap topics in the lazy index.
 */
async function seedTeamMemory(teamMemory, teamName) {
  const seedCtx = {
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
function createTeamMemoryIndexInjector(teamMemory, teamName) {
  return {
    id: `team-memory-index:${teamName}`,
    priority: 70,
    async inject(ctx) {
      const memCtx = {
        scopeId: `team:${teamName}`,
        sessionId: ctx.sessionId,
        sessionKey: ctx.sessionKey,
        platform: ctx.platform,
        workingDir: ctx.workingDir ?? '',
      };
      let refs;
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
export function createSessionStore(opts) {
  return new SQLiteSessionStore(join(opts.dataDir, 'sessions.db'));
}
// The markdown backend supports MEMORY.md / USER.md direct read/write
// (GlobalMemoryStore) alongside the contract methods. The factory
// advertises both via intersection so apps that need only one half
// narrow at the use site.
export function createMemoryProvider(opts) {
  return new MarkdownFileMemoryProvider({ dir: opts.dataDir });
}
// ---------------------------------------------------------------------------
// Danger predicate (shared between CLI guard + web approval flow)
// ---------------------------------------------------------------------------
export { createDangerPredicate } from './danger-predicate';
// ---------------------------------------------------------------------------
// Ethos observability adapter
// ---------------------------------------------------------------------------
export { IdentityMap } from './identity-map';
// Re-export the resolver so callers don't need a separate import.
export { resolveModelTarget } from './model-resolver';
export {
  ETHOS_EVENT_CATEGORIES,
  ETHOS_TRACE_KINDS,
  EthosObservability,
} from './observability/ethos-observability';
