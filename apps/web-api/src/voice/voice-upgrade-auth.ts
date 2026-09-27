import type { IncomingMessage } from 'node:http';
import { EthosError } from '@ethosagent/types';
import { AUTH_COOKIE } from '../middleware/auth';
import type { ApiKeyAuthStore } from '../middleware/bearer-auth';
import { verifyBearer } from '../middleware/dual-auth';
import type { WebTokenRepository } from '../repositories/web-token.repository';
import { readCookie, type VoiceUpgradeAuth } from './voice-socket';

/** The scope a bearer key needs to open the voice socket (mobile-app S8). */
export const VOICE_SOCKET_SCOPE = 'voice:talk';

export interface VoiceUpgradeAuthOptions {
  tokens: Pick<WebTokenRepository, 'matches'>;
  /** Absent → no API-key store on this deployment; a bearer upgrade is 401. */
  apiKeys?: ApiKeyAuthStore;
}

/**
 * The voice socket's `authenticate` (`createVoiceSocket` in ../index.ts).
 * An `Authorization` header is checked as a bearer API key ONLY — by
 * `verifyBearer` (../middleware/dual-auth.ts), the same enforcer RPC uses,
 * requiring `voice:talk` — and never falls back to the cookie. Without one,
 * the `ethos_auth` cookie, exactly as before. The satellite and takeover
 * sockets stay cookie-only and do not use this.
 */
export function voiceUpgradeAuthenticator(
  opts: VoiceUpgradeAuthOptions,
): (req: IncomingMessage) => Promise<VoiceUpgradeAuth> {
  const lastTouchAt = new Map<string, number>();
  return async (req) => {
    const header = req.headers.authorization;
    if (header !== undefined) {
      if (!opts.apiKeys) return { ok: false, status: 401 };
      try {
        await verifyBearer({
          header,
          origin: req.headers.origin,
          apiKeys: opts.apiKeys,
          requiredScope: VOICE_SOCKET_SCOPE,
          lastTouchAt,
        });
        return { ok: true, via: 'bearer' };
      } catch (err) {
        if (err instanceof EthosError && err.code === 'FORBIDDEN')
          return { ok: false, status: 403 };
        return { ok: false, status: 401 };
      }
    }
    const cookie = readCookie(req.headers.cookie, AUTH_COOKIE);
    if (cookie && (await opts.tokens.matches(cookie))) return { ok: true, via: 'cookie' };
    return { ok: false, status: 401 };
  };
}
