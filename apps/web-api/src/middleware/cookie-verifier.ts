import type { WebSessionStore } from '../repositories/web-session.store';
import type { WebTokenRepository } from '../repositories/web-token.repository';

// THE cookie check (web-auth-bootstrap D4). A cookie value authenticates when
// it is EITHER a live server-side session id (human login / setup / reset) OR
// the raw bootstrap token (machine clients: desktop, satellite, docker CI all
// mint `ethos_auth=<token>` from the token file — see plan §1.2).
//
// This is the single owner of the dual-accept: `authMiddleware`, `dualAuth`'s
// cookie branch, and the three WebSocket lanes (voice / satellite / takeover)
// all call a verifier built here. No other site may compare cookie values.

export type CookieVerifier = (cookieValue: string) => Promise<boolean>;

export interface CookieVerifierOptions {
  tokens: WebTokenRepository;
  sessions: WebSessionStore;
}

export function createCookieVerifier(opts: CookieVerifierOptions): CookieVerifier {
  return async (cookieValue: string): Promise<boolean> => {
    if (!cookieValue) return false;
    if (await opts.sessions.has(cookieValue)) return true;
    return opts.tokens.matches(cookieValue);
  };
}
