import { EthosError } from '@ethosagent/types';
import { serve as honoServe } from '@hono/node-server';

// Port-binding helper. Tries `basePort`, falls forward on EADDRINUSE up to
// `attempts` times. Pulled out of `serve.ts` so a focused unit test can
// import it without transitively loading the ACP server / mesh wiring.
//
// The minimal app shape (`{ fetch }`) is what `@hono/node-server` requires —
// it accepts any object with a `fetch` method, not just a `Hono` instance.

export interface ListenResult {
  server: ReturnType<typeof honoServe>;
  port: number;
}

export type FetchApp = { fetch: (req: Request) => Response | Promise<Response> };

/**
 * `reservedPorts` — ports the CALLER has already bound (or is about to bind)
 * in this same process. They are skipped without a bind attempt.
 *
 * Only the merged `ethos boot` profile passes it. In the split-process world
 * the ladder only ever probes other processes' ports, so `serve.ts` passes
 * nothing and behaves exactly as before. In one merged process, 3001/3002/3003
 * are THIS process's ACP / health / webhook servers, so a stale peer holding
 * 3000 would walk the web bind straight into its own siblings — a silent
 * self-collision with no precedent in the split architecture
 * (plan/phases/single-process-boot-profile.md §5 / §11 OQ10). Skipping is the
 * resolution chosen there: web lands on 3004, or the range is exhausted and
 * the error below names both the range and what was skipped. Never silent.
 *
 * A skipped port does NOT consume an attempt: `attempts` is a depth of real
 * bind attempts, and it must not silently shrink by however many of this
 * process's own ports happen to fall in the window. The scan is bounded by
 * `attempts + reserved.size` ports so a pathological reserved set cannot walk
 * forever.
 */
export async function listenWithFallback(
  app: FetchApp,
  basePort: number,
  attempts: number,
  hostname = '127.0.0.1',
  reservedPorts?: Iterable<number>,
): Promise<ListenResult> {
  const reserved = new Set(reservedPorts ?? []);
  const skipped: number[] = [];
  let lastErr: unknown;
  let tried = 0;
  let port = basePort;
  const lastPort = basePort + attempts + reserved.size - 1;
  for (; tried < attempts && port <= lastPort; port++) {
    if (reserved.has(port)) {
      skipped.push(port);
      continue;
    }
    tried++;
    try {
      const result = await tryListen(app, port, hostname);
      if (port !== basePort) {
        // Two different causes, two different messages: nothing external took
        // a port THIS process reserved, and saying "taken" there sends the
        // operator hunting a conflict that does not exist.
        const why = reserved.has(basePort)
          ? 'is already reserved by this process'
          : 'was taken by another process';
        console.warn(
          `⚠ Port ${basePort} ${why} — bound ${port} instead. If you use the Vite dev proxy ` +
            `(make web-dev), it still points at ${basePort} and will talk to whatever owns that port.`,
        );
      }
      return result;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
      lastErr = err;
    }
  }
  throw new EthosError({
    code: 'INTERNAL',
    cause:
      `No free port in range ${basePort}-${port - 1}` +
      (skipped.length > 0
        ? ` (skipped ${skipped.join(', ')} — already bound by this process)`
        : ''),
    action:
      'Pass --web-port=<n> to pick a different starting port, or stop whatever is using these.',
    details: {
      lastErr: lastErr instanceof Error ? lastErr.message : String(lastErr),
      ...(skipped.length > 0 ? { skippedReservedPorts: skipped } : {}),
    },
  });
}

/**
 * Close a listener for SHUTDOWN: stop accepting, then drop every connection
 * still open. `server.close()` alone waits for them, and every web UI tab
 * holds `GET /sse/system` open indefinitely — so a SIGTERM with a tab open
 * never got past the close, and the runtime disposal behind it never ran.
 * Callers settle suspended approvals and call `closeChat()` first (so the
 * "not sent" notice for dropped queued messages is already on its way), then
 * close their WebSocket lanes; after a `flushMs` pause for those writes,
 * whatever is still open is cut off, which is what a stop means. Pinned by
 * apps/ethos/src/commands/__tests__/serve-close-listener.test.ts and
 * serve-shutdown-notice.test.ts.
 */
export const LISTENER_FLUSH_MS = 100;

export async function closeListener(
  server: ListenResult['server'],
  flushMs: number = LISTENER_FLUSH_MS,
): Promise<void> {
  const closed = new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  // A moment for writes already queued on open streams — the "not sent"
  // notice `closeChat()` just emitted — to leave before their sockets drop.
  await new Promise<void>((resolve) => setTimeout(resolve, flushMs));
  // Present on `http.Server` (Node >= 18.2); absent on the http2 variants
  // `@hono/node-server` can also return, which Ethos never binds.
  (server as { closeAllConnections?: () => void }).closeAllConnections?.();
  await closed;
}

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  yellow: '\x1b[33m',
};

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

// Startup banner for a non-loopback web bind. Returns null for loopback —
// the caller prints nothing extra in the normal local case.
//
// Two things the operator needs at once: the surfaces that just became
// network-reachable, and the fact that `secureCookie` flips on for a
// non-loopback bind (serve.ts), which breaks web-UI login over plain http.
// Without the second line the symptom reads as a broken login, not a
// deliberate posture.
export function formatNonLoopbackWarning(host: string, port: number): string | null {
  if (isLoopbackHost(host)) return null;

  const body = [
    'SECURITY: the web server is bound to a NON-LOOPBACK address.',
    '',
    `  bind: ${host}:${port}`,
    '',
    'These surfaces are now reachable from other hosts on the network:',
    '  - /v1/*   OpenAI-compatible API',
    '  - /rpc/*  Mission Control RPC',
    '  - the web UI',
    'Any personality whose toolset includes `bash` therefore exposes command',
    'execution on this host to whoever can reach this port.',
    '',
    'The auth cookie is marked Secure on a non-loopback bind, so the web UI',
    'WILL NOT LOG IN over plain http. Front this port with a TLS-terminating',
    'reverse proxy and set `webBaseUrl` to its https:// URL rather than',
    'exposing the port directly.',
    '',
    'How-to: docs/content/building/how-to/deploy-mission-control-remote.md',
  ];

  // Width is derived from the content so a long hostname can't overflow the
  // box. Every line is plain ASCII, so `.length` is the printed width.
  const inner = body.reduce((max, line) => Math.max(max, line.length), 0) + 2;
  const paint = (line: string, weight = '') => `${c.yellow}${weight}${line}${c.reset}`;
  return [
    paint(`┌${'─'.repeat(inner)}┐`, c.bold),
    ...body.map((line) => paint(`│ ${line.padEnd(inner - 2)} │`)),
    paint(`└${'─'.repeat(inner)}┘`, c.bold),
  ].join('\n');
}

function tryListen(app: FetchApp, port: number, hostname: string): Promise<ListenResult> {
  return new Promise((resolve, reject) => {
    const server = honoServe({ fetch: app.fetch, port, hostname }, () => {
      resolve({ server, port });
    });
    // The Node server underlying @hono/node-server emits 'error' for bind
    // failures. Catch once; resolve has either fired by then or the error
    // beat it.
    server.once('error', (err) => reject(err));
  });
}
