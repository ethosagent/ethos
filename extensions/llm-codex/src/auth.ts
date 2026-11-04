import { readFile } from 'node:fs/promises';
import { z } from 'zod';
export interface CodexCredentials {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accountId: string;
  expiresAt: string;
  updatedAt: string;
}

export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

const AUTH_BASE = 'https://auth.openai.com';
const DEVICE_CODE_URL = `${AUTH_BASE}/api/accounts/deviceauth/usercode`;
const POLL_URL = `${AUTH_BASE}/api/accounts/deviceauth/token`;
const TOKEN_URL = `${AUTH_BASE}/oauth/token`;
const REDIRECT_URI = `${AUTH_BASE}/deviceauth/callback`;

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 15 * 60 * 1_000;

type FetchFn = typeof globalThis.fetch;

// ---------------------------------------------------------------------------
// Step 1 — request device code
// ---------------------------------------------------------------------------

export interface DeviceCodeResponse {
  deviceAuthId: string;
  userCode: string;
}

export async function requestDeviceCode(fetchFn: FetchFn): Promise<DeviceCodeResponse> {
  const res = await fetchFn(DEVICE_CODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Device code request failed (${res.status}): ${body}`);
  }

  const json = (await res.json()) as {
    device_auth_id: string;
    user_code: string;
  };
  return {
    deviceAuthId: json.device_auth_id,
    userCode: json.user_code,
  };
}

// ---------------------------------------------------------------------------
// Step 3 — poll for authorization
// ---------------------------------------------------------------------------

export interface AuthorizationResponse {
  authorizationCode: string;
  codeVerifier: string;
}

export async function pollForAuthorization(
  fetchFn: FetchFn,
  deviceAuthId: string,
  userCode: string,
  signal?: AbortSignal,
): Promise<AuthorizationResponse> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    signal?.throwIfAborted();

    const res = await fetchFn(POLL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_auth_id: deviceAuthId,
        user_code: userCode,
      }),
      signal,
    });

    if (res.ok) {
      const json = (await res.json()) as {
        authorization_code: string;
        code_verifier: string;
      };
      return {
        authorizationCode: json.authorization_code,
        codeVerifier: json.code_verifier,
      };
    }

    // 403 means the user hasn't authorized yet — keep polling
    if (res.status === 403) {
      await sleep(POLL_INTERVAL_MS, signal);
      continue;
    }

    const body = await res.text();
    throw new Error(`Authorization poll failed (${res.status}): ${body}`);
  }

  throw new Error('Authorization timed out after 15 minutes');
}

// ---------------------------------------------------------------------------
// Step 4 — exchange authorization code for tokens
// ---------------------------------------------------------------------------

export async function exchangeForTokens(
  fetchFn: FetchFn,
  authorizationCode: string,
  codeVerifier: string,
): Promise<CodexCredentials> {
  const res = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: CODEX_CLIENT_ID,
      code: authorizationCode,
      code_verifier: codeVerifier,
      redirect_uri: REDIRECT_URI,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${body}`);
  }

  const json = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    id_token: string;
  };

  const now = new Date().toISOString();
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    idToken: json.id_token,
    accountId: extractAccountId(json.id_token),
    expiresAt: extractExpiresAt(json.access_token),
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

export async function refreshTokens(
  fetchFn: FetchFn,
  refreshToken: string,
): Promise<CodexCredentials> {
  const res = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CODEX_CLIENT_ID,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${body}`);
  }

  const json = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    id_token: string;
  };

  const now = new Date().toISOString();
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    idToken: json.id_token,
    accountId: extractAccountId(json.id_token),
    expiresAt: extractExpiresAt(json.access_token),
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Proactive refresh — check JWT exp claim
// ---------------------------------------------------------------------------

export function isTokenExpiringSoon(credentials: CodexCredentials, bufferSeconds = 120): boolean {
  try {
    const parts = credentials.accessToken.split('.');
    const payload = parts[1];
    if (!payload) return true;

    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as {
      exp?: number;
    };

    if (typeof decoded.exp !== 'number') return true;

    const nowSeconds = Math.floor(Date.now() / 1_000);
    return decoded.exp - nowSeconds <= bufferSeconds;
  } catch {
    // If we can't decode the JWT, treat it as expiring
    return true;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const optStr = z.string().min(1).optional().catch(undefined);

/** One token bag: snake_case (Codex CLI, Hermes) or camelCase keys. */
const TokenBagSchema = z.object({
  access_token: optStr,
  accessToken: optStr,
  refresh_token: optStr,
  refreshToken: optStr,
  id_token: optStr,
  idToken: optStr,
  account_id: optStr,
  accountId: optStr,
  expires_at: optStr,
  expiresAt: optStr,
  updated_at: optStr,
  updatedAt: optStr,
  last_refresh: optStr,
});

/**
 * Accepted file shapes:
 *  - flat: the token keys at the top level (Hermes, older Ethos exports);
 *  - nested: `{ "tokens": { access_token, refresh_token, id_token, account_id },
 *    "last_refresh": "<iso>" }`, the Codex CLI's `~/.codex/auth.json`.
 *
 * UNVERIFIED against the real CLI: no Codex source or real auth.json is
 * available in this repo and this code never reads a user's credential file
 * in tests. The nested shape is taken from the Codex CLI's documented
 * layout as remembered; pinned by fixtures in
 * `__tests__/import-shape.test.ts` only.
 */
const AuthFileSchema = z
  .object({ tokens: TokenBagSchema.optional().catch(undefined) })
  .and(TokenBagSchema);

async function parseAuthFile(filePath: string): Promise<CodexCredentials | null> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed = AuthFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    const top = parsed.data;
    const bag = top.tokens ?? top;

    const accessToken = bag.access_token ?? bag.accessToken;
    const refreshTokenVal = bag.refresh_token ?? bag.refreshToken;
    const idToken = bag.id_token ?? bag.idToken;
    if (!accessToken || !refreshTokenVal || !idToken) return null;

    const now = new Date().toISOString();
    return {
      accessToken,
      refreshToken: refreshTokenVal,
      idToken,
      accountId: bag.account_id ?? bag.accountId ?? extractAccountId(idToken),
      expiresAt: bag.expires_at ?? bag.expiresAt ?? extractExpiresAt(accessToken),
      updatedAt: bag.updated_at ?? bag.updatedAt ?? top.last_refresh ?? bag.last_refresh ?? now,
    };
  } catch {
    return null;
  }
}

/** Import credentials from a Codex CLI or Hermes auth.json file (flat or nested). */
export async function importFromFile(filePath: string): Promise<CodexCredentials | null> {
  return parseAuthFile(filePath);
}

/**
 * Whether `filePath` holds an importable login. Returns presence only, never
 * token material (the probe result type has no token field; pinned by
 * `__tests__/import-shape.test.ts` "detectExternalLogin reports presence only").
 */
export async function detectExternalLogin(filePath: string): Promise<{ present: true } | null> {
  return (await parseAuthFile(filePath)) ? { present: true } : null;
}

/** Extract the account ID (sub claim) from an id_token JWT. */
function extractAccountId(idToken: string): string {
  try {
    const parts = idToken.split('.');
    const payload = parts[1];
    if (!payload) return '';

    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as {
      sub?: string;
    };
    return decoded.sub ?? '';
  } catch {
    return '';
  }
}

/** Extract the expiration as an ISO string from an access_token JWT. */
function extractExpiresAt(accessToken: string): string {
  try {
    const parts = accessToken.split('.');
    const payload = parts[1];
    if (!payload) return new Date().toISOString();

    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as {
      exp?: number;
    };

    if (typeof decoded.exp !== 'number') return new Date().toISOString();
    return new Date(decoded.exp * 1_000).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

/** Sleep that respects an AbortSignal. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }

    const timer = setTimeout(resolve, ms);

    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
