import { join } from 'node:path';
import { LastWriteWinsPolicy, LazyOnDemandPolicy } from '@ethosagent/core';
import { autonomyTier, KanbanStore } from '@ethosagent/kanban-store';
import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
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
import type { UniversalScanner } from '@ethosagent/skills';
import { compose as composeSkills } from '@ethosagent/skills/compose';
import { createCryptoStorage } from '@ethosagent/storage-crypto';
import { FsStorage } from '@ethosagent/storage-fs';
import { createBrowserTools } from '@ethosagent/tools-browser';
import { createCodeTools } from '@ethosagent/tools-code';
import { createCronTool } from '@ethosagent/tools-cron';
import { createFileTools } from '@ethosagent/tools-file';
import { createImageTools } from '@ethosagent/tools-image';
import { createInteractiveTools } from '@ethosagent/tools-interactive';
import {
  createKanbanRoleGateHook,
  createKanbanTools,
  registerPostmortemHandler,
} from '@ethosagent/tools-kanban';
import { loadMcpConfig, McpManager } from '@ethosagent/tools-mcp';
import { createTeamMemoryTools, isSafeTopicKey } from '@ethosagent/tools-memory';
import { createMessagingTools, type MessagingSendFn } from '@ethosagent/tools-messaging';
import {
  createPersonalityDesignTools,
  createTeamDesignTools,
} from '@ethosagent/tools-personality-design';
import { createProcessGuardHook, createProcessTools } from '@ethosagent/tools-process';
import { createSkillsTools } from '@ethosagent/tools-skills';
import { createTerminalGuardHook, createTerminalTools } from '@ethosagent/tools-terminal';
import { createThinkDeeperTool } from '@ethosagent/tools-tier';
import { createTodoTools, InMemoryTodoStore } from '@ethosagent/tools-todo';
import { createTtsTools } from '@ethosagent/tools-tts';
import { createWebTools } from '@ethosagent/tools-web';
import type {
  ContextInjector,
  InjectionResult,
  MemoryContext,
  MemoryEntryRef,
  MemoryProvider,
  PromptContext,
  Skill,
  Storage,
} from '@ethosagent/types';
import type { InfrastructureResult } from './build-infrastructure';
import type { CreateAgentLoopOptions, WiringConfig, WiringProfile } from './index';
import { resolveKanbanDbPath } from './kanban-path';
import { MODEL_CATALOG } from './model-catalog';
import { fetchManifest, loadModelCatalog, manifestToEntries } from './model-catalog-loader';
import { applySkillPassthrough, deriveSkillPassthrough } from './skill-passthrough';
import type { WiringContext } from './types';

// ---------------------------------------------------------------------------
// WEB_PROMPT — kept here since platformPrompts is also assembled here
// ---------------------------------------------------------------------------

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

export const platformPrompts = new Map<string, string>([
  [slackId, slackPrompt],
  [telegramId, telegramPrompt],
  [discordId, discordPrompt],
  [emailId, emailPrompt],
  ['web', WEB_PROMPT],
]);

// ---------------------------------------------------------------------------
// Messaging allowlist loader
// ---------------------------------------------------------------------------

/**
 * Read `<dataDir>/messaging.json` and return a `Map<personalityId, targets[]>`.
 * Missing file or parse failure → empty map (everything stays default-deny).
 */
export async function loadMessagingAllowlist(dataDir: string): Promise<Map<string, string[]>> {
  const storage = new FsStorage();
  const path = join(dataDir, 'messaging.json');
  const raw = await storage.read(path);
  if (!raw) return new Map();
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const out = new Map<string, string[]>();
    for (const [personalityId, value] of Object.entries(data)) {
      if (!Array.isArray(value)) continue;
      const targets = value.filter((t): t is string => typeof t === 'string');
      out.set(personalityId, targets);
    }
    return out;
  } catch {
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// Team memory helpers
// ---------------------------------------------------------------------------

/** Validates that a team name contains only safe characters. */
export function isSafeTeamName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

const TEAM_MEMORY_BOOTSTRAP_TOPICS = [
  { key: 'onboarding', placeholder: '# Onboarding\n' },
  { key: 'decisions', placeholder: '# Decisions\n' },
] as const;

/**
 * Seed empty topic files via the team memory provider if no .md files exist
 * yet. Called once at AgentLoop wiring time so agents always see at least the
 * bootstrap topics in the lazy index.
 */
export async function seedTeamMemory(teamMemory: MemoryProvider, teamName: string): Promise<void> {
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
export function createTeamMemoryIndexInjector(
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

      // Filter to safe, non-USER topic keys only.
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
// Main export types
// ---------------------------------------------------------------------------

/** Mutable ref for the gateway send function. Allows post-construction injection. */
export interface GatewaySendRef {
  fn: MessagingSendFn;
}

export interface ComposeToolsResult {
  /** Mutable ref for injecting the real gateway send function post-construction. */
  gatewaySendRef: GatewaySendRef;
  /** Skill pool built from composeSkills (needed by loadPlugins). */
  skillPool: Map<string, Skill>;
  /** Context injectors array (passed through to loadPlugins and AgentLoop). */
  injectors: ContextInjector[];
  /** Universal scanner (needed by loadPlugins for plugin skill merging). */
  skillScanner: UniversalScanner;
}

export interface ComposeToolsDeps {
  infra: InfrastructureResult;
  profile: WiringProfile;
}

/**
 * Register all tool groups into the tool registry and wire supporting hooks.
 * Covers: file, terminal, web, todo, think, interactive, kanban, process,
 * image, code, browser, messaging, cron, TTS, skills compose + introspection,
 * MCP, design storage + model catalog + personality design, guard hooks, and
 * team memory (when teamName is set).
 */
export async function composeAllTools(
  wiringCtx: WiringContext,
  config: WiringConfig,
  opts: CreateAgentLoopOptions,
  deps: ComposeToolsDeps,
): Promise<ComposeToolsResult> {
  const { dataDir, log } = wiringCtx;
  const { infra, profile } = deps;
  const { personalities, activePerson, sandbox, hooks, capabilityBackends, tools, clarifyBridge } =
    infra;

  // -------------------------------------------------------------------------
  // Group A: inline tool factories
  // -------------------------------------------------------------------------

  for (const tool of createFileTools()) tools.register(tool);
  for (const tool of createTerminalTools()) tools.register(tool);
  for (const tool of createWebTools()) tools.register(tool);

  // One InMemoryTodoStore per process — lifetime tied to the AgentLoop.
  const todoStore = new InMemoryTodoStore();
  for (const tool of createTodoTools(todoStore)) tools.register(tool);
  tools.register(createThinkDeeperTool());

  for (const tool of createInteractiveTools(clarifyBridge)) tools.register(tool);

  // Kanban tools — wired only when the active personality actually uses them.
  let kanbanStore: KanbanStore | null = null;
  if ((activePerson.toolset ?? []).some((name: string) => name.startsWith('kanban_'))) {
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

  // Messaging tools — gatewaySendRef is a mutable object so the closure always
  // calls the latest injected function.
  const gatewaySendRef: GatewaySendRef = {
    fn: async () => ({
      ok: false,
      error: 'Gateway not active — send_message requires gateway mode',
    }),
  };

  const messagingAllowlist = await loadMessagingAllowlist(dataDir);

  for (const tool of createMessagingTools({
    send: async (platform, target, body, botKey) =>
      gatewaySendRef.fn(platform, target, body, botKey),
    getAllowedTargets: (personalityId) => {
      if (!personalityId) return [];
      return messagingAllowlist.get(personalityId) ?? [];
    },
  }))
    tools.register(tool);

  // Cron tool — registered only when a CronScheduler was threaded through.
  if (opts.cronScheduler) {
    for (const tool of createCronTool(opts.cronScheduler)) tools.register(tool);
  }

  // TTS tool — registers as unavailable when provider is null (no TTS configured).
  for (const tool of createTtsTools({ provider: null })) tools.register(tool);

  // -------------------------------------------------------------------------
  // Phase B compose — skills (depends on personalities)
  // -------------------------------------------------------------------------

  const skillsCompose = await composeSkills(wiringCtx, {
    personalities,
    activePerson,
    hooks,
    platformPrompts,
    log,
  });
  const { skillPool, injectors, scanner: skillScanner } = skillsCompose;
  for (const tool of skillsCompose.tools) tools.register(tool);

  const bootToolNames = new Set(activePerson.toolset ?? []);
  const attachedServers = new Set(activePerson.mcp_servers ?? []);
  const skillPassthrough = deriveSkillPassthrough(skillPool, activePerson, bootToolNames);

  // Skill introspection tools — skills_list + skill_view.
  for (const tool of createSkillsTools({
    listSkills: () => {
      return [...skillPool.values()].map((s) => ({
        name: s.name,
        description:
          (s.rawFrontmatter.description as string) ?? s.body.split('\n')[0]?.slice(0, 120) ?? '',
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

  // -------------------------------------------------------------------------
  // MCP tools
  // -------------------------------------------------------------------------

  const rawMcpConfig = await loadMcpConfig();
  const mcpConfig = applySkillPassthrough(
    rawMcpConfig,
    skillPassthrough,
    attachedServers,
  ) as Awaited<ReturnType<typeof loadMcpConfig>>;
  const mcpManager = new McpManager(mcpConfig, {
    logger: log,
    enableScopeProbe: process.env.ETHOS_MCP_SCOPE_PROBE === '1',
    innerSecrets: config.secretsResolver,
    onToolsChanged: (added, removedNames) => {
      for (const t of added) tools.register(t);
      for (const name of removedNames) tools.unregister(name);
    },
  });
  const mcpTools = await mcpManager.getToolsForPersonality(activePerson.id);
  for (const tool of mcpTools) tools.register(tool);

  if (mcpConfig.length > 0) {
    const attached = activePerson.mcp_servers ?? [];
    if (attached.length === 0) {
      const names = mcpConfig.map((s) => s.name).join(', ');
      log.info(
        `MCP: 0 of ${mcpConfig.length} server(s) attached to "${activePerson.id}". ` +
          `Run 'ethos personality mcp ${activePerson.id} --attach <name>' to enable. ` +
          `Configured: ${names}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Design storage + model catalog + personality design tools
  // -------------------------------------------------------------------------

  let designStorage: Storage = capabilityBackends.storage ?? new FsStorage();
  if (config.storage?.encryption) {
    const passphrase = process.env.ETHOS_STORAGE_KEY ?? '';
    designStorage = createCryptoStorage(designStorage, passphrase);
  }

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

  // -------------------------------------------------------------------------
  // Guard hooks
  // -------------------------------------------------------------------------

  // CLI/TUI/ACP get the synchronous block-and-explain guard.
  if (profile !== 'web') {
    hooks.registerModifying('before_tool_call', createTerminalGuardHook());
    hooks.registerModifying('before_tool_call', createProcessGuardHook());
  }

  // Plan B — kanban role gate hook.
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

  // -------------------------------------------------------------------------
  // Team memory (when teamName is set)
  // -------------------------------------------------------------------------

  if (config.teamName) {
    if (!isSafeTeamName(config.teamName)) {
      throw new Error(
        `Invalid teamName "${config.teamName}": must match [a-zA-Z0-9_-]+ (no path separators or traversal)`,
      );
    }
    const teamMemoryDir = join(dataDir, 'teams', config.teamName, 'memory');
    const teamMemory = new LazyOnDemandPolicy(
      new LastWriteWinsPolicy(new MarkdownFileMemoryProvider({ dir: teamMemoryDir })),
    );

    await seedTeamMemory(teamMemory, config.teamName);

    for (const tool of createTeamMemoryTools(teamMemory)) tools.register(tool);

    if (config.postmortems !== false) {
      registerPostmortemHandler({ teamName: config.teamName, memory: teamMemory, hooks });
    }

    injectors.push(createTeamMemoryIndexInjector(teamMemory, config.teamName));
  }

  return {
    gatewaySendRef,
    skillPool,
    injectors,
    skillScanner,
  };
}
