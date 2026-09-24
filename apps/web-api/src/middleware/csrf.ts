import { EthosError } from '@ethosagent/types';
import type { MiddlewareHandler } from 'hono';

// CSRF protection (CEO finding 3.2). With `SameSite=Strict` cookies, the
// browser will refuse to attach our auth cookie to most cross-origin
// requests anyway, but a defense-in-depth Origin check on every state-
// changing method catches the few that slip through.
//
// Localhost rule: a localhost / 127.0.0.1 / [::1] Origin passes only when its
// host (hostname AND port) equals the request's `Host` header — true
// same-origin (`isSameOriginLocalhost` below). A page served from any other
// localhost port (a dev server, a local tool) no longer passes, and
// `localhost` vs `127.0.0.1` on the same port are different origins. Every
// first-party client is same-origin by construction: `ethos serve` and the
// desktop shell load the SPA from the API's own origin, and the Vite dev
// server proxies with `changeOrigin: false` so the API sees
// `Host: localhost:5173` (apps/web/vite.config.ts, pinned by
// apps/web-api/src/__tests__/vite-proxy-origin.test.ts). Pinned by
// apps/web-api/src/__tests__/middleware/csrf.test.ts.
//
// An explicit allow-list (`ETHOS_ALLOWED_ORIGINS`, see
// `resolveAllowedOrigins` in `apps/ethos/src/commands/serve-helpers.ts`)
// replaces the localhost rule entirely: non-localhost deployments use it to
// trust their own public origin.

const STATEFUL_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface CsrfMiddlewareOptions {
  /** Explicit allow-list. When provided, only these origins pass. Empty
   *  array means "no cross-origin allowed at all". */
  allowedOrigins?: string[];
  /** When true, a localhost / 127.0.0.1 / [::1] origin is accepted when its
   *  host:port equals the request `Host`. Default: true (localhost-default
   *  posture). */
  allowLocalhost?: boolean;
}

export function csrfMiddleware(opts: CsrfMiddlewareOptions = {}): MiddlewareHandler {
  const allowedOrigins = opts.allowedOrigins;
  const allowLocalhost = opts.allowLocalhost ?? true;

  return async (c, next) => {
    if (!STATEFUL_METHODS.has(c.req.method)) return next();

    const origin = c.req.header('origin');
    // Same-origin requests don't always send Origin (older browsers, some
    // fetch contexts). Fall back to Referer when present.
    const referer = c.req.header('referer');
    let refererOrigin: string | null = null;
    if (referer) {
      try {
        refererOrigin = new URL(referer).origin;
      } catch {
        throw new EthosError({
          code: 'INVALID_INPUT',
          cause: 'Malformed Referer header',
          action: 'Send a valid URL in the Referer header.',
        });
      }
    }
    const candidate = origin ?? refererOrigin;

    if (!candidate) {
      throw new EthosError({
        code: 'UNAUTHORIZED',
        cause: 'Missing Origin header on state-changing request',
        action: 'Browsers send Origin automatically for fetch/XHR. Check your client.',
      });
    }

    // The host the request was addressed to. `@hono/node-server` builds
    // `c.req.url` from `Host` (or the HTTP/2 `:authority`), so the fallback is
    // the same fact when the header itself is not exposed.
    const requestHost = c.req.header('host') ?? new URL(c.req.url).host;
    if (isAllowed(candidate, requestHost, allowedOrigins, allowLocalhost)) return next();

    throw new EthosError({
      code: 'UNAUTHORIZED',
      cause: `Cross-origin request from ${candidate} blocked`,
      action:
        'Set `ETHOS_ALLOWED_ORIGINS` to include this origin — comma-separated exact origins, or `*.yourdomain.com` wildcards for a domain you own (never a shared hosting domain like `*.fly.dev`).',
    });
  };
}

function isAllowed(
  origin: string,
  requestHost: string,
  allowed: string[] | undefined,
  allowLocalhost: boolean,
): boolean {
  if (allowed && allowed.length > 0) {
    if (allowed.includes(origin)) return true;
    return allowed.some((pattern) => matchesWildcard(origin, pattern));
  }
  if (allowLocalhost && isSameOriginLocalhost(origin, requestHost)) return true;
  return false;
}

// `*.example.com` matches `https://foo.example.com` (any subdomain) AND
// `https://example.com` itself (the bare apex) — an operator who lists the
// wildcard almost always means "this whole domain," not "subdomains only,
// but not the domain itself."
function matchesWildcard(origin: string, pattern: string): boolean {
  if (!pattern.startsWith('*.')) return false;
  const suffix = pattern.slice(2);
  try {
    const hostname = new URL(origin).hostname;
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  } catch {
    return false;
  }
}

function isSameOriginLocalhost(origin: string, requestHost: string): boolean {
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
