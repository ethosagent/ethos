// Pure "which backend are we talking to" helpers, shared by every surface
// that lets an operator point Ethos at a remote server (desktop's remote
// mode, the mobile app's Connect flow). No Electron, no cookies, no store —
// callers own their own persistence and pass a URL/token in.

/**
 * Normalizes a user-typed server URL to a bare origin (no trailing slash), or
 * null when it isn't an http(s) URL.
 */
export function normalizeRemoteUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.origin;
}

/** Normalizes a remote server URL to its origin, or null if unparseable. */
export function remoteOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** The host (and port) of a remote server URL, for user-facing messages. */
export function remoteHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** The websocket origin matching an http(s) origin — used by the remote CSP. */
export function wsOriginFor(origin: string): string {
  if (origin.startsWith('https://')) return `wss://${origin.slice('https://'.length)}`;
  if (origin.startsWith('http://')) return `ws://${origin.slice('http://'.length)}`;
  return origin;
}

export interface ProbeConnectionResult {
  ok: boolean;
  latencyMs?: number;
  version?: string;
  error?: string;
}

export interface ProbeConnectionOptions {
  fetch?: typeof globalThis.fetch;
  apiKey?: string;
  timeoutMs?: number;
}

/**
 * Two probes: is the server there, and does the token work.
 *
 * The token probe hits an authenticated RPC method with a bearer header and
 * only distinguishes 401/403 from everything else — we are proving the
 * credential, not the response shape. Mirrors the desktop's cookie-based
 * `testConnection`, with an injected `fetch` and a bearer header in place of
 * the desktop's cookie jar.
 */
export async function probeConnection(
  url: string,
  options: ProbeConnectionOptions = {},
): Promise<ProbeConnectionResult> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const origin = normalizeRemoteUrl(url);
  if (!origin) return { ok: false, error: 'Enter an http:// or https:// server URL.' };

  const start = Date.now();
  let health: Response;
  try {
    health = await fetchFn(`${origin}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const latencyMs = Date.now() - start;
  // 503 is a REACHABLE Ethos server whose gateway is down — the normal shape of
  // a serve-only deployment, and not a connection problem. Anything else means
  // we did not reach one.
  if (health.status !== 200 && health.status !== 503) {
    return { ok: false, error: `Server returned ${health.status}.`, latencyMs };
  }
  const version = await readVersion(health);
  const ok: ProbeConnectionResult = { ok: true, latencyMs, ...(version ? { version } : {}) };
  if (!options.apiKey) return ok;

  try {
    const res = await fetchFn(`${origin}/rpc/personalities/list`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.apiKey}`,
        Origin: origin,
      },
      body: JSON.stringify({ json: {} }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'Server rejected the token.', latencyMs };
    }
  } catch {
    // Reachability is already proven above, so a failure here is not the token
    // being refused — the only thing this probe is allowed to conclude.
  }
  return ok;
}

async function readVersion(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : undefined;
  } catch {
    return undefined;
  }
}
