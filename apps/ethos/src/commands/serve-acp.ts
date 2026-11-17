// Serve-role construction seams, ACP half: builds the `AcpServer` for `ethos
// serve`. Construction only, no module state; `startHttp()` stays at the call
// site in `runServe`. `serve.ts` re-exports both names, so its export surface is
// unchanged (apps/ethos/src/__tests__/serve-export-surface.test.ts).

import { AcpServer } from '@ethosagent/acp-server';
import type { SQLiteNotifyQueue } from '@ethosagent/notify-queue';
import type { McpManager } from '@ethosagent/tools-mcp';
import { createAcpMcpWiring } from '../lib/acp-mcp-wiring';
import type { ServePersonalityRegistry } from './serve-loop';

type AcpServerOptions = ConstructorParameters<typeof AcpServer>[0];

export interface BuildServeAcpServerOptions {
  loop: AcpServerOptions['runner'];
  session: AcpServerOptions['session'];
  mesh: AcpServerOptions['mesh'];
  personalities: ServePersonalityRegistry;
  activePersonality: string;
  /** `--team <name>`; absent on a solo serve. */
  teamFlag: string | undefined;
  /** Team boards only — the passive `notify`-mode delivery queue. Opened by
   *  the CALLER so it also closes it (F06); absent on a solo serve. */
  notifyQueue?: SQLiteNotifyQueue;
  mcpManager: McpManager | undefined;
  jobStore: AcpServerOptions['jobStore'];
  backgroundExecutor: AcpServerOptions['backgroundExecutor'];
  teamAuthToken: string | undefined;
  /** Where the ACP server reports failures with no response left to carry them. */
  logger?: AcpServerOptions['logger'];
}

/**
 * Construct the ACP server (plan §3b step 4, "ACP server construction").
 *
 * Construction only — `startHttp()` stays at the call site. `serve.ts` binds
 * ACP first on purpose ("kept first so any breakage is obvious"), and plan §3b's
 * callout / §11 Open Question 8 leaves that ordering undecided for the merged
 * profile; keeping the bind out of this function means neither answer is
 * pre-empted here.
 */
export function buildServeAcpServer(opts: BuildServeAcpServerOptions): AcpServer {
  const {
    loop,
    session,
    mesh,
    personalities,
    activePersonality,
    teamFlag,
    mcpManager,
    jobStore,
    backgroundExecutor,
    teamAuthToken,
    logger,
  } = opts;
  // The MCP session-grant wiring is omitted on the team-coordinator path,
  // which has no McpManager — `session/registerMcpServers` then fails closed.
  return new AcpServer({
    runner: loop,
    session,
    mesh,
    personalityId: activePersonality,
    // Lane C (kanban-hooks-notify-parity, Phase 2) — passive `notify`-mode
    // delivery needs somewhere to land, which only exists for a team board.
    // A solo (non-team) `ethos serve` just no-ops that path.
    ...(teamFlag && opts.notifyQueue ? { teamId: teamFlag, notifyQueue: opts.notifyQueue } : {}),
    ...(mcpManager
      ? createAcpMcpWiring({ mcpManager, personalities, defaultPersonalityId: activePersonality })
      : {}),
    ...(jobStore ? { jobStore } : {}),
    ...(backgroundExecutor ? { backgroundExecutor } : {}),
    ...(teamAuthToken ? { authToken: teamAuthToken } : {}),
    ...(logger ? { logger } : {}),
  });
}
