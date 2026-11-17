// `ethos listen` — the reachability probes: `/healthz` and the `/satellite/ws`
// upgrade handshake, and the root-cause explanations they print. Split out of
// listen.ts.

import { randomBytes } from 'node:crypto';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

/** How a local server is started. Named wherever a probe says one is missing. */
const START_THE_SERVER = 'Start it with `ethos serve`.';

export interface SatelliteLaneProbe {
  ok: boolean;
  /**
   * Why, in one line. NEVER EMPTY — an empty detail is the defect this contract
   * exists to forbid: the row printed `…/satellite/ws: ;` and taught the
   * operator nothing at all.
   */
  detail: string;
  /** See `ListenPreflight.laneFailureCode`. Absent when the lane is reachable. */
  code?: string;
}

/**
 * Is the thing this satellite actually needs reachable?
 *
 * IT IS THE WEBSOCKET LANE, NOT `/healthz`. `/healthz` folds the CHANNEL
 * gateway's status into its own — a healthy `ethos serve` with no Telegram or
 * Slack adapter running answers 503 — and a satellite does not use the channel
 * gateway for anything. Probing it made this row lie on every deployment that
 * simply had no chat bots attached.
 *
 * So the first probe is an upgrade request against `/satellite/ws` itself, WITH
 * NO AUTH COOKIE, which is the cheapest thing that tests the real dependency:
 *   • 401/403 — the lane is mounted and refused an unauthenticated probe. That
 *     is the expected answer, and it never creates a lane or a registry row.
 *   • 101 — accepted (a deployment with auth off); torn down immediately.
 *   • 404 — this server has no satellite lane at all, which `/healthz` could
 *     never have told us.
 * An unexpected status, or an upgrade a proxy mangled, is INCONCLUSIVE rather
 * than wrong: the host answered something, so `/healthz` is asked as well.
 *
 * ONE CAUSE, SAID ONCE. But when the connection itself never came up, there is
 * nothing for `/healthz` to add — it dials the same host and port over the same
 * transport, so it can only fail the same way — and asking it anyway is what
 * produced the unreadable `a; b` line this exists to kill. So a connect-level
 * errno short-circuits, and even on the fallback path a health failure matching
 * the upgrade's own code is reported once rather than twice.
 */
export async function probeSatelliteLane(
  socketUrl: string,
  healthUrl: string,
): Promise<SatelliteLaneProbe> {
  const upgrade = await probeUpgrade(socketUrl);
  if (upgrade.status === 101) {
    return { ok: true, detail: `${socketUrl} accepted the upgrade` };
  }
  if (upgrade.status === 401 || upgrade.status === 403) {
    return {
      ok: true,
      detail: `${socketUrl} is mounted — answered ${upgrade.status} to a probe sent with no auth cookie, which is the expected refusal`,
    };
  }
  if (upgrade.status === 404) {
    return {
      ok: false,
      code: 'NO_SATELLITE_LANE',
      detail: `${socketUrl} answered 404 — this server has no satellite lane. Is it an older \`ethos serve\`?`,
    };
  }
  if (upgrade.code !== undefined && CONNECT_NEVER_ESTABLISHED.has(upgrade.code)) {
    return { ok: false, code: upgrade.code, detail: `${socketUrl}: ${upgrade.error}` };
  }

  const why = upgrade.status === undefined ? upgrade.error : `answered ${upgrade.status}`;
  const health = await probeHealthz(healthUrl);
  if (health.ok) {
    return { ok: true, detail: `${socketUrl}: ${why}; ${health.detail}` };
  }
  if (health.code !== undefined && health.code === upgrade.code) {
    // Both ends died of the same thing. The reader needs the diagnosis, not it
    // twice.
    return { ok: false, code: health.code, detail: `${socketUrl}: ${why}` };
  }
  return {
    ok: false,
    ...(health.code === undefined ? {} : { code: health.code }),
    detail: `${socketUrl}: ${why}; ${health.detail}`,
  };
}

/**
 * Errnos that mean the connection was never established, so a second probe over
 * the same transport is guaranteed to say the same thing.
 */
const CONNECT_NEVER_ESTABLISHED = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EACCES',
]);

/**
 * The error Node is actually reporting, dug out from under whatever wrapped it.
 *
 * Two wrappers hide it here and both are the everyday case:
 *   • `fetch` rejects with a bare `TypeError: fetch failed` — undici's opaque
 *     lid — and puts the real socket error on `.cause`.
 *   • `net.connect` to a dual-stack name such as `localhost` rejects with an
 *     `AggregateError` whose OWN `message` is the EMPTY STRING and whose
 *     `.errors` holds one refusal per address family. That empty string is
 *     precisely what printed `ws://localhost:3000/satellite/ws: ;`.
 *
 * So the walk takes the DEEPEST non-empty message and the deepest errno, and
 * falls back to the code (and then to a fixed phrase) rather than ever handing
 * back nothing.
 */
function rootCauseOf(err: unknown): { code?: string; message: string } {
  let code: string | undefined;
  let message = '';
  let current: unknown = err;
  for (let depth = 0; depth < 8 && typeof current === 'object' && current !== null; depth++) {
    const node = current as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
      errors?: unknown;
    };
    if (typeof node.code === 'string' && node.code !== '') code = node.code;
    if (typeof node.message === 'string' && node.message !== '') message = node.message;
    const nested = Array.isArray(node.errors) ? node.errors[0] : node.cause;
    if (nested === undefined || nested === null) break;
    current = nested;
  }
  if (message === '') {
    const raw = typeof err === 'string' ? err : String(err);
    message = raw.trim() === '' ? (code ?? 'no reason reported') : raw;
  }
  return code === undefined ? { message } : { code, message };
}

/**
 * An errno turned into a sentence an operator can act on.
 *
 * The overwhelmingly common one is `ECONNREFUSED`, and for it the message names
 * the remedy: a satellite that cannot reach the lane is, nine times in ten,
 * a satellite started before its server.
 */
function explainFailure(err: unknown): { code?: string; message: string } {
  const { code, message } = rootCauseOf(err);
  const clause = ((): string => {
    switch (code) {
      case 'ECONNREFUSED':
        return `connection refused (ECONNREFUSED) — nothing is listening there, so the server is not running. ${START_THE_SERVER}`;
      case 'ENOTFOUND':
        return 'the hostname does not resolve (ENOTFOUND) — check webBaseUrl in ~/.ethos/config.yaml, or --url.';
      case 'EAI_AGAIN':
        return 'DNS lookup failed (EAI_AGAIN) — this machine could not resolve the hostname.';
      case 'ETIMEDOUT':
      case 'UND_ERR_CONNECT_TIMEOUT':
        return `timed out (${code}) — the address is routable but nothing answered. Check a firewall, or whether the server is bound to that interface.`;
      case 'EHOSTUNREACH':
      case 'ENETUNREACH':
        return `no route to that host (${code}) — check this machine's network.`;
      case 'ECONNRESET':
        return 'the connection was reset (ECONNRESET) — something answered and hung up. A proxy in front of the lane?';
      case 'EACCES':
        return 'refused locally (EACCES) — a sandbox or firewall on this machine blocked the connection.';
      default:
        return code === undefined ? message : `${message} (${code})`;
    }
  })();
  return code === undefined ? { message: clause } : { code, message: clause };
}

/**
 * `/healthz`, read for what it says rather than for its status code.
 *
 * A 503 whose body is `{status: 'degraded', gateway: {...}}` means the CHANNEL
 * gateway is down or stale — nothing a satellite depends on. The web-api
 * answered, which is the fact this probe is after, so that shape is reported as
 * reachable and says which subsystem was the one that was down.
 */
export async function probeHealthz(
  url: string,
): Promise<{ ok: boolean; detail: string; code?: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (res.ok) return { ok: true, detail: `${url} answered ${res.status}` };
    const body: unknown = await res.json().catch(() => null);
    if (isGatewayDegraded(body)) {
      return {
        ok: true,
        detail: `${url} answered ${res.status} — the web-api is up and only the channel gateway is down, which a satellite does not need`,
      };
    }
    return { ok: false, code: `HTTP_${res.status}`, detail: `${url} answered ${res.status}` };
  } catch (err) {
    // `err.message` here is `fetch failed` — undici's lid over the real socket
    // error, which is on `.cause`. Reporting the lid is reporting nothing.
    const failure = explainFailure(err);
    return {
      ok: false,
      ...(failure.code === undefined ? {} : { code: failure.code }),
      detail: `${url}: ${failure.message}`,
    };
  }
}

/** The exact `/healthz` shape that means "only the channel gateway is down". */
function isGatewayDegraded(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const record = body as { status?: unknown; gateway?: unknown };
  if (record.status !== 'degraded') return false;
  const gateway = record.gateway;
  if (typeof gateway !== 'object' || gateway === null) return false;
  const status = (gateway as { status?: unknown }).status;
  return status === 'down' || status === 'stale';
}

/** How long an upgrade probe waits for a status line before giving up. */
const UPGRADE_PROBE_TIMEOUT_MS = 3000;

/**
 * Either a status line came back, or a reason did. `error` is REQUIRED on the
 * failure arm so no branch can resolve a failure and say nothing about it —
 * that is how an ECONNREFUSED reached the row as the empty string.
 */
type UpgradeProbe =
  | { status: number; error?: undefined; code?: undefined }
  | { status?: undefined; error: string; code?: string };

/**
 * Send one WebSocket upgrade request and read the status line back.
 *
 * The handshake is deliberately NOT completed: no cookie is sent, so the server
 * refuses with 401 and no lane, no registry row, and no phantom satellite is
 * created by the act of checking.
 */
function probeUpgrade(socketUrl: string): Promise<UpgradeProbe> {
  let parsed: URL;
  try {
    parsed = new URL(socketUrl);
  } catch {
    return Promise.resolve({ error: `not a URL: ${socketUrl}` });
  }
  const secure = parsed.protocol === 'wss:' || parsed.protocol === 'https:';
  const port = Number(parsed.port) || (secure ? 443 : 80);
  const path = `${parsed.pathname}${parsed.search}`;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: UpgradeProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ error: `no response within ${UPGRADE_PROBE_TIMEOUT_MS}ms` }),
      UPGRADE_PROBE_TIMEOUT_MS,
    );
    const socket: Socket = secure
      ? tlsConnect({ host: parsed.hostname, port, servername: parsed.hostname })
      : netConnect({ host: parsed.hostname, port });

    socket.once(secure ? 'secureConnect' : 'connect', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: ${parsed.host}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n` +
          'Sec-WebSocket-Version: 13\r\n\r\n',
      );
    });
    socket.once('data', (chunk: Buffer) => {
      const match = /^HTTP\/1\.\d (\d{3})/.exec(chunk.toString('latin1'));
      finish(match?.[1] ? { status: Number(match[1]) } : { error: 'no HTTP status line' });
    });
    // NOT `err.message`: a dual-stack `localhost` refusal arrives as an
    // `AggregateError` whose own message is the empty string. See `rootCauseOf`.
    socket.once('error', (err: Error) => {
      const failure = explainFailure(err);
      finish({
        error: failure.message,
        ...(failure.code === undefined ? {} : { code: failure.code }),
      });
    });
    socket.once('close', () => finish({ error: 'closed with no response' }));
  });
}
