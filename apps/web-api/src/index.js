import { join } from 'node:path';
import { SessionStreamBuffer } from '@ethosagent/agent-bridge';
import { AgentMesh } from '@ethosagent/agent-mesh';
import { SkillsLibrary } from '@ethosagent/skills';
import { FileSecretsResolver, FsStorage } from '@ethosagent/storage-fs';
import { McpJsonStore } from '@ethosagent/tools-mcp';
import { ChatRepository } from './features/chat/repository';
import { ChatService } from './features/chat/service';
import { CompletionsRepository } from './features/completions/repository';
import { CompletionsService } from './features/completions/service';
import { SessionsRepository } from './features/sessions/repository';
import { SessionsService } from './features/sessions/service';
import { AllowlistRepository } from './repositories/allowlist.repository';
import { ConfigRepository } from './repositories/config.repository';
import { EvolverRepository } from './repositories/evolver.repository';
import { PlatformsRepository } from './repositories/platforms.repository';
import { WebTokenRepository } from './repositories/web-token.repository';
import { createRoutes } from './routes';
import { ApiKeysService } from './services/api-keys.service';
import { createWebApprovalHook } from './services/approval-hook';
import { ApprovalsService } from './services/approvals.service';
import { ConfigService } from './services/config.service';
import { CronService } from './services/cron.service';
import { EvolverService } from './services/evolver.service';
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

// Public entry for `@ethosagent/web-api`. Boot code (`apps/ethos/src/commands/
// serve.ts`) builds the dependencies it has lying around — a `SessionStore`,
// the agent loop, the personality registry, the data dir — and hands them to
// `createWebApi`. The package wires the layered service container internally
// and returns a Hono app the boot script can `serve()`.

export function createWebApi(opts) {
  // --- Repositories (data access only) ---
  const tokens = new WebTokenRepository({ dataDir: opts.dataDir });
  const sessionsRepo = new SessionsRepository(opts.sessionStore);
  const chatRepo = new ChatRepository(opts.sessionStore);
  const completionsRepo = new CompletionsRepository(opts.sessionStore);
  const configRepo = new ConfigRepository({ dataDir: opts.dataDir });
  const allowlistRepo = new AllowlistRepository({ dataDir: opts.dataDir });
  const skillsLibrary = new SkillsLibrary({
    dataDir: opts.dataDir,
    ...(opts.catalogDir ? { catalogDir: opts.catalogDir } : {}),
  });
  const evolverRepo = new EvolverRepository({ dataDir: opts.dataDir });
  // The mesh registry lives at `<dataDir>/mesh-registry.json`. ACP servers
  // (potentially in other processes) write heartbeats to this file; we
  // just read it via @ethosagent/agent-mesh directly — the wire-format
  // mapping lives in the service.
  const mesh = new AgentMesh(join(opts.dataDir, 'mesh-registry.json'));
  const memoryProvider = opts.memoryProvider;
  const storage = opts.storage ?? new FsStorage();
  const secrets =
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
  const personalitiesService = new PersonalitiesService({
    personalities: opts.personalities,
    library: skillsLibrary,
  });
  const configService = new ConfigService({ config: configRepo });
  const onboardingService = new OnboardingService({
    config: configRepo,
    personalities: opts.personalities,
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
  const meshService = new MeshService({ mesh });
  const memoryService = new MemoryService({
    memory: memoryProvider,
    identityMap: opts.identityMap,
  });
  const kanbanService = new KanbanService();
  const apiKeysService = new ApiKeysService(opts.apiKeys ?? null);
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
    mcpJsonStore: new McpJsonStore(storage),
    redirectUri: opts.webBaseUrl
      ? `${opts.webBaseUrl}/oauth/callback`
      : 'http://localhost:3000/oauth/callback',
  });
  const platformsService = new PlatformsService({ repo: platformsRepo });
  const labService = new LabService({ dataDir: opts.dataDir, loop: opts.agentLoop });
  // F3+F4 — drives `POST /v1/chat/completions`. Shares the AgentLoop with
  // the web chat surface so personality reloads + tool wiring reach both.
  const completionsService = new CompletionsService({
    loop: opts.agentLoop,
    sessions: completionsRepo,
    defaults: opts.chatDefaults,
  });

  // One buffer per process — keyed internally by sessionId. Bridges are
  // owned by ChatService. The reap callback lets the bridge map drain
  // alongside the SSE buffer so a long-running server doesn't accumulate
  // an AgentBridge per session forever (memory leak otherwise).
  const buffer = new SessionStreamBuffer();
  const chatService = new ChatService({
    loop: opts.agentLoop,
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
  const clarifyBridge = opts.agentLoop.clarifyBridge;
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
    opts.agentLoop.hooks.registerModifying(
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
      mesh: meshService,
      memory: memoryService,
      plugins: pluginsService,
      mcp: mcpService,
      platforms: platformsService,
      lab: labService,
      kanban: kanbanService,
      completions: completionsService,
      apiKeys: apiKeysService,
      toolRegistry: opts.toolRegistry,
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

  return { app, chatService, systemBus };
}

/**
 * Stand-in for the CronScheduler when no real one is wired (e.g. tests,
 * ACP-only deployments). File-backed reads still work via the
 * scheduler's own `listJobs`/`getJob`; writes/runs throw a clear error
 * so the surface can render an actionable message.
 */
function createPassiveScheduler() {
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
  };
}

/**
 * Stand-in for the McpManager when no real one is wired (e.g. tests,
 * deployments where MCP isn't configured). addServer and removeServer
 * throw a clear error; listServers returns empty.
 */
function createPassiveMcpManager() {
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
    addServer: async () => notConfigured(),
    removeServer: async () => notConfigured(),
  };
}

export { ChatService } from './features/chat/service';
// Re-exports so boot code can read tokens / inspect contract surfaces directly.
export { WebTokenRepository } from './repositories/web-token.repository';
export { setWhatsAppPairingCode, setWhatsAppQr } from './routes/setup-whatsapp';
