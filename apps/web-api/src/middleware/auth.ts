import { EthosError } from '@ethosagent/types';
import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { CookieVerifier } from './cookie-verifier';

// Cookie auth. Single-user posture (CEO finding 3.1, amended by
// web-auth-bootstrap D4): the cookie value is EITHER a server-side session id
// (human login) OR the raw bootstrap token (machine clients). The dual-accept
// lives in ONE place — `createCookieVerifier` (./cookie-verifier.ts) — and
// this middleware only routes through it.

export const AUTH_COOKIE = 'ethos_auth';

export interface AuthMiddlewareOptions {
  verify: CookieVerifier;
}

export function authMiddleware(opts: AuthMiddlewareOptions): MiddlewareHandler {
  return async (c, next) => {
    const cookie = getCookie(c, AUTH_COOKIE);
    if (!cookie) {
      throw new EthosError({
        code: 'UNAUTHORIZED',
        cause: 'Missing auth cookie',
        action: 'Sign in via the web UI (or the URL printed by `ethos serve`).',
      });
    }
    const ok = await opts.verify(cookie);
    if (!ok) {
      throw new EthosError({
        code: 'UNAUTHORIZED',
        cause: 'Auth cookie is not a live session or the active token',
        action: 'Sign in again via the web UI.',
      });
    }
    // Recorded like `dualAuth` does, so a handler that needs a POSITIVE cookie
    // (the chat initiator, features/chat/rpc/send.ts) sees one on this path too.
    c.set('authMethod', 'cookie');
    await next();
  };
}
