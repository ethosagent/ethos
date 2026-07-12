import { isIP } from 'node:net';

// Derive a trustworthy origin string from an inbound web request, for use
// as the MCP OAuth `redirect_uri`'s scheme+host+port. Returns undefined
// when the request's origin can't be trusted — the caller (McpService)
// then falls back to the constructor-level default or surfaces an
// `invalid_origin` error.
//
// Trust policy:
//   1. Loopback hosts (`localhost`, `127.0.0.1`, `::1`) — always accepted.
//   2. RFC 1918 private ranges (`10.x`, `172.16-31.x`, `192.168.x`) —
//      always accepted. The web UI is sometimes served on a LAN address
//      for cross-device QA.
//   3. Origin matching the configured `webBaseUrl` — accepted. This is the
//      escape valve for production deployments behind a public domain.
//   4. Everything else — rejected (returns undefined). The service will
//      surface `invalid_origin` to the UI when no fallback is configured.
//
// We accept the request via either:
//   a) The `Origin` header — set by browsers on cross-origin / fetch
//      requests. This is the authoritative value when present.
//   b) Otherwise, `<scheme>://<host>` built from the `Host` header. Same-
//      origin GETs and `fetch()` calls without Origin still carry Host.

// WEB-005: only real IPv4 literals may qualify as private ranges. The previous
// hostname-prefix regexes matched attacker-registerable DNS names like
// `10.evil.com` / `192.168.attacker.io`, letting an attacker-controlled origin
// pose as a trusted private host. We parse with `node:net` `isIP()` and
// range-check octets, so a name that merely starts with `10.` is rejected.
function isPrivateIpv4(hostname: string): boolean {
  if (isIP(hostname) !== 4) return false;
  const parts = hostname.split('.');
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  return false;
}

/**
 * Build a `<scheme>://<host>[:port]` string from an incoming Fetch
 * `Request`, validate it against the trust policy, and return the
 * normalised origin (no trailing slash) on success. Returns undefined when
 * neither header is usable or the derived origin fails validation.
 */
export function deriveMcpRequestOrigin(
  req: Request,
  webBaseUrl: string | undefined,
): string | undefined {
  const candidate = readRequestOrigin(req);
  if (!candidate) return undefined;
  return isTrustedOrigin(candidate, webBaseUrl) ? candidate : undefined;
}

function readRequestOrigin(req: Request): string | undefined {
  // 1. Origin header — browsers set this on CORS + cross-origin fetches.
  const originHeader = req.headers.get('origin');
  if (originHeader) {
    const parsed = safeParseUrl(originHeader);
    // Origin should be scheme://host[:port] with no path. We accept any
    // well-formed absolute URL and reconstruct the origin component.
    if (parsed) return parsed.origin;
  }

  // 2. Fall back to <scheme>://<host>. The Fetch request URL tells us the
  //    scheme; the Host header tells us host+port. (req.url already
  //    contains both, but only when Node's Hono adapter or the test
  //    helper supplied an absolute URL — we read each piece explicitly
  //    so this works under both server-side and `app.request()` paths.)
  const host = req.headers.get('host');
  if (!host) return undefined;
  const scheme = req.url.startsWith('https://') ? 'https' : 'http';
  const built = safeParseUrl(`${scheme}://${host}`);
  return built?.origin;
}

function isTrustedOrigin(origin: string, webBaseUrl: string | undefined): boolean {
  const parsed = safeParseUrl(origin);
  if (!parsed) return false;
  const hostname = parsed.hostname.toLowerCase();

  // Loopback — strip IPv6 brackets that URL parsing leaves on `[::1]`.
  const bare =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (bare === 'localhost' || bare === '127.0.0.1' || bare === '::1') return true;

  // RFC 1918 private ranges — only for genuine IPv4 literals (see isPrivateIpv4).
  if (isPrivateIpv4(bare)) return true;

  // Explicit allowlist via webBaseUrl.
  if (webBaseUrl) {
    const allowed = safeParseUrl(webBaseUrl);
    if (allowed && allowed.origin === parsed.origin) return true;
  }

  return false;
}

function safeParseUrl(input: string): URL | undefined {
  try {
    return new URL(input);
  } catch {
    return undefined;
  }
}
