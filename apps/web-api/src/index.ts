import { join } from 'node:path';
import { SessionStreamBuffer } from '@ethosagent/agent-bridge';
import { AgentMesh } from '@ethosagent/agent-mesh';
import type { AgentLoop } from '@ethosagent/core';
import type { CronScheduler } from '@ethosagent/cron';
import type { GoalRunner } from '@ethosagent/goal-runner';
import type { FilePersonalityRegistry } from '@ethosagent/personalities';
import { SkillsLibrary } from '@ethosagent/skills';
import { FileSecretsResolver, FsStorage } from '@ethosagent/storage-fs';
import { McpJsonStore, type McpManager } from '@ethosagent/tools-mcp';
import { buildDashboardTools } from '@ethosagent/tools-ui';
import type { MemoryProvider, SecretsResolver, SessionStore, Storage } from '@ethosagent/types';
import type { SseEvent } from '@ethosagent/web-contracts';
import type { IdentityMap } from '@ethosagent/wiring';
import type { Hono } from 'hono';
import { ChatRepository } from './features/chat/repository';
import { type ChatDefaults, ChatService } from './features/chat/service';
import { CompletionsRepository } from './features/completions/repository';
import { CompletionsService } from './features/completions/service';
import { DebugService } from './features/debug/service';
import { SessionsRepository } from './features/sessions/repository';
import { SessionsService } from './features/sessions/service';
import type { ApiKeyAdminStore } from './middleware/bearer-auth';
import { AllowlistRepository } from './repositories/allowlist.repository';
import { ConfigRepository } from './repositories/config.repository';
import { EvolverRepository } from './repositories/evolver.repository';
import { PlatformsRepository } from './repositories/platforms.repository';
import { WebTokenRepository } from './repositories/web-token.repository';
import { createRoutes } from './routes';
import { ApiKeysService } from './services/api-keys.service';
import { createWebApprovalHook, type DangerPredicate } from './services/approval-hook';
import { ApprovalsService } from './services/approvals.service';
import { ConfigService } from './services/config.service';
import { CronService } from './services/cron.service';
import { refreshSinglePanel } from './services/dashboard-refresh';
import { DashboardsService } from './services/dashboards.service';
import { DigestService } from './services/digest.service';
import { EvolverService } from './services/evolver.service';
import { GoalsService } from './services/goals.service';
import { KanbanService } from './services/kanban.service';
import { LabService } from './services/lab.service';
import { McpService } from './services/mcp.service';
import { MemoryService } from './services/memory.service';
import { MeshService } from './services/mesh.service';
import { OnboardingService } from './services/onboarding.service';
import { PersonalitiesService } from './services/personalities.service';
import { PlatformsService } from './services/platforms.service';
import { PluginsService } from './services/plugins.service';
import { SkillsService } from './services/skills.service';
import { SystemEventBus } from './services/system-event-bus';
import { DashboardStore } from './stores/dashboard-store';

// Public entry for `@ethosagent/web-api`. Boot code (`apps/ethos/src/commands/
// serve.ts`) builds the dependencies it has lying around — a `SessionStore`,
// the agent loop, the personality registry, the data dir — and hands them to
// `createWebApi`. The package wires the layered service container internally
// and returns a Hono app the boot script can `serve()`.

export interface CreateWebApiOptions {
  /** Where `~/.ethos/web-token` lives (and, transitively, all other state). */
  dataDir: string;
  /** SQLite-backed session store, already initialised. Shared with ACP /
   *  gateway so the same DB rows back every surface. */
  sessionStore: SessionStore;
  /** Lazy LLM factory for governed-learning drafts (Living Soul Expression
   *  evolution, Soul split). Omitted in onboarding mode — those RPCs then
   *  return NOT_CONFIGURED. */
  personalitiesLlm?: () => Promise<import('@ethosagent/types').LLMProvider>;
  /** Memory provider for scoped read/write. Construct via
   *  `createMemoryProvider` from `@ethosagent/wiring`. */
  memoryProvider: MemoryProvider;
  /** Identity map for resolving platform users to opaque userIds.
   *  Optional — when omitted, `memory.listUsers` returns empty. */
  identityMap?: IdentityMap;
  /** Agent loop the chat surface drives. Must already be wired with tools,
   *  hooks, providers etc. (typically via `@ethosagent/wiring`). When omitted
   *  (onboarding mode), a stub loop that yields a SETUP_REQUIRED error is used. */
  agentLoop?: AgentLoop;
  /** Loop-bearing goal runner from `createAgentLoop`. When provided, web-created
   *  goals execute on the same runner+store as the CLI/gateway path. */
  goalRunner?: GoalRunner;
  /** Personality registry — shared with the loop so hot-reloads (mtime cache)
   *  reach both surfaces. Must be a `FilePersonalityRegistry` so the web-api's
   *  Personalities tab can drive its CRUD methods (create / update / delete /
   *  duplicate). Construct via `createPersonalityRegistry({ userPersonalitiesDir })`
   *  to enable the writable user directory. */
  personalities: FilePersonalityRegistry;
  /** Provider/model defaults stamped on web-created session rows. */
  chatDefaults: ChatDefaults;
  /** Origins to accept for cross-origin (CSRF) state-changing requests.
   *  Empty / unset = localhost only. */
  allowedOrigins?: string[];
  /** Set `secure` on the auth cookie. Off by default; flip on for non-loopback bind. */
  secureCookie?: boolean;
  /**
   * Decides which tool calls require an explicit user approval. When
   * unset, no approvals are demanded — every tool call passes through
   * (recommended only for tests). Boot code typically passes
   * `createDangerPredicate()` from `@ethosagent/wiring`.
   */
  dangerPredicate?: DangerPredicate;
  /**
   * Absolute path to the built `apps/web/dist` SPA. When set, the same
   * Hono app serves the client at `/*`. Omit in dev — Vite handles
   * static + HMR at :5173 and proxies API calls back here.
   */
  webDist?: string;
  /**
   * CronScheduler instance for the cron tab. Boot code constructs and
   * `start()`s it; the web-api just calls list/create/run/etc. on the
   * shared instance. Omit when cron isn't part of this deployment —
   * `cron.list` returns an empty array gracefully.
   */
  cronScheduler?: CronScheduler;
  /**
   * Storage backend used by services that read ~/.ethos/ directly
   * (currently the MCP-config side of plugins.list). Defaults to FsStorage.
   */
  storage?: Storage;
  /**
   * Secret-backed file resolver under `<dataDir>/secrets/`. Used by the
   * Communications tab to write Telegram / Slack / Discord / email
   * tokens through `${secrets:<ref>}` indirection — so secrets land in
   * `~/.ethos/secrets/` (the canonical location the CLI's setup wizard
   * also uses), not as plaintext inside `~/.ethos/config.yaml`.
   * Defaults to a FileSecretsResolver rooted at `<dataDir>/secrets`.
   */
  secrets?: SecretsResolver;
  /**
   * Bearer-token store backing the OpenAI-compat `/v1/*` surface and the
   * `/rpc/*` dual-auth path (cookie OR bearer). When omitted, `/v1/*` is
   * not mounted and `/rpc/*` uses cookie-only auth. Boot code typically
   * constructs `SqliteApiKeyStore` (from `@ethosagent/session-sqlite`)
   * against the same `sessions.db` file the session store uses.
   */
  apiKeys?: ApiKeyAdminStore;
  /**
   * Returns currently registered team names for `GET /v1/models`. Boot
   * code typically scans `<dataDir>/teams/*.yaml`. When omitted, the
   * models list reports only personalities + `ethos-default`.
   */
  listTeams?: () => Promise<string[]>;
  /** Optional title generation function. When provided, ChatService auto-titles new sessions after the first turn. */
  titleFn?: (systemPrompt: string, userMessage: string) => Promise<string>;
  /** Tool registry for the tools.catalog RPC. */
  toolRegistry?: import('@ethosagent/types').ToolRegistry;
  /** Plugin loader for resolving plugin data-source paths (dashboard SQL queries). */
  pluginLoader?: import('@ethosagent/plugin-loader').PluginLoader;
  /** Path to the bundled system skills catalog directory. When set,
   *  SkillsLibrary surfaces read-only system skills alongside user
   *  skills. Omit when system skills are not available (e.g. tests). */
  catalogDir?: string;
  /**
   * McpManager instance for the MCP install flow. Boot code constructs
   * and `connect()`s it; the web-api delegates to `McpService` which
   * wraps `McpInstallFlow`. Omit when MCP is not part of this deployment
   * — `mcp.start` returns `discovery_failed` gracefully.
   */
  mcpManager?: McpManager;
  /**
   * Base URL of the web UI (e.g. `http://localhost:3000`). Used to build
   * the OAuth redirect URI for the MCP install flow. Defaults to
   * `http://localhost:3000` when omitted.
   */
  webBaseUrl?: string;
  /**
   * Setter from `CreateAgentLoopResult.setOnSkillProposed`. When provided,
   * `createWebApi` registers a callback that broadcasts an
   * `evolve.skill_pending` SSE event to all connected sessions whenever
   * the improvement fork proposes a new skill candidate.
   */
  setOnSkillProposed?: (fn: (skillId: string, personalityId: string) => void) => void;
  /**
   * Setter from `CreateAgentLoopResult.setOnSkillApplied`. When provided,
   * `createWebApi` registers a callback that broadcasts an
   * `evolve.skill_applied` SSE event to all connected sessions whenever
   * the improvement fork auto-promotes a skill to the live library.
   */
  setOnSkillApplied?: (fn: (skillId: string, personalityId: string) => void) => void;
  /** Notification router for delivering process completion alerts to web sessions via SSE. */
  notificationRouter?: import('@ethosagent/types').NotificationRouter;
  /**
   * Fired after the onboarding wizard durably writes config.yaml. Boot code
   * (onboarding-mode `ethos serve`) uses this to eagerly boot the real agent
   * loop so the tool catalog and plugins are live before the first chat.
   * Fire-and-forget — errors never fail the onboarding RPC.
   */
  onSetupComplete?: () => void;
}

export interface CreateWebApiResult {
  /** Hono app the boot script `serve()`s. */
  app: Hono;
  /**
   * The chat service the API constructed internally. Surface code that
   * needs to push out-of-band SSE events (e.g. the cron worker
   * broadcasting `cron.fired`) reaches in via `chatService.broadcastAll`.
   * Mutating session state here would skip the layered architecture —
   * keep the use to push-event fan-out only.
   */
  chatService: ChatService;
  /** System-level event bus for broadcasting real-time events (cron
   *  completions, platform status, session titles, health) to the
   *  desktop app via `GET /sse/system`. */
  systemBus: SystemEventBus;
}

export function createWebApi(opts: CreateWebApiOptions): CreateWebApiResult {
  const agentLoop: AgentLoop =
    opts.agentLoop ??
    ({
      run: async function* () {
        yield {
          type: 'error' as const,
          error: 'Setup required — complete onboarding first.',
          code: 'SETUP_REQUIRED',
        };
      },
    } as unknown as AgentLoop);

  // --- Repositories (data access only) ---
  const tokens = new WebTokenRepository({ dataDir: opts.dataDir });
  const sessionsRepo = new SessionsRepository(opts.sessionStore);
  const chatRepo = new ChatRepository(opts.sessionStore);
  const completionsRepo = new CompletionsRepository(opts.sessionStore);
  const configRepo = new ConfigRepository({ dataDir: opts.dataDir });
  const allowlistRepo = new AllowlistRepository({ dataDir: opts.dataDir });
  // Gap 11 — lazy getter so skills' `requires.tools` gates see the live
  // registry (including MCP/plugin tools registered after boot). Omitted
  // when no registry is wired: the tools gate is skipped, not failed.
  const skillsToolRegistry = opts.toolRegistry;
  const skillsLibrary = new SkillsLibrary({
    dataDir: opts.dataDir,
    ...(opts.catalogDir ? { catalogDir: opts.catalogDir } : {}),
    ...(skillsToolRegistry
      ? { availableTools: () => new Set(skillsToolRegistry.getAvailable().map((t) => t.name)) }
      : {}),
  });
  const evolverRepo = new EvolverRepository({ dataDir: opts.dataDir });
  // The mesh registry lives at `<dataDir>/mesh-registry.json`. ACP servers
  // (potentially in other processes) write heartbeats to this file; we
  // just read it via @ethosagent/agent-mesh directly — the wire-format
  // mapping lives in the service.
  const mesh = new AgentMesh(join(opts.dataDir, 'mesh-registry.json'));
  const memoryProvider = opts.memoryProvider;
  const storage: Storage = opts.storage ?? new FsStorage();
  const secrets: SecretsResolver =
    opts.secrets ?? new FileSecretsResolver({ dir: join(opts.dataDir, 'secrets'), storage });
  const platformsRepo = new PlatformsRepository({
    config: configRepo,
    secrets,
    dataDir: opts.dataDir,
    storage,
  });

  const systemBus = new SystemEventBus();

  // --- Services (business logic) ---
  const sessionsService = new SessionsService({ sessions: sessionsRepo });
  const sharedMcpJsonStore = new McpJsonStore(storage);
  const personalitiesService = new PersonalitiesService({
    personalities: opts.personalities,
    library: skillsLibrary,
    secrets,
    mcpJsonStore: sharedMcpJsonStore,
    ...(opts.personalitiesLlm ? { llm: opts.personalitiesLlm } : {}),
    sessions: opts.sessionStore,
    storage,
    dataDir: opts.dataDir,
  });
  const configService = new ConfigService({ config: configRepo, secrets });
  const onboardingService = new OnboardingService({
    config: configRepo,
    personalities: opts.personalities,
    ...(opts.onSetupComplete ? { onSetupComplete: opts.onSetupComplete } : {}),
  });
  const approvalsService = new ApprovalsService({ allowlist: allowlistRepo });
  // Cron service degrades gracefully when no scheduler is provided —
  // tests and ACP-only deployments don't need it. Mutations throw a
  // clear error in that mode; reads return empty.
  const cronService = new CronService({
    scheduler: opts.cronScheduler ?? createPassiveScheduler(),
  });
  const skillsService = new SkillsService({ library: skillsLibrary });
  const evolverService = new EvolverService({ evolver: evolverRepo, library: skillsLibrary });
  const goalsService = new GoalsService({
    dataDir: opts.dataDir,
    sessionStore: opts.sessionStore,
    ...(opts.goalRunner ? { runner: opts.goalRunner } : {}),
  });
  const meshService = new MeshService({ mesh });
  const memoryService = new MemoryService({
    memory: memoryProvider,
    identityMap: opts.identityMap,
  });
  const kanbanService = new KanbanService();
  const apiKeysService = new ApiKeysService(opts.apiKeys ?? null);
  const digestService = new DigestService({ storage, dataDir: opts.dataDir });
  const debugService = new DebugService({ sessionStore: opts.sessionStore, agentLoop });
  // Project-level plugins (`<cwd>/.ethos/plugins/`) are out of scope
  // for v1; user-level only is the standard install path. Threading
  // `workingDir` from boot would be the next step when we add it.
  const pluginsService = new PluginsService({ storage, dataDir: opts.dataDir });
  // MCP install flow — the service wraps McpInstallFlow (OAuth DCR dance)
  // and delegates personality attachment back through PersonalitiesService.
  // When mcpManager is omitted, a passive stub rejects mutations cleanly.
  const mcpService = new McpService({
    mcpManager: opts.mcpManager ?? createPassiveMcpManager(),
    personalityUpdater: {
      get: (id) => {
        const d = opts.personalities.describe(id);
        if (!d) return undefined;
        return { id: d.config.id, mcp_servers: d.config.mcp_servers };
      },
      update: (id, patch) => personalitiesService.update(id, patch),
    },
    secrets,
    mcpJsonStore: sharedMcpJsonStore,
    redirectUri: opts.webBaseUrl
      ? `${opts.webBaseUrl}/oauth/callback`
      : 'http://localhost:3000/oauth/callback',
  });
  const platformsService = new PlatformsService({ repo: platformsRepo });
  const labService = new LabService({ dataDir: opts.dataDir, loop: agentLoop });
  // F3+F4 — drives `POST /v1/chat/completions`. Shares the AgentLoop with
  // the web chat surface so personality reloads + tool wiring reach both.
  const completionsService = new CompletionsService({
    loop: agentLoop,
    sessions: completionsRepo,
    defaults: opts.chatDefaults,
  });

  const dashboardsService = new DashboardsService({
    dbPath: join(opts.dataDir, 'dashboards.db'),
    pluginLoader: opts.pluginLoader,
  });

  // Share the DashboardsService's DB handle with DashboardStore so
  // agent-driven dashboard_create / dashboard_add_panel tools operate on
  // the same connection — no duplicate WAL handle.
  const dashboardStore = new DashboardStore(dashboardsService.getDb());

  // Register agent-driven dashboard tools when a tool registry is available.
  if (opts.toolRegistry) {
    for (const tool of buildDashboardTools(dashboardStore)) {
      opts.toolRegistry.register(tool);
    }
  }

  // One buffer per process — keyed internally by sessionId. Bridges are
  // owned by ChatService. The reap callback lets the bridge map drain
  // alongside the SSE buffer so a long-running server doesn't accumulate
  // an AgentBridge per session forever (memory leak otherwise).
  const buffer = new SessionStreamBuffer<SseEvent>();
  const chatService = new ChatService({
    loop: agentLoop,
    sessions: chatRepo,
    buffer,
    defaults: opts.chatDefaults,
    onForget: (sessionId) => approvalsService.cancelForSession(sessionId),
    ...(opts.titleFn ? { titleFn: opts.titleFn } : {}),
    systemBus,
  });
  buffer.onReap = (sessionId) => {
    chatService.forget(sessionId);
  };

  // Register web notification adapter — delivers process/plugin notifications
  // (router keyed by sessionKey) to the session's SSE stream as a
  // `notification` event. The `session_start` hook is the one place both
  // `sessionId` (what the SSE buffer is keyed by) and `sessionKey` (what the
  // router routes by) are known. Deregistration piggybacks on the buffer's
  // onReap (which already drives chatService.forget).
  if (opts.notificationRouter && opts.agentLoop) {
    const router = opts.notificationRouter;
    const sessionKeysById = new Map<string, string>();
    agentLoop.hooks.registerVoid('session_start', async (payload) => {
      sessionKeysById.set(payload.sessionId, payload.sessionKey);
      router.register(payload.sessionKey, {
        send: async (message: string) => {
          chatService.broadcast(payload.sessionId, { type: 'notification', message });
        },
        injectUserMessage: async (message: string) => {
          // Input injection isn't supported on the web surface — surface the
          // message as a notification instead of dropping it.
          chatService.broadcast(payload.sessionId, { type: 'notification', message });
        },
      });
    });
    const originalOnReap = buffer.onReap;
    buffer.onReap = (sessionId: string) => {
      const sessionKey = sessionKeysById.get(sessionId);
      if (sessionKey !== undefined) {
        router.deregister(sessionKey);
        sessionKeysById.delete(sessionId);
      }
      originalOnReap?.(sessionId);
    };
  }

  // Bridge approvals → SSE. The hook fires when the agent reaches a
  // dangerous tool call; the resolved event lets every tab on the same
  // session auto-dismiss the modal once any one of them decides.
  approvalsService.onPending((sessionId, request) => {
    chatService.broadcast(sessionId, { type: 'tool.approval_required', request });
  });
  approvalsService.onResolved((sessionId, approvalId, decision, decidedBy) => {
    chatService.broadcast(sessionId, {
      type: 'approval.resolved',
      approvalId,
      decision,
      decidedBy,
    });
  });

  // Bridge clarify → SSE. The `clarify` tool registers a pending request on
  // the loop's ClarifyBridge; present it to the browser over the same SSE
  // channel approvals use, and broadcast the resolution so the card collapses
  // on every tab. A boot sweep clears rows that expired while the process
  // was down.
  const clarifyBridge = agentLoop.clarifyBridge;
  if (clarifyBridge) {
    clarifyBridge.setPresenter((req) => {
      chatService.broadcast(req.sessionId, {
        type: 'clarify.request',
        requestId: req.requestId,
        question: req.question,
        ...(req.options ? { options: req.options } : {}),
        ...(req.default !== undefined ? { default: req.default } : {}),
        defaultDeadlineAt: req.defaultDeadlineAt,
      });
    });
    clarifyBridge.onResolved((row, response) => {
      chatService.broadcast(row.sessionId, {
        type: 'clarify.resolved',
        requestId: row.requestId,
        source: response?.source ?? 'timeout-no-default',
      });
    });
    void clarifyBridge.sweep();
  }

  // E3 — improvement fork SSE. When the wiring layer's setOnSkillProposed
  // setter is threaded through, register a callback that broadcasts an
  // `evolve.skill_pending` push event to every connected session. The web
  // UI picks this up to surface the review-queue badge.
  opts.setOnSkillProposed?.((skillId, personalityId) => {
    chatService.broadcastAll({
      type: 'evolve.skill_pending',
      skillId,
      personalityId,
      proposedAt: new Date().toISOString(),
    });
  });

  opts.setOnSkillApplied?.((skillId, personalityId) => {
    chatService.broadcastAll({
      type: 'evolve.skill_applied',
      skillId,
      personalityId,
      appliedAt: new Date().toISOString(),
    });
  });

  // Register the web `before_tool_call` hook on the loop. CLI/TUI/ACP
  // profiles get the synchronous terminal guard from `@ethosagent/wiring`;
  // the web profile skips that registration so this hook is the sole
  // gatekeeper for dangerous calls. Without a predicate (e.g. tests) every
  // tool call passes through unattended.
  if (opts.dangerPredicate) {
    agentLoop.hooks.registerModifying(
      'before_tool_call',
      createWebApprovalHook({
        approvals: approvalsService,
        isDangerous: opts.dangerPredicate,
      }),
    );
  }

  const app = createRoutes({
    tokens,
    services: {
      sessions: sessionsService,
      chat: chatService,
      personalities: personalitiesService,
      config: configService,
      onboarding: onboardingService,
      approvals: approvalsService,
      ...(clarifyBridge ? { clarifyBridge } : {}),
      cron: cronService,
      skills: skillsService,
      evolver: evolverService,
      goals: goalsService,
      mesh: meshService,
      memory: memoryService,
      plugins: pluginsService,
      mcp: mcpService,
      platforms: platformsService,
      lab: labService,
      kanban: kanbanService,
      completions: completionsService,
      debug: debugService,
      apiKeys: apiKeysService,
      digest: digestService,
      toolRegistry: opts.toolRegistry,
      dashboards: dashboardsService,
      pluginLoader: opts.pluginLoader,
      agentLoop,
      systemBus,
    },
    ...(opts.allowedOrigins ? { allowedOrigins: opts.allowedOrigins } : {}),
    ...(opts.secureCookie !== undefined ? { secureCookie: opts.secureCookie } : {}),
    ...(opts.webDist ? { webDist: opts.webDist } : {}),
    ...(opts.apiKeys ? { apiKeys: opts.apiKeys } : {}),
    ...(opts.listTeams ? { listTeams: opts.listTeams } : {}),
    ...(opts.webBaseUrl ? { webBaseUrl: opts.webBaseUrl } : {}),
    storage,
  });

  // Dashboard panel cron poller — checks every 60s for panels with due cron schedules
  if (opts.agentLoop) {
    const POLL_INTERVAL_MS = 60_000;
    const dashboardCronLastRun = new Map<string, number>();
    const dashboardCronInterval = setInterval(async () => {
      try {
        const allDashboards = dashboardsService.list('default-user');
        for (const dash of allDashboards) {
          const panels = dashboardsService.listLivePanels(dash.id);
          const refreshDeps = {
            dashboards: dashboardsService,
            pluginLoader: opts.pluginLoader,
            agentLoop: opts.agentLoop,
          };

          // Dashboard-level cron: refresh ALL panels when due
          if (
            dash.cronSchedule &&
            isCronDue(dash.cronSchedule, dashboardCronLastRun.get(dash.id) ?? null)
          ) {
            dashboardCronLastRun.set(dash.id, Date.now());
            for (const panel of panels) {
              await refreshSinglePanel(panel, refreshDeps);
            }
            continue; // skip per-panel cron this tick
          }

          // Per-panel cron
          for (const panel of panels) {
            if (!panel.cronSchedule) continue;
            if (!isCronDue(panel.cronSchedule, panel.lastRunAt)) continue;
            await refreshSinglePanel(panel, refreshDeps);
          }
        }
      } catch {
        // Silent failure — cron polling is best-effort
      }
    }, POLL_INTERVAL_MS);

    // Unref so it doesn't keep the process alive
    dashboardCronInterval.unref();
  }

  return { app, chatService, systemBus };
}

/**
 * Stand-in for the CronScheduler when no real one is wired (e.g. tests,
 * ACP-only deployments). File-backed reads still work via the
 * scheduler's own `listJobs`/`getJob`; writes/runs throw a clear error
 * so the surface can render an actionable message.
 */
function createPassiveScheduler(): CronScheduler {
  const notConfigured = () => {
    throw new Error('Cron scheduler not configured for this server.');
  };
  return {
    listJobs: async () => [],
    getJob: async () => null,
    createJob: async () => notConfigured(),
    deleteJob: async () => notConfigured(),
    pauseJob: async () => notConfigured(),
    resumeJob: async () => notConfigured(),
    runJobNow: async () => notConfigured(),
    listRuns: async () => [],
    readRunOutput: async () => notConfigured(),
    start: () => {},
    stop: () => {},
  } as unknown as CronScheduler;
}

/**
 * Stand-in for the McpManager when no real one is wired (e.g. tests,
 * deployments where MCP isn't configured). addServer and removeServer
 * throw a clear error; listServers returns empty.
 */
function createPassiveMcpManager(): McpManager {
  const notConfigured = () => {
    throw new Error('McpManager not configured for this server.');
  };
  return {
    connect: async () => {},
    disconnect: async () => {},
    shutdown: async () => {},
    getTools: () => [],
    getToolsForPersonality: async () => [],
    listServers: () => [],
    addServer: async () => {},
    removeServer: async () => notConfigured(),
    invalidatePersonalityClients: () => {},
    reconnectPersonality: async () => {},
  } as unknown as McpManager;
}

/**
 * Lightweight cron-due check for dashboard panel schedules. Supports the
 * subset of 5-field cron expressions used by dashboards: minute, hour,
 * and day-of-week. Day-of-month and month fields must be `*` — expressions
 * that specify them are rejected (returns false) rather than silently
 * ignoring them. Returns true when the panel has never run or the scheduled
 * time has passed since the last run.
 */
function isCronDue(cronExpr: string, lastRunAt: number | null): boolean {
  const now = Date.now();
  if (!lastRunAt) return true; // Never run — due immediately
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [, , domStr, monthStr] = parts;
  if (domStr !== '*' || monthStr !== '*') return false;
  const d = new Date(now);
  const [minStr, hourStr, , , dowStr] = parts;
  const minute = minStr === '*' ? d.getMinutes() : Number(minStr);
  const hour = hourStr === '*' ? d.getHours() : Number(hourStr);
  // Check if we're past the scheduled time today
  const scheduledToday = new Date(d);
  scheduledToday.setHours(hour, minute, 0, 0);
  // Must be past scheduled time AND not already run since then
  if (now < scheduledToday.getTime()) return false;
  if (lastRunAt > scheduledToday.getTime()) return false;
  // Day-of-week check (cron uses 0=Sun..6=Sat)
  if (dowStr !== '*') {
    const dowRange = dowStr.includes('-') ? dowStr.split('-').map(Number) : [Number(dowStr)];
    if (dowRange.length === 2) {
      const [start, end] = dowRange;
      if (d.getDay() < (start ?? 0) || d.getDay() > (end ?? 6)) return false;
    } else if (d.getDay() !== dowRange[0]) return false;
  }
  return true;
}

export { type ChatDefaults, ChatService } from './features/chat/service';
// Re-exports so boot code can read tokens / inspect contract surfaces directly.
export { WebTokenRepository } from './repositories/web-token.repository';
export { setWhatsAppPairingCode, setWhatsAppQr } from './routes/setup-whatsapp';
export type { DangerPredicate, DangerReason } from './services/approval-hook';
