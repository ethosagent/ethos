import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { SecretsResolver } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OAuthConfig {
  authorization_endpoint: string;
  token_endpoint: string;
  client_id: string;
  scopes?: string[];
  revocation_endpoint?: string;
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_at?: string;
}

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

export function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

export function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

// ---------------------------------------------------------------------------
// Secret key helpers (TOCTOU-safe: single get/set per operation)
// ---------------------------------------------------------------------------

function accessTokenRef(serverName: string): string {
  return `mcp/${serverName}/access_token`;
}

function refreshTokenRef(serverName: string): string {
  return `mcp/${serverName}/refresh_token`;
}

function expiresAtRef(serverName: string): string {
  return `mcp/${serverName}/expires_at`;
}

// ---------------------------------------------------------------------------
// Token storage
// ---------------------------------------------------------------------------

export async function storeTokens(
  serverName: string,
  tokens: TokenSet,
  secrets: SecretsResolver,
): Promise<void> {
  await secrets.set(accessTokenRef(serverName), tokens.access_token);
  if (tokens.refresh_token) {
    await secrets.set(refreshTokenRef(serverName), tokens.refresh_token);
  }
  if (tokens.expires_at) {
    await secrets.set(expiresAtRef(serverName), tokens.expires_at);
  }
}

export async function loadAccessToken(
  serverName: string,
  secrets: SecretsResolver,
): Promise<string | null> {
  return secrets.get(accessTokenRef(serverName));
}

export async function deleteTokens(serverName: string, secrets: SecretsResolver): Promise<void> {
  await secrets.delete(accessTokenRef(serverName));
  await secrets.delete(refreshTokenRef(serverName));
  await secrets.delete(expiresAtRef(serverName));
}

// ---------------------------------------------------------------------------
// Token expiry check (TOCTOU-safe: single read, no exists→get pattern)
// ---------------------------------------------------------------------------

export async function isTokenExpired(
  serverName: string,
  secrets: SecretsResolver,
  bufferMs = 60_000,
): Promise<boolean> {
  const expiresAt = await secrets.get(expiresAtRef(serverName));
  if (!expiresAt) return false; // no expiry tracked — assume valid
  const expiry = new Date(expiresAt).getTime();
  return Date.now() + bufferMs >= expiry;
}

// ---------------------------------------------------------------------------
// Local callback listener
// ---------------------------------------------------------------------------

export interface CallbackResult {
  port: number;
  codePromise: Promise<string>;
  close: () => void;
}

export async function startCallbackServer(): Promise<CallbackResult> {
  return new Promise((resolveServer, rejectServer) => {
    let settled = false;
    let resolveCode: (code: string) => void;
    let rejectCode: (err: Error) => void;

    const codePromise = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (settled) {
        res.writeHead(400);
        res.end('Already handled');
        return;
      }

      const url = new URL(req.url ?? '/', `http://127.0.0.1`);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        settled = true;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<html><body><h1>Authorization failed</h1><p>You may close this tab.</p></body></html>',
        );
        rejectCode(new Error(`OAuth error: ${error}`));
        closeServer();
        return;
      }

      if (!code) {
        res.writeHead(400);
        res.end('Missing code parameter');
        return;
      }

      settled = true;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        '<html><body><h1>Authorization successful</h1><p>You may close this tab.</p></body></html>',
      );
      resolveCode(code);
      closeServer();
    });

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        rejectCode(new Error('OAuth callback timed out after 120s'));
        closeServer();
      }
    }, 120_000);

    function closeServer(): void {
      clearTimeout(timeout);
      server.close();
    }

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        rejectServer(new Error('Failed to bind callback server'));
        return;
      }
      resolveServer({
        port: addr.port,
        codePromise,
        close: closeServer,
      });
    });

    server.on('error', (err) => {
      rejectServer(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Authorization URL
// ---------------------------------------------------------------------------

export function buildAuthorizationUrl(
  config: OAuthConfig,
  redirectUri: string,
  state: string,
  codeChallenge: string,
): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.client_id,
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  if (config.scopes?.length) {
    params.set('scope', config.scopes.join(' '));
  }
  return `${config.authorization_endpoint}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

export async function exchangeCode(
  config: OAuthConfig,
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: config.client_id,
    code_verifier: codeVerifier,
  });

  const resp = await fetch(config.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token exchange failed (${resp.status}): ${text}`);
  }

  const data = (await resp.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const tokens: TokenSet = { access_token: data.access_token };
  if (data.refresh_token) tokens.refresh_token = data.refresh_token;
  if (data.expires_in) {
    tokens.expires_at = new Date(Date.now() + data.expires_in * 1000).toISOString();
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Refresh flow
// ---------------------------------------------------------------------------

export async function refreshToken(
  serverName: string,
  config: OAuthConfig,
  secrets: SecretsResolver,
): Promise<string> {
  // Single read — no exists() check first (TOCTOU-safe)
  const currentRefreshToken = await secrets.get(refreshTokenRef(serverName));
  if (!currentRefreshToken) {
    throw new Error(`No refresh token available for MCP server '${serverName}'`);
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: currentRefreshToken,
    client_id: config.client_id,
  });

  const resp = await fetch(config.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token refresh failed (${resp.status}): ${text}`);
  }

  const data = (await resp.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  // Atomic store — single set call per secret (TOCTOU-safe)
  await secrets.set(accessTokenRef(serverName), data.access_token);
  if (data.refresh_token) {
    await secrets.set(refreshTokenRef(serverName), data.refresh_token);
  }
  if (data.expires_in) {
    await secrets.set(
      expiresAtRef(serverName),
      new Date(Date.now() + data.expires_in * 1000).toISOString(),
    );
  }

  return data.access_token;
}

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

export async function revokeToken(
  serverName: string,
  config: OAuthConfig,
  secrets: SecretsResolver,
): Promise<void> {
  if (config.revocation_endpoint) {
    const token = await secrets.get(accessTokenRef(serverName));
    if (token) {
      const body = new URLSearchParams({
        token,
        client_id: config.client_id,
      });
      // Best-effort revocation — don't fail if endpoint is down
      await fetch(config.revocation_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      }).catch(() => {});
    }
  }
  await deleteTokens(serverName, secrets);
}

// ---------------------------------------------------------------------------
// Full PKCE login flow
// ---------------------------------------------------------------------------

export async function runPkceLogin(
  serverName: string,
  config: OAuthConfig,
  secrets: SecretsResolver,
): Promise<TokenSet> {
  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  const state = randomBytes(16).toString('base64url');

  const callback = await startCallbackServer();
  const redirectUri = `http://127.0.0.1:${callback.port}`;

  const authUrl = buildAuthorizationUrl(config, redirectUri, state, challenge);

  // Log the URL so the user can open it (CLI wiring prints this)
  process.stderr.write(`\nOpen this URL to authorize:\n${authUrl}\n\n`);

  try {
    const code = await callback.codePromise;
    const tokens = await exchangeCode(config, code, redirectUri, verifier);
    await storeTokens(serverName, tokens, secrets);
    return tokens;
  } finally {
    callback.close();
  }
}

// ---------------------------------------------------------------------------
// Ensure valid token (for transport integration)
// ---------------------------------------------------------------------------

export async function ensureValidToken(
  serverName: string,
  config: OAuthConfig,
  secrets: SecretsResolver,
): Promise<string> {
  // Single read — TOCTOU-safe
  const token = await secrets.get(accessTokenRef(serverName));

  if (!token) {
    const tokens = await runPkceLogin(serverName, config, secrets);
    return tokens.access_token;
  }

  const expired = await isTokenExpired(serverName, secrets);
  if (expired) {
    return refreshToken(serverName, config, secrets);
  }

  return token;
}
