import type {
  ClientCreds,
  CustomFlowProvider,
  GrantInput,
  HttpRequest,
  TokenSet,
} from '@ethosagent/oauth-core';
import { exchangeForTokens, refreshTokens } from './auth';

/**
 * Codex device-auth flow exposed as a CustomFlowProvider for the
 * centralized OAuth registry. The device-code polling is handled
 * externally (by the CLI surface); this provider handles only the
 * code-for-token exchange and refresh steps.
 */
export const codexCustomFlowProvider: CustomFlowProvider = {
  id: 'codex-device-auth',

  async exchange(grant: GrantInput, _creds: ClientCreds): Promise<TokenSet> {
    const code = grant.code ?? '';
    const codeVerifier = (grant.codeVerifier as string) ?? '';
    const result = await exchangeForTokens(globalThis.fetch, code, codeVerifier);
    return {
      access_token: result.accessToken,
      refresh_token: result.refreshToken,
      expires_at: result.expiresAt,
    };
  },

  async refresh(token: TokenSet, _creds: ClientCreds): Promise<TokenSet> {
    if (!token.refresh_token) {
      throw new Error('No refresh token available for Codex');
    }
    const result = await refreshTokens(globalThis.fetch, token.refresh_token);
    return {
      access_token: result.accessToken,
      refresh_token: result.refreshToken,
      expires_at: result.expiresAt,
    };
  },

  authorizeRequest(req: HttpRequest, token: TokenSet, _creds: ClientCreds): void {
    req.headers.Authorization = `Bearer ${token.access_token}`;
  },
};
