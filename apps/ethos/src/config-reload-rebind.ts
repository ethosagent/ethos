// Phase D of the live config reload — per-server port rebind (plan §0 row 9),
// split out of config-reload.ts, which re-exports everything public.

import type { EthosConfig } from '@ethosagent/config';
import type { Logger } from '@ethosagent/types';
import { hasFlag, resolveWebHost, resolveWebPort } from './commands/serve-helpers';

// ---------------------------------------------------------------------------
// Phase D — per-server port rebind (plan §0 row 9, §4's Phase D bullet)
// ---------------------------------------------------------------------------
//
// SCOPE, AND WHY IT IS ONE SERVER RATHER THAN FIVE. §0 row 9 names five
// listeners (ACP 3001, health 3002, webhook 3003, platform-webhook 3006, web
// 3000+fallback). Only the web bind is reachable from `config.yaml`: `acpPort`
// is the `--port` CLI flag, and the health / webhook / platform-webhook ports
// are `ETHOS_GATEWAY_HEALTH_PORT` / `ETHOS_WEBHOOK_PORT` /
// `ETHOS_PLATFORM_WEBHOOK_PORT` (see `runBoot`'s resolution block). A config
// differ cannot observe an env var change, so inventing config keys for those
// four would be new configuration surface, not this phase.
//
// WHAT IT DELIBERATELY DOES NOT TOUCH. Everything. The close-and-relisten
// below is handed a server, an address, and a listen function; it holds no
// reference to the `AgentLoop`, the session store, the job store, the mesh
// registration, or the gateway. That is the plan's §5.6 assertion made
// structural rather than merely tested: there is nothing here to call.
//
// A brief gap between close and listen is accepted (§6 non-goal: no
// zero-downtime multi-port renumbering scheme).

/** A web bind address, as requested — not necessarily as landed on. */
export interface WebBindTarget {
  host: string;
  port: number;
}

/**
 * The address the web server should be listening on for `config`, resolved
 * with the SAME precedence cold boot uses: CLI flag > env var > `config.yaml`
 * > default. Reusing `resolveWebHost`/`resolveWebPort` rather than reading
 * `config.web` directly is the whole point — a second resolution path is how
 * "the live bind disagrees with the one the process started on" happens.
 */
export function resolveWebBind(
  config: EthosConfig,
  args: string[],
  env: NodeJS.ProcessEnv,
): WebBindTarget {
  return {
    host: resolveWebHost(args, env, config),
    port: resolveWebPort(args, env, config),
  };
}

export type WebRebindDecision =
  | { action: 'rebind'; target: WebBindTarget }
  | { action: 'skip'; reason: string };

/**
 * Whether a reloaded config actually moves the live web bind.
 *
 * `current` is the address that was REQUESTED, not the one that was landed on:
 * the fallback ladder may have put the server on 3004 after asking for 3000,
 * and an operator who then writes `web.port: 3000` has changed nothing. Diffing
 * requested-against-requested is what keeps that a no-op instead of a pointless
 * bounce of the dashboard.
 *
 * A `--web-port` / `--web-host` flag or `ETHOS_WEB_PORT` / `ETHOS_WEB_HOST`
 * outranks `config.yaml`, so a config edit under one of those is inert. That is
 * reported as a named skip rather than silence — the same honesty rule §1 sets
 * for the unsupported keys.
 */
export function planWebRebind(
  current: WebBindTarget,
  config: EthosConfig,
  args: string[],
  env: NodeJS.ProcessEnv,
): WebRebindDecision {
  const target = resolveWebBind(config, args, env);
  if (target.host === current.host && target.port === current.port) {
    const pinned =
      hasFlag(args, ['--web-port']) ||
      hasFlag(args, ['--web-host']) ||
      env.ETHOS_WEB_PORT !== undefined ||
      env.ETHOS_WEB_HOST !== undefined;
    return {
      action: 'skip',
      reason: pinned
        ? '--web-port/--web-host or ETHOS_WEB_PORT/ETHOS_WEB_HOST outranks config.yaml'
        : 'the configured address is already the live one',
    };
  }
  return { action: 'rebind', target };
}

/**
 * The minimum a rebindable listener has to be. `@hono/node-server`'s
 * `ServerType` satisfies it, and so does a bare `http.Server` — which is what
 * lets a test drive this for real instead of against a mock.
 */
export interface RebindableServer {
  close(callback?: (err?: Error) => void): unknown;
  closeAllConnections?: () => void;
}

export interface WebRebindOutcome<S extends RebindableServer> {
  server: S;
  /** The address asked for — feed this back in as the next `current`. */
  requested: WebBindTarget;
  /** The port actually landed on, which the fallback ladder may have moved. */
  port: number;
  /** True when `target` could not be bound and `current` was reclaimed. */
  fellBack: boolean;
}

function closeServer(server: RebindableServer): Promise<void> {
  // Idle keep-alive connections would otherwise hold the close callback — and
  // therefore the port — for as long as a browser keeps the dashboard open.
  server.closeAllConnections?.();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

/**
 * Close one listener and re-listen it on a new address.
 *
 * CLOSE FIRST, ALWAYS. A host-only move (127.0.0.1 → 0.0.0.0 on the same port)
 * would collide with itself otherwise, and the collision would be reported as
 * "port in use" against a port nothing else holds.
 *
 * THE FAILURE MODE THAT MATTERS is a new port that is already taken. `listen`
 * is expected to be the caller's existing fallback ladder, which walks past an
 * occupied port on its own; this handles the case where even that gives up —
 * the range is exhausted, the host does not exist, the port is privileged. The
 * operator must not be left with NO web server because of a typo, so the
 * previous address (just vacated, so normally free) is reclaimed and the
 * failure is named through the injected logger.
 *
 * If the reclaim ALSO fails there is genuinely nothing left to bind: that is
 * logged at error level, saying in as many words that nothing is listening,
 * and the original error is rethrown for the caller's own guard to record.
 */
export async function rebindWebServer<S extends RebindableServer>(opts: {
  server: S;
  current: WebBindTarget;
  target: WebBindTarget;
  listen: (bind: WebBindTarget) => Promise<{ server: S; port: number }>;
  /** Re-attach anything bolted onto the old server (the voice + satellite
   *  WebSocket upgrade routes). Both `attach` implementations detach from the
   *  previous server first, so this is a move, not a duplicate registration. */
  onListening: (server: S) => void;
  logger: Logger;
}): Promise<WebRebindOutcome<S>> {
  const { server, current, target, listen, onListening, logger } = opts;
  const addr = (b: WebBindTarget) => `${b.host}:${b.port}`;
  await closeServer(server);
  try {
    const next = await listen(target);
    onListening(next.server);
    logger.info(`[config-reload] web server rebound to ${target.host}:${next.port}`, {
      component: 'config-reload',
      host: target.host,
      port: next.port,
    });
    return { server: next.server, requested: target, port: next.port, fellBack: false };
  } catch (err) {
    logger.warn(
      `[config-reload] web server could not bind ${addr(target)} — reverting to ${addr(current)}`,
      {
        component: 'config-reload',
        host: target.host,
        port: target.port,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    try {
      const back = await listen(current);
      onListening(back.server);
      return { server: back.server, requested: current, port: back.port, fellBack: true };
    } catch (reclaimErr) {
      logger.error(
        `[config-reload] web server is NOT listening — ${addr(target)} could not be bound and ${addr(current)} could not be reclaimed`,
        {
          component: 'config-reload',
          error: reclaimErr instanceof Error ? reclaimErr.message : String(reclaimErr),
        },
      );
      throw err;
    }
  }
}
