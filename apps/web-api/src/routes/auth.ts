import type { Context, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { AUTH_COOKIE } from '../middleware/auth';
import { rateLimitMiddleware } from '../middleware/rate-limit';
import type { WebAdminRepository } from '../repositories/web-admin.repository';
import type { WebSessionStore } from '../repositories/web-session.store';
import type { WebTokenRepository } from '../repositories/web-token.repository';

// Web auth bootstrap (plan/phases/web-auth-bootstrap.md, Phase 1).
//
// Two steady states (D10/D16):
//   UNCLAIMED — token mode, supported indefinitely. `GET /exchange?t=` grants
//   a cookie exactly as before (minus rotation, D7), and `POST /token-login`
//   is the lock screen's paste path. The cookie value is the raw token.
//   CLAIMED — an admin record exists (`web-admin.json`). Browser token grants
//   are retired: exchange 302s to the reset page as a PREFILL (no cookie),
//   token-login answers 410, and `POST /login` mints a server-side session.
//
// The bootstrap token stays cookie-valid in both states (D4) — machine
// clients (desktop, satellite, docker CI) mint `ethos_auth=<token>` from the
// token file and never touch these routes.
//
// All four POSTs are rate-limited (same bucket params as /auth/codex,
// routes/index.ts) and Origin-checked: a present Origin must be same-origin
// or operator-allowlisted; an absent Origin passes (non-browser clients).

const MIN_PASSWORD_LENGTH = 12;

export interface AuthRoutesOptions {
  tokens: WebTokenRepository;
  admin: WebAdminRepository;
  sessions: WebSessionStore;
  /** TTL for the auth cookie. Defaults to 30 days. */
  cookieMaxAgeSeconds?: number;
  /** When true, the cookie's `secure` flag is set. Default: false (localhost). */
  secureCookie?: boolean;
  /** Explicit cross-origin allow-list for the auth POSTs' Origin check. */
  allowedOrigins?: string[];
  /** Honor `X-Forwarded-For` for rate-limit bucketing (WEB-006). */
  trustProxy?: boolean;
  /** OAuth coordinator for plugin credential flows (v2.2). */
  oauthCoordinator?: import('@ethosagent/plugin-sdk').OAuthCoordinator;
  /** Notification router for resuming turns after OAuth (v2.2). */
  notificationRouter?: import('@ethosagent/types').NotificationRouter;
}

/**
 * Origin gate for the auth POSTs. Unlike `csrfMiddleware`, an ABSENT Origin is
 * allowed — curl / CI clients POST here without one, and these endpoints
 * demand their own credential in the body, so the check only has to stop a
 * browser being ridden cross-origin.
 */
function authOriginCheck(allowedOrigins: readonly string[]): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header('origin');
    if (!origin) return next();
    const requestHost = c.req.header('host') ?? new URL(c.req.url).host;
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null;
    }
    if (originHost !== null && originHost === requestHost) return next();
    if (allowedOrigins.includes(origin)) return next();
    return c.json(
      {
        ok: false,
        code: 'UNAUTHORIZED',
        error: `Cross-origin request from ${origin} blocked`,
        action: 'Auth requests must come from the web UI origin or a configured allowed origin.',
      },
      401,
    );
  };
}

export function authRoutes(opts: AuthRoutesOptions) {
  const app = new Hono();
  const maxAge = opts.cookieMaxAgeSeconds ?? 60 * 60 * 24 * 30;

  const grantCookie = (c: Context, value: string): void => {
    setCookie(c, AUTH_COOKIE, value, {
      httpOnly: true,
      sameSite: 'Strict',
      secure: opts.secureCookie ?? false,
      path: '/',
      maxAge,
    });
  };

  const unauthorized = (c: Context, error: string, action: string) =>
    c.json({ ok: false, code: 'UNAUTHORIZED', error, action }, 401);

  const originCheck = authOriginCheck(opts.allowedOrigins ?? []);
  for (const path of ['/setup', '/login', '/token-login', '/reset']) {
    app.use(path, originCheck);
    // One limiter instance per endpoint — same bucket params as /auth/codex
    // (routes/index.ts): 5 tokens, 1/min refill, 10-min lockout.
    app.use(path, rateLimitMiddleware({ trustProxy: opts.trustProxy ?? false }));
  }

  // D8 — the ONE unauthenticated, secret-free status endpoint. Mounted with
  // the rest of /auth (which sits before the auth middleware, like /healthz)
  // so the SPA can route wizard vs login without a cookie.
  app.get('/state', async (c) => {
    return c.json({ claimed: await opts.admin.isClaimed(), tokenFromEnv: opts.tokens.fromEnv });
  });

  // D1 — the gated first-visit claim: bootstrap token + username + password.
  app.post('/setup', async (c) => {
    const body = await readJson(c);
    const token = str(body?.token);
    const username = str(body?.username);
    const password = str(body?.password);
    if (!token || !(await opts.tokens.matches(token))) {
      return unauthorized(c, 'Invalid bootstrap token', 'Use the token from your deployment.');
    }
    if (await opts.admin.isClaimed()) {
      return c.json(
        {
          ok: false,
          code: 'ALREADY_CLAIMED',
          error: 'This instance already has an admin account',
          action: 'Sign in with username and password, or reset via /welcome/reset.',
        },
        409,
      );
    }
    if (!username) {
      return c.json(
        {
          ok: false,
          code: 'INVALID_INPUT',
          error: 'Username is required',
          action: 'Provide a non-empty username.',
        },
        400,
      );
    }
    if (!password || password.length < MIN_PASSWORD_LENGTH) {
      return c.json(
        {
          ok: false,
          code: 'PASSWORD_TOO_SHORT',
          error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
          action: 'Choose a longer password.',
        },
        400,
      );
    }
    await opts.admin.claim({ username, password });
    grantCookie(c, await opts.sessions.create());
    return c.body(null, 204);
  });

  // D5 — username/password login. Uniform 401 whatever failed: the repository
  // verify is uniform-time (dummy argon2 on unknown username), and the body
  // never says which half was wrong.
  app.post('/login', async (c) => {
    const body = await readJson(c);
    const username = str(body?.username);
    const password = str(body?.password);
    if (!(await opts.admin.isClaimed())) {
      return c.json(
        {
          ok: false,
          code: 'NOT_CLAIMED',
          error: 'This instance has no admin account yet',
          action: 'Set one up via /welcome (POST /auth/setup), or use token sign-in.',
        },
        409,
      );
    }
    const ok = await opts.admin.verify({ username: username ?? '', password: password ?? '' });
    if (!ok) {
      return unauthorized(c, 'Invalid username or password', 'Check your credentials.');
    }
    grantCookie(c, await opts.sessions.create());
    return c.body(null, 204);
  });

  // D16 — the pre-claim lock screen's token-paste path. Grants the SAME cookie
  // exchange grants (the raw token, not rotated). Retired once claimed.
  app.post('/token-login', async (c) => {
    const body = await readJson(c);
    const token = str(body?.token);
    if (await opts.admin.isClaimed()) {
      return c.json(
        {
          ok: false,
          code: 'TOKEN_LOGIN_RETIRED',
          error: 'Browser token sign-in is retired on a claimed instance',
          action: 'Sign in with username and password, or reset via /welcome/reset.',
        },
        410,
      );
    }
    if (!token || !(await opts.tokens.matches(token))) {
      return unauthorized(c, 'Invalid token', 'Use the token from your deployment.');
    }
    grantCookie(c, token);
    return c.body(null, 204);
  });

  // D6 — token-gated reset: re-claim with fresh credentials, log every
  // browser out, sign the resetter in. Does NOT rotate the bootstrap token —
  // that would silently break the machine clients (plan §1.2).
  app.post('/reset', async (c) => {
    const body = await readJson(c);
    const token = str(body?.token);
    const username = str(body?.username);
    const password = str(body?.password);
    if (!token || !(await opts.tokens.matches(token))) {
      return unauthorized(c, 'Invalid bootstrap token', 'Use the token from your deployment.');
    }
    if (!username) {
      return c.json(
        {
          ok: false,
          code: 'INVALID_INPUT',
          error: 'Username is required',
          action: 'Provide a non-empty username.',
        },
        400,
      );
    }
    if (!password || password.length < MIN_PASSWORD_LENGTH) {
      return c.json(
        {
          ok: false,
          code: 'PASSWORD_TOO_SHORT',
          error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
          action: 'Choose a longer password.',
        },
        400,
      );
    }
    await opts.admin.reset({ username, password });
    await opts.sessions.invalidateAll();
    grantCookie(c, await opts.sessions.create());
    return c.body(null, 204);
  });

  // D7 (amended per D16) — pre-claim: today's grant minus rotation. Claimed:
  // never a cookie; the URL becomes a PREFILL deep-link into the reset page.
  app.get('/exchange', async (c) => {
    const token = c.req.query('t');

    if (await opts.admin.isClaimed()) {
      const suffix = token ? `?t=${encodeURIComponent(token)}` : '';
      return c.redirect(`/welcome/reset${suffix}`, 302);
    }

    if (!token) {
      return unauthorized(c, 'Missing token query', 'Use the URL printed by `ethos serve`.');
    }
    const valid = await opts.tokens.matches(token);
    if (!valid) {
      return unauthorized(c, 'Invalid token', 'Re-run `ethos serve` to print the URL again.');
    }
    grantCookie(c, token);
    // 302 to a clean URL so the token doesn't land in browser history.
    return c.redirect('/', 302);
  });

  app.get('/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    if (!code || !state) {
      return c.html('<html><body>Missing code or state parameter.</body></html>', 400);
    }
    try {
      if (!opts.oauthCoordinator || !opts.notificationRouter) {
        return c.html('<html><body>OAuth is not configured on this server.</body></html>', 500);
      }
      await opts.oauthCoordinator.handleCallback(code, state, opts.notificationRouter);
      return c.html('<html><body>Connected — you can close this tab.</body></html>');
    } catch {
      return c.html('<html><body>OAuth connection failed. Please try again.</body></html>', 400);
    }
  });

  return app;
}

async function readJson(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const parsed = (await c.req.json()) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
