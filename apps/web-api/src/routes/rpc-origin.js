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
const PRIVATE_IP_PATTERNS = [
    /^10\./,
    /^192\.168\./,
    // 172.16.0.0 — 172.31.255.255
    /^172\.(1[6-9]|2\d|3[0-1])\./,
];
/**
 * Build a `<scheme>://<host>[:port]` string from an incoming Fetch
 * `Request`, validate it against the trust policy, and return the
 * normalised origin (no trailing slash) on success. Returns undefined when
 * neither header is usable or the derived origin fails validation.
 */
export function deriveMcpRequestOrigin(req, webBaseUrl) {
    const candidate = readRequestOrigin(req);
    if (!candidate)
        return undefined;
    return isTrustedOrigin(candidate, webBaseUrl) ? candidate : undefined;
}
function readRequestOrigin(req) {
    // 1. Origin header — browsers set this on CORS + cross-origin fetches.
    const originHeader = req.headers.get('origin');
    if (originHeader) {
        const parsed = safeParseUrl(originHeader);
        // Origin should be scheme://host[:port] with no path. We accept any
        // well-formed absolute URL and reconstruct the origin component.
        if (parsed)
            return parsed.origin;
    }
    // 2. Fall back to <scheme>://<host>. The Fetch request URL tells us the
    //    scheme; the Host header tells us host+port. (req.url already
    //    contains both, but only when Node's Hono adapter or the test
    //    helper supplied an absolute URL — we read each piece explicitly
    //    so this works under both server-side and `app.request()` paths.)
    const host = req.headers.get('host');
    if (!host)
        return undefined;
    const scheme = req.url.startsWith('https://') ? 'https' : 'http';
    const built = safeParseUrl(`${scheme}://${host}`);
    return built?.origin;
}
function isTrustedOrigin(origin, webBaseUrl) {
    const parsed = safeParseUrl(origin);
    if (!parsed)
        return false;
    const hostname = parsed.hostname.toLowerCase();
    // Loopback — strip IPv6 brackets that URL parsing leaves on `[::1]`.
    const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
    if (bare === 'localhost' || bare === '127.0.0.1' || bare === '::1')
        return true;
    // RFC 1918 private ranges.
    for (const pat of PRIVATE_IP_PATTERNS) {
        if (pat.test(hostname))
            return true;
    }
    // Explicit allowlist via webBaseUrl.
    if (webBaseUrl) {
        const allowed = safeParseUrl(webBaseUrl);
        if (allowed && allowed.origin === parsed.origin)
            return true;
    }
    return false;
}
function safeParseUrl(input) {
    try {
        return new URL(input);
    }
    catch {
        return undefined;
    }
}
