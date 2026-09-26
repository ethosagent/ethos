// The one same-origin localhost comparison for the web API. Two gates use it:
// the CSRF check on state-changing HTTP requests (`csrfMiddleware`,
// ../middleware/csrf.ts) and the Origin check on WebSocket upgrades
// (`originAllowed`, ../voice/voice-socket.ts — the voice, satellite and
// browser-takeover sockets). A GET upgrade skips the CSRF middleware, and a
// `SameSite=Strict` cookie ignores port, so a second, looser copy here would
// hand a page on another localhost port a cookie-authenticated socket.
// Pinned by ../__tests__/middleware/csrf.test.ts and
// ../voice/__tests__/voice-socket.test.ts.

/**
 * True when `origin` is a loopback origin (localhost / 127.0.0.1 / [::1])
 * whose host AND port equal `requestHost`, the request's `Host` header — true
 * same-origin. Another localhost port does not pass, and `localhost` vs
 * `127.0.0.1` on the same port are different origins. A malformed origin or a
 * missing `Host` does not pass.
 */
export function isSameOriginLocalhost(origin: string, requestHost: string | undefined): boolean {
  if (!requestHost) return false;
  try {
    const url = new URL(origin);
    const host = url.hostname;
    const loopback =
      host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    // `url.host` drops a default port (`http://localhost:80` → `localhost`),
    // matching how a browser omits it from `Host`.
    return loopback && url.host === requestHost.toLowerCase();
  } catch {
    return false;
  }
}
