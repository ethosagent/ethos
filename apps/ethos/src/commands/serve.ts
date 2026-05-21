import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve as pathResolve } from 'node:path';
import { AcpServer } from '@ethosagent/acp-server';
import { AgentMesh, meshRegistryPath } from '@ethosagent/agent-mesh';
import type { AgentLoop } from '@ethosagent/core';
import { CronScheduler } from '@ethosagent/cron';
import { ConsoleLogger } from '@ethosagent/logger';
import { createPersonalityRegistry } from '@ethosagent/personalities';
import { SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { EthosError, type ToolRegistry } from '@ethosagent/types';
import { type ChatService, createWebApi, WebTokenRepository } from '@ethosagent/web-api';
import {
  createDangerPredicate,
  createMemoryProvider,
  createSessionStore,
} from '@ethosagent/wiring';
import { type EthosConfig, ethosDir } from '../config';
import { emitReady } from '../logger';
import { notifyReady } from '../sd-notify';
import { createAgentLoop, createTeamAgentLoop } from '../wiring';
import { hasFlag, parseFlagValue, parsePort } from './serve-helpers';
import { listenWithFallback } from './serve-listen';

// `ethos serve` boots:
//   • Always: ACP server on `--port` (default 3001) + mesh registration
//   • With `--web-experimental`: web UI HTTP+SSE on `--web-port` (default 3000)
//
// Web is opt-in to keep current users' boots unchanged. Flag rename when
// 26.x leaves experimental — for now it matches plan/phases/26-web-ui.md.
//
// Both servers share one `SessionStore` so chat from web and from ACP land
// in the same database. SIGINT / SIGTERM cleans up both before exiting.

const ACP_PORT_DEFAULT = 3001;
const WEB_PORT_DEFAULT = 3000;
const WEB_PORT_FALLBACK_ATTEMPTS = 5;

export async function runServe(args: string[], config: EthosConfig): Promise<void> {
  const acpPort = parsePort(parseFlagValue(args, ['--port']), ACP_PORT_DEFAULT);
  const webEnabled = hasFlag(args, ['--web-experimental']);
  const webPort = parsePort(parseFlagValue(args, ['--web-port']), WEB_PORT_DEFAULT);
  // Default to localhost-only binding. Override with --host or ETHOS_SERVE_HOST
  // to expose on the network (e.g. --host 0.0.0.0).
  const serveHost = parseFlagValue(args, ['--host']) ?? process.env.ETHOS_SERVE_HOST ?? '127.0.0.1';

  const personalityOverride = parseFlagValue(args, ['--personality']);
  if (personalityOverride) config = { ...config, personality: personalityOverride };

  const modelOverride = parseFlagValue(args, ['--model']);
  if (modelOverride) config = { ...config, model: modelOverride };

  const teamFlag = parseFlagValue(args, ['--team']);
  const rawRole = parseFlagValue(args, ['--role']);
  if (rawRole !== undefined && rawRole !== 'coordinator' && rawRole !== 'member') {
    // Fail-closed: a typo in --role would otherwise silently disable the kanban
    // role gate. Better to crash the spawn loudly.
    console.error(`Invalid --role "${rawRole}". Must be "coordinator" or "member".`);
    process.exit(1);
  }
  const roleFlag: 'coordinator' | 'member' | undefined = rawRole as
    | 'coordinator'
    | 'member'
    | undefined;
  const meshName = parseFlagValue(args, ['--mesh']) ?? 'default';

  const dir = ethosDir();
  const loopProfile = webEnabled ? 'web' : 'cli';

  let loop: AgentLoop;
  let toolRegistry: ToolRegistry | undefined;
  let activeMeshName: string;
  let activePersonality: string;

  // Cron scheduler — hoisted ABOVE the agent-loop construction when web
  // is enabled, so the same scheduler instance can be threaded into
  // createAgentLoop (registers agent-callable cron tools against it)
  // AND drive the web Cron tab's firing engine below. The `runJob`
  // closure forward-references `loop`; the scheduler doesn't fire until
  // `.start()` later, by which point `loop` is assigned. When web mode
  // is off (`--web-experimental` not set), `cronScheduler` stays null
  // and the cron tools simply don't register on the loop.
  let cronScheduler: CronScheduler | null = null;
  // chatService is bound after createWebApi; the scheduler's `runJob`
  // closes over a holder so any cron firing before the web surface is
  // ready is a silent no-op for the SSE push.
  let chatService: ChatService | null = null;
  if (webEnabled) {
    cronScheduler = new CronScheduler({
      logger: new ConsoleLogger(),
      runJob: async (job) => {
        if (!loop) {
          throw new EthosError({
            code: 'INTERNAL',
            cause: 'Agent loop not yet initialised at cron firing time',
            action:
              'This is a wiring bug — the scheduler started before the agent loop was assigned. File an issue.',
          });
        }
        const sessionKey = `cron:${job.id}:${new Date().toISOString()}`;
        const ranAt = new Date().toISOString();
        let output = '';
        for await (const event of loop.run(job.prompt, {
          sessionKey,
          ...(job.personality ? { personalityId: job.personality } : {}),
        })) {
          if (event.type === 'text_delta') output += event.text;
        }
        if (chatService) {
          chatService.broadcastAll({
            type: 'cron.fired',
            jobId: job.id,
            ranAt,
            outputPath: null,
          });
        }
        return { jobId: job.id, ranAt, output, sessionKey };
      },
    });
  }

  if (teamFlag && personalityOverride) {
    // Plan B member spawn — supervisor spawns each member with
    //   ethos serve --personality <member> --team <name> --role <role>
    // Keep the named personality (don't force coordinator) but apply team context
    // so the kanban store routes to the team board and the role hook fires.
    activeMeshName = meshName === 'default' ? teamFlag : meshName;
    activePersonality = personalityOverride;
    const result = await createAgentLoop(
      { ...config, teamName: teamFlag, ...(roleFlag ? { role: roleFlag } : {}) },
      {
        profile: loopProfile,
        meshRegistryPath: meshRegistryPath(activeMeshName),
        ...(cronScheduler ? { cronScheduler } : {}),
      },
    );
    loop = result.loop;
    toolRegistry = result.toolRegistry;
  } else if (teamFlag) {
    // Chat UX: `ethos serve --team <name>` → run as the team's coordinator.
    const {
      loop: teamLoop,
      toolRegistry: teamToolRegistry,
      coordinatorPersonality,
      meshName: teamMesh,
    } = await createTeamAgentLoop(config, teamFlag, {
      profile: loopProfile,
      ...(roleFlag ? { role: roleFlag } : {}),
    });
    loop = teamLoop;
    toolRegistry = teamToolRegistry;
    activeMeshName = teamMesh;
    activePersonality = coordinatorPersonality;
  } else {
    activeMeshName = meshName;
    activePersonality = config.personality;
    const result = await createAgentLoop(config, {
      profile: loopProfile,
      meshRegistryPath: meshRegistryPath(activeMeshName),
      ...(cronScheduler ? { cronScheduler } : {}),
    });
    loop = result.loop;
    toolRegistry = result.toolRegistry;
  }
  const session = createSessionStore({ dataDir: dir });
  const mesh = new AgentMesh(meshRegistryPath(activeMeshName));

  // ACP server (existing behavior — kept first so any breakage is obvious).
  const acpServer = new AcpServer({ runner: loop, session, mesh });
  acpServer.startHttp(acpPort);

  const personalities = await createPersonalityRegistry({ userPersonalitiesDir: dir });
  await personalities.loadFromDirectory(join(dir, 'personalities'));
  const personalityConfig = personalities.get(activePersonality);
  const capabilities = personalityConfig?.capabilities ?? [];

  const agentId = `${activePersonality}:${process.pid}:${randomUUID().slice(0, 8)}`;
  await mesh.register({
    agentId,
    capabilities,
    model: config.model, // Phase 3: already reflects any --model override applied above
    pid: process.pid,
    host: 'localhost',
    port: acpPort,
    activeSessions: 0,
  });
  const stopHeartbeat = mesh.startHeartbeat(agentId, () => acpServer.activeSessionCount);

  const serveLabel = teamFlag ? `team:${teamFlag}` : activePersonality;
  console.log(`ethos ACP server listening on http://localhost:${acpPort}`);
  console.log(`  agent:        ${agentId}`);
  console.log(`  personality:  ${serveLabel}`);
  console.log(`  mesh:         ${activeMeshName}`);
  console.log(`  capabilities: ${capabilities.length > 0 ? capabilities.join(', ') : '(none)'}`);
  console.log(`  WebSocket:    ws://localhost:${acpPort}/ws`);

  // Web API (Phase 26). Additive — only mounts when --web-experimental is set.
  let webShutdown: (() => Promise<void>) | null = null;
  if (webEnabled) {
    const webDist = locateWebDist(parseFlagValue(args, ['--web-dist']));

    // The cronScheduler + chatService holder were hoisted above the
    // agent-loop construction so the scheduler instance threads into
    // createAgentLoop (agent-callable cron tools register against it)
    // and the runJob closure forward-references both `loop` and
    // `chatService`. Start the scheduler now — `loop` is assigned, and
    // we'll bind `chatService` to the value returned by createWebApi
    // below.
    if (cronScheduler) cronScheduler.start();

    // OpenAI-compat surface (F1+F2). Shares sessions.db so `ethos api-key`
    // and `ethos serve` see the same rows.
    const apiKeys = new SqliteApiKeyStore(join(dir, 'sessions.db'));

    const created = createWebApi({
      dataDir: dir,
      sessionStore: session,
      memoryProvider: createMemoryProvider({ dataDir: dir }),
      agentLoop: loop,
      // The same registry the agent loop loaded above is reused so mtime
      // hot-reloads of personality files reach both surfaces in one tick.
      personalities,
      chatDefaults: {
        model: config.model,
        provider: config.provider,
      },
      // Same `checkCommand` rules the CLI guard uses; surfacing them via
      // the approval modal instead of a hard block.
      dangerPredicate: createDangerPredicate(),
      ...(cronScheduler ? { cronScheduler } : {}),
      ...(toolRegistry ? { toolRegistry } : {}),
      apiKeys,
      listTeams: async () => listRegisteredTeams(dir),
      ...(webDist ? { webDist } : {}),
      ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
    });
    chatService = created.chatService;
    const webApp = created.app;
    const tokens = new WebTokenRepository({ dataDir: dir });
    const token = await tokens.getOrCreate();
    const { server, port } = await listenWithFallback(
      webApp,
      webPort,
      WEB_PORT_FALLBACK_ATTEMPTS,
      serveHost,
    );
    console.log('');
    const displayHost = serveHost === '0.0.0.0' ? 'localhost' : serveHost;
    console.log(`ethos web UI listening on http://${displayHost}:${port}`);
    if (webDist) {
      console.log(`  open: http://${displayHost}:${port}/auth/exchange?t=${token}`);
      console.log('  (token rotates on first use; cookie remains the steady-state credential)');
      console.log(`  serving SPA from: ${webDist}`);
    } else {
      console.log(`  auth token: ${token}`);
      console.log('  (token rotates on first use; cookie remains the steady-state credential)');
      console.log('  no SPA build found — run `pnpm --filter @ethosagent/web dev` for HMR,');
      console.log(`    then visit http://localhost:5173/auth/exchange?t=${token}`);
      console.log('  or `pnpm --filter @ethosagent/web build` to bundle into this server.');
    }
    webShutdown = () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
  }

  emitReady('serve');
  notifyReady();

  const cleanup = async () => {
    stopHeartbeat();
    await mesh.unregister(agentId);
    if (cronScheduler) cronScheduler.stop();
    if (webShutdown) await webShutdown();
    process.exit(0);
  };
  process.on('SIGTERM', () => void cleanup());
  process.on('SIGINT', () => void cleanup());

  await new Promise(() => {});
}

/**
 * Resolve the absolute path to the built SPA. Search order:
 *   1. `--web-dist <path>` flag (explicit, wins).
 *   2. Sibling to the bundled CLI: `<cliDist>/web/index.html` (the
 *      pre-publish hook that bundles the web app drops it here, per
 *      CEO finding 9.1).
 *   3. Monorepo dev path: `apps/web/dist/index.html` resolved up from
 *      `import.meta.dirname`.
 * Returns null when no candidate exists; the server skips the static
 * mount and prints a hint pointing devs at `pnpm dev:web`.
 */
function locateWebDist(explicit: string | undefined): string | null {
  if (explicit) {
    const abs = pathResolve(explicit);
    return existsSync(join(abs, 'index.html')) ? abs : null;
  }
  const candidates = [
    pathResolve(import.meta.dirname, '..', 'web'),
    pathResolve(import.meta.dirname, '..', '..', '..', '..', 'apps', 'web', 'dist'),
    pathResolve(import.meta.dirname, '..', '..', '..', 'apps', 'web', 'dist'),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

/**
 * Enumerate registered team names for `GET /v1/models`. Scoped to the
 * `dataDir` the server is actually using (not `~/.ethos/teams` blindly),
 * so isolated/test installations report only their own teams. Manifest
 * files live at `<dataDir>/teams/<name>.yaml`; `.runtime.yaml` is the
 * supervisor's runtime state, not a manifest.
 */
function listRegisteredTeams(dataDir: string): string[] {
  const teamsPath = join(dataDir, 'teams');
  if (!existsSync(teamsPath)) return [];
  return readdirSync(teamsPath, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.yaml') && !e.name.endsWith('.runtime.yaml'))
    .map((e) => e.name.slice(0, -'.yaml'.length))
    .sort();
}
