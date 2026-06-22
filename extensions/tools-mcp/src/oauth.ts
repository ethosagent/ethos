import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { validateUrl as validateSsrfUrl } from '@ethosagent/core';
import {
  buildOAuthMetadataUrl,
  buildProtectedResourceMetadataUrl,
  buildRefreshParams,
  buildRevocationParams,
  buildTokenExchangeParams,
  buildAuthorizationUrl as coreAuthUrl,
  generateCodeChallenge,
  generateCodeVerifier,
  parseOAuthServerMetadata,
  parseTokenResponse,
} from '@ethosagent/oauth-core';
import { safeFetch } from '@ethosagent/safety-network';
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
// Error classes
// ---------------------------------------------------------------------------

export class OAuthDiscoveryError extends Error {
  constructor(
    public readonly attemptedUrls: { url: string; status: number | null }[],
    message?: string,
  ) {
    super(message ?? `OAuth discovery failed for: ${attemptedUrls.map((u) => u.url).join(', ')}`);
    this.name = 'OAuthDiscoveryError';
  }
}

export class ConfidentialClientUnsupported extends Error {
  constructor(serverUrl: string) {
    super(
      `MCP server at ${serverUrl} returned a client_secret (confidential client).` +
        ` Use 'ethos mcp add' from the CLI.`,
    );
    this.name = 'ConfidentialClientUnsupported';
  }
}

/**
 * Thrown by the install flow when OAuth discovery succeeds but the server
 * doesn't advertise a `registration_endpoint`. The UI install flow only
 * supports dynamic client registration (RFC 7591); servers without DCR
 * require manual configuration via the CLI's `ethos mcp add` command.
 */
export class DcrUnsupported extends Error {
  constructor(public readonly mcpUrl: string) {
    super(
      `MCP server at ${mcpUrl} does not advertise a registration_endpoint.` +
        ` The UI install flow requires dynamic client registration (RFC 7591).` +
        ` Use 'ethos mcp add' from the CLI to configure the server manually.`,
    );
    this.name = 'DcrUnsupported';
  }
}

export class MissingToken extends Error {
  constructor(public readonly serverName: string) {
    super(
      `No OAuth token available for MCP server '${serverName}'.` +
        ' Re-authorize from the UI or CLI.',
    );
    this.name = 'MissingToken';
  }
}

// ---------------------------------------------------------------------------
// Discovery & registration interfaces
// ---------------------------------------------------------------------------

export interface DiscoveredOAuthMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  introspection_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
}

export interface DcrRequest {
  redirect_uris: string[];
  client_name: string;
  token_endpoint_auth_method: 'none';
  grant_types: ['authorization_code', 'refresh_token'];
  response_types: ['code'];
  scope?: string;
}

export interface DcrResponse {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  registration_access_token?: string;
  registration_client_uri?: string;
}

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

export { generateCodeChallenge, generateCodeVerifier } from '@ethosagent/oauth-core';

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
// OAuth state store (single-use, time-limited)
// ---------------------------------------------------------------------------

const STATE_TTL_MS = 300_000; // 5 minutes

interface PendingState {
  createdAt: number;
}

const pendingStates = new Map<string, PendingState>();

/** Store a state value before redirecting to the auth provider. */
export function registerOAuthState(state: string): void {
  pendingStates.set(state, { createdAt: Date.now() });
}

/** Validate and consume a state value returned by the callback. Returns true if valid. */
export function consumeOAuthState(state: string): boolean {
  const entry = pendingStates.get(state);
  if (!entry) return false;
  pendingStates.delete(state);
  if (Date.now() - entry.createdAt > STATE_TTL_MS) return false;
  return true;
}

/** Remove expired entries (housekeeping, called on each callback). */
function pruneExpiredStates(): void {
  const now = Date.now();
  for (const [key, entry] of pendingStates) {
    if (now - entry.createdAt > STATE_TTL_MS) {
      pendingStates.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Local callback listener
// ---------------------------------------------------------------------------

const CALLBACK_PATH = '/oauth/callback';

export interface CallbackResult {
  port: number;
  redirectUri: string;
  resultPromise: Promise<{ code: string; state: string | null }>;
  close: () => void;
}

export async function startCallbackServer(): Promise<CallbackResult> {
  return new Promise((resolveServer, rejectServer) => {
    let settled = false;
    let resolveResult: (result: { code: string; state: string | null }) => void;
    let rejectResult: (err: Error) => void;

    const resultPromise = new Promise<{ code: string; state: string | null }>((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (settled) {
        res.writeHead(400);
        res.end('Already handled');
        return;
      }

      // Restrict to GET method only (OAuth callbacks are always GET redirects)
      if (req.method !== 'GET') {
        res.writeHead(405);
        res.end('Method not allowed');
        return;
      }

      const url = new URL(req.url ?? '/', `http://127.0.0.1`);

      // Restrict to the exact callback path
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        settled = true;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<html><body><h1>Authorization failed</h1><p>You may close this tab.</p></body></html>',
        );
        rejectResult(new Error(`OAuth error: ${error}`));
        closeServer();
        return;
      }

      if (!code) {
        res.writeHead(400);
        res.end('Missing code parameter');
        return;
      }

      // Validate the state parameter (CSRF protection)
      pruneExpiredStates();
      if (!state || !consumeOAuthState(state)) {
        res.writeHead(400);
        res.end('Invalid or expired state parameter');
        return;
      }

      settled = true;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        '<html><body><h1>Authorization successful</h1><p>You may close this tab.</p></body></html>',
      );
      resolveResult({ code, state });
      closeServer();
    });

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        rejectResult(new Error('OAuth callback timed out after 120s'));
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
        redirectUri: `http://127.0.0.1:${addr.port}${CALLBACK_PATH}`,
        resultPromise,
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
  return coreAuthUrl({
    authorizationEndpoint: config.authorization_endpoint,
    clientId: config.client_id,
    redirectUri,
    state,
    codeChallenge,
    scopes: config.scopes,
  });
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
  validateSsrfUrl(config.token_endpoint);

  const { body, headers } = buildTokenExchangeParams({
    code,
    redirectUri,
    clientId: config.client_id,
    codeVerifier,
  });

  const fetchResult = await safeFetch(config.token_endpoint, {
    policy: {},
    init: {
      method: 'POST',
      headers,
      body: body.toString(),
    },
  });
  if (!fetchResult.ok) throw new Error(`Token exchange blocked: ${fetchResult.reason}`);
  const resp = fetchResult.response;

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token exchange failed (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  const parsed = parseTokenResponse(data);

  const tokens: TokenSet = { access_token: parsed.access_token };
  if (parsed.refresh_token) tokens.refresh_token = parsed.refresh_token;
  if (parsed.expires_at) tokens.expires_at = parsed.expires_at;
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
  // SSRF gate: validate token endpoint before sending credentials
  validateSsrfUrl(config.token_endpoint);

  // Single read — no exists() check first (TOCTOU-safe)
  const currentRefreshToken = await secrets.get(refreshTokenRef(serverName));
  if (!currentRefreshToken) {
    throw new Error(`No refresh token available for MCP server '${serverName}'`);
  }

  const { body, headers: refreshHeaders } = buildRefreshParams({
    refreshToken: currentRefreshToken,
    clientId: config.client_id,
  });

  const refreshFetchResult = await safeFetch(config.token_endpoint, {
    policy: {},
    init: {
      method: 'POST',
      headers: refreshHeaders,
      body: body.toString(),
    },
  });
  if (!refreshFetchResult.ok)
    throw new Error(`Token refresh blocked: ${refreshFetchResult.reason}`);
  const resp = refreshFetchResult.response;

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
    // SSRF gate: validate revocation endpoint before sending token
    validateSsrfUrl(config.revocation_endpoint);
    const token = await secrets.get(accessTokenRef(serverName));
    if (token) {
      const { body } = buildRevocationParams({
        token,
        clientId: config.client_id,
      });
      // Best-effort revocation — don't fail if endpoint is down or blocked
      await safeFetch(config.revocation_endpoint, {
        policy: {},
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        },
      }).catch(() => {});
    }
  }
  await deleteTokens(serverName, secrets);
}

// ---------------------------------------------------------------------------
// OAuth discovery (RFC 8414 + MCP protected-resource)
// ---------------------------------------------------------------------------

export async function discoverOAuthMetadata(mcpUrl: string): Promise<DiscoveredOAuthMetadata> {
  const attemptedUrls: { url: string; status: number | null }[] = [];

  let issuer = new URL(mcpUrl).origin;
  const protectedResourceUrl = buildProtectedResourceMetadataUrl(mcpUrl);
  try {
    const prFetchResult = await safeFetch(protectedResourceUrl, { policy: {} });
    if (prFetchResult.ok) {
      const prResp = prFetchResult.response;
      attemptedUrls.push({ url: protectedResourceUrl, status: prResp.status });
      if (prResp.ok) {
        const prData = (await prResp.json()) as { authorization_servers?: string[] };
        const firstServer = prData.authorization_servers?.[0];
        if (firstServer) {
          issuer = firstServer;
        }
      }
    } else {
      attemptedUrls.push({ url: protectedResourceUrl, status: null });
    }
  } catch {
    attemptedUrls.push({ url: protectedResourceUrl, status: null });
  }

  const asMeta = buildOAuthMetadataUrl(issuer);
  try {
    const asFetchResult = await safeFetch(asMeta, { policy: {} });
    if (!asFetchResult.ok) {
      attemptedUrls.push({ url: asMeta, status: null });
      throw new OAuthDiscoveryError(attemptedUrls);
    }
    const asResp = asFetchResult.response;
    attemptedUrls.push({ url: asMeta, status: asResp.status });
    if (!asResp.ok) {
      throw new OAuthDiscoveryError(attemptedUrls);
    }
    const raw = await asResp.json();

    let validated: ReturnType<typeof parseOAuthServerMetadata>;
    try {
      validated = parseOAuthServerMetadata(raw);
    } catch (parseErr) {
      throw new OAuthDiscoveryError(
        attemptedUrls,
        parseErr instanceof Error ? parseErr.message : String(parseErr),
      );
    }

    return {
      authorization_endpoint: validated.authorization_endpoint,
      token_endpoint: validated.token_endpoint,
      registration_endpoint: validated.registration_endpoint,
      revocation_endpoint: validated.revocation_endpoint,
      introspection_endpoint: validated.introspection_endpoint,
      scopes_supported: validated.scopes_supported,
      code_challenge_methods_supported: validated.code_challenge_methods_supported,
    };
  } catch (err) {
    if (err instanceof OAuthDiscoveryError) throw err;
    attemptedUrls.push({ url: asMeta, status: null });
    throw new OAuthDiscoveryError(attemptedUrls);
  }
}

// ---------------------------------------------------------------------------
// Dynamic client registration
// ---------------------------------------------------------------------------

export async function registerOAuthClient(
  registrationEndpoint: string,
  request: DcrRequest,
): Promise<DcrResponse> {
  const dcrFetchResult = await safeFetch(registrationEndpoint, {
    policy: {},
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    },
  });
  if (!dcrFetchResult.ok)
    throw new Error(`Dynamic client registration blocked: ${dcrFetchResult.reason}`);
  const resp = dcrFetchResult.response;

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Dynamic client registration failed (${resp.status}): ${text}`);
  }

  const data = (await resp.json()) as DcrResponse;

  if (!data.client_id || typeof data.client_id !== 'string') {
    throw new Error('Dynamic client registration response missing required client_id');
  }

  if (data.client_secret) {
    throw new ConfidentialClientUnsupported(registrationEndpoint);
  }

  return data;
}

// ---------------------------------------------------------------------------
// DCR + PKCE authorization flow
// ---------------------------------------------------------------------------

export interface DcrAuthorizationResult {
  tokens: TokenSet;
  dcrResult: DcrResponse;
  meta: DiscoveredOAuthMetadata;
  oauthConfig: OAuthConfig;
}

export async function runDcrAuthorization(
  mcpUrl: string,
  clientName: string,
  onAuthUrl?: (url: string) => void,
): Promise<DcrAuthorizationResult> {
  const meta = await discoverOAuthMetadata(mcpUrl);

  if (!meta.registration_endpoint) {
    throw new Error('MCP server does not support dynamic client registration');
  }

  const callback = await startCallbackServer();
  const redirectUri = `http://127.0.0.1:${callback.port}`;

  try {
    const dcrRequest: DcrRequest = {
      redirect_uris: [redirectUri],
      client_name: clientName,
      token_endpoint_auth_method: 'none' as const,
      grant_types: ['authorization_code', 'refresh_token'] as [
        'authorization_code',
        'refresh_token',
      ],
      response_types: ['code'] as ['code'],
    };

    const dcrResult = await registerOAuthClient(meta.registration_endpoint, dcrRequest);

    const oauthConfig: OAuthConfig = {
      authorization_endpoint: meta.authorization_endpoint,
      token_endpoint: meta.token_endpoint,
      client_id: dcrResult.client_id,
    };

    const verifier = generateCodeVerifier();
    const challenge = generateCodeChallenge(verifier);
    const state = randomBytes(16).toString('base64url');

    // Register state for CSRF validation before redirecting
    registerOAuthState(state);

    const authUrl = buildAuthorizationUrl(oauthConfig, redirectUri, state, challenge);

    if (onAuthUrl) {
      onAuthUrl(authUrl);
    } else {
      process.stderr.write(`\nOpen this URL to authorize:\n${authUrl}\n\n`);
    }

    const result = await callback.resultPromise;

    if (result.state !== state) {
      throw new Error('OAuth state mismatch — possible CSRF attack');
    }

    const tokens = await exchangeCode(oauthConfig, result.code, redirectUri, verifier);

    return { tokens, dcrResult, meta, oauthConfig };
  } finally {
    callback.close();
  }
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
  const redirectUri = callback.redirectUri;

  // Register state for CSRF validation before redirecting
  registerOAuthState(state);

  const authUrl = buildAuthorizationUrl(config, redirectUri, state, challenge);

  // Log the URL so the user can open it (CLI wiring prints this)
  process.stderr.write(`\nOpen this URL to authorize:\n${authUrl}\n\n`);

  try {
    const result = await callback.resultPromise;
    if (result.state !== state) {
      throw new Error('OAuth state mismatch — possible CSRF attack. Aborting.');
    }
    const tokens = await exchangeCode(config, result.code, redirectUri, verifier);
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
  context: 'cli' | 'ui' = 'cli',
): Promise<string> {
  const token = await secrets.get(accessTokenRef(serverName));

  if (!token) {
    if (context === 'ui') {
      throw new MissingToken(serverName);
    }
    const tokens = await runPkceLogin(serverName, config, secrets);
    return tokens.access_token;
  }

  const expired = await isTokenExpired(serverName, secrets);
  if (expired) {
    return refreshToken(serverName, config, secrets);
  }

  return token;
}
