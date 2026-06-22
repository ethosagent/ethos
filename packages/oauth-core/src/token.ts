import type { TokenSet } from './types';

export function parseTokenResponse(data: unknown): TokenSet {
  if (typeof data !== 'object' || data === null) {
    throw new Error('Token response must be an object');
  }

  const obj = data as Record<string, unknown>;

  if (typeof obj.access_token !== 'string' || obj.access_token === '') {
    throw new Error('Token response missing access_token');
  }

  const token: TokenSet = {
    access_token: obj.access_token,
  };

  if (typeof obj.refresh_token === 'string') {
    token.refresh_token = obj.refresh_token;
  }

  if (typeof obj.token_type === 'string') {
    token.token_type = obj.token_type;
  }

  if (typeof obj.scope === 'string' && obj.scope !== '') {
    token.scopes = obj.scope.split(' ');
  }

  if (typeof obj.expires_in === 'number' && obj.expires_in > 0) {
    token.expires_at = new Date(Date.now() + obj.expires_in * 1000).toISOString();
  }

  return token;
}

export function isTokenExpired(token: TokenSet, bufferMs = 60_000): boolean {
  if (!token.expires_at) return false;
  const expiry = new Date(token.expires_at).getTime();
  return Date.now() + bufferMs >= expiry;
}

export function buildTokenExchangeParams(params: {
  code: string;
  redirectUri: string;
  clientId: string;
  codeVerifier: string;
  clientSecret?: string;
  clientAuth?: string;
}): { body: URLSearchParams; headers: Record<string, string> } {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    code_verifier: params.codeVerifier,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  applyClientAuth(body, headers, params.clientId, params.clientSecret, params.clientAuth);

  return { body, headers };
}

export function buildRefreshParams(params: {
  refreshToken: string;
  clientId: string;
  clientSecret?: string;
  clientAuth?: string;
  scopes?: string[];
}): { body: URLSearchParams; headers: Record<string, string> } {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: params.refreshToken,
    client_id: params.clientId,
  });

  if (params.scopes?.length) {
    body.set('scope', params.scopes.join(' '));
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  applyClientAuth(body, headers, params.clientId, params.clientSecret, params.clientAuth);

  return { body, headers };
}

export function buildRevocationParams(params: {
  token: string;
  clientId: string;
  tokenTypeHint?: 'access_token' | 'refresh_token';
}): { body: URLSearchParams } {
  const body = new URLSearchParams({
    token: params.token,
    client_id: params.clientId,
  });

  if (params.tokenTypeHint) {
    body.set('token_type_hint', params.tokenTypeHint);
  }

  return { body };
}

function applyClientAuth(
  body: URLSearchParams,
  headers: Record<string, string>,
  clientId: string,
  clientSecret?: string,
  clientAuth?: string,
): void {
  if (!clientSecret || clientAuth === 'none') return;

  if (clientAuth === 'client_secret_basic') {
    const encoded = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    headers.Authorization = `Basic ${encoded}`;
  } else {
    body.set('client_secret', clientSecret);
  }
}
