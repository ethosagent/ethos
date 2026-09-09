import { createHash, createSign } from 'node:crypto';
import type { ScopedSecretsResolver } from '@ethosagent/types';
import { DEFAULT_TOKEN_URI, SCOPE, TOKEN_HOST } from './constants';
import { ServiceAccountJsonError, TokenMintError } from './errors';

// ---------------------------------------------------------------------------
// Google service-account auth: parse the JSON key, RS256-sign a JWT assertion,
// exchange it for an access token, cache the token in process.
//
// The OAuth 2.0 service-account flow has no refresh token and the key itself
// does not expire — a token costs one signature and one POST to re-mint, which
// is why this deliberately does NOT adopt `extensions/oauth` (D10). Its
// `refreshLocks` PATTERN is borrowed for coalescing (D30); its machinery is not.
// ---------------------------------------------------------------------------

/** Minimal fetch shape — matches `ScopedFetch.fetch` from `@ethosagent/types`. */
export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface ServiceAccount {
  clientEmail: string;
  /** PEM RSA private key. Never logged, never rendered, never cached as a key. */
  privateKey: string;
  tokenUri: string;
}

/**
 * Parse a Google service-account JSON key. Refuses with a
 * `ServiceAccountJsonError` naming the missing field rather than letting a raw
 * `JSON.parse` throw or a `TypeError` on an absent property reach the model.
 */
export function parseServiceAccountJson(raw: string): ServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ServiceAccountJsonError(
      'The stored Google Search Console credential is not valid JSON. Paste the whole service-account JSON key file, unmodified.',
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ServiceAccountJsonError(
      'The stored Google Search Console credential is not a JSON object. Paste the whole service-account JSON key file, unmodified.',
    );
  }
  const obj = parsed as Record<string, unknown>;

  const clientEmail = typeof obj.client_email === 'string' ? obj.client_email.trim() : '';
  if (!clientEmail) {
    throw new ServiceAccountJsonError(
      'The stored Google Search Console credential is missing "client_email". Paste the whole service-account JSON key file, unmodified.',
    );
  }
  const privateKey = typeof obj.private_key === 'string' ? obj.private_key.trim() : '';
  if (!privateKey) {
    throw new ServiceAccountJsonError(
      'The stored Google Search Console credential is missing "private_key". Paste the whole service-account JSON key file, unmodified.',
    );
  }

  // `token_uri` comes out of an operator-supplied vault value and becomes a
  // request URL, so it is pinned to Google's mint host here rather than left
  // for `ScopedFetch` to refuse: that refusal surfaces as HOST_NOT_ALLOWED,
  // whose message tells the operator to widen `safety.network.allow` — the
  // wrong fix for a credential naming the wrong endpoint.
  const tokenUri = typeof obj.token_uri === 'string' && obj.token_uri ? obj.token_uri : undefined;
  if (tokenUri && !isGoogleTokenUri(tokenUri)) {
    throw new ServiceAccountJsonError(
      `The stored Google Search Console credential names an unexpected "token_uri" — only ${TOKEN_HOST} is accepted. Paste the whole service-account JSON key file, unmodified.`,
    );
  }

  return { clientEmail, privateKey, tokenUri: tokenUri ?? DEFAULT_TOKEN_URI };
}

function isGoogleTokenUri(value: string): boolean {
  try {
    return new URL(value).hostname === TOKEN_HOST;
  } catch {
    return false;
  }
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Build the RS256-signed JWT assertion Google's service-account flow expects:
 * `base64url(header).base64url(claims).base64url(signature)`, signed with
 * `node:crypto` — no third-party JWT library (§6.1).
 */
export function buildAssertion(sa: ServiceAccount, nowMs: number = Date.now()): string {
  const iat = Math.floor(nowMs / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = { iss: sa.clientEmail, scope: SCOPE, aud: sa.tokenUri, exp: iat + 3600, iat };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  return `${signingInput}.${base64url(signer.sign(sa.privateKey))}`;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
}

/**
 * One token exchange. No cache, no coalescing — `getAccessToken` owns both.
 * Exported because the vault probe wants a fresh mint every time an operator
 * presses "test key".
 */
export async function mintAccessToken(
  sa: ServiceAccount,
  fetchFn: FetchLike,
  signal?: AbortSignal,
): Promise<{ token: string; expiresAt: number }> {
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: buildAssertion(sa),
  });
  const response = await fetchFn(sa.tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new TokenMintError(response.status, await response.text().catch(() => ''));
  }
  const data = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!data.access_token) {
    throw new TokenMintError(response.status, '{"error":"invalid_grant"}');
  }
  return {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
}

/** Reuse a cached token only while this much of its life is left. Larger than
 *  `tools-reddit`'s 30s: a `gsc_sites` + `gsc_queries` fan-out must not cross
 *  an expiry mid-flight (§6.4). */
export const EXPIRY_SAFETY_MARGIN_MS = 5 * 60_000;

interface CacheEntry {
  token?: string;
  /** Absolute expiry as Google declared it — the margin is applied on read. */
  expiresAt?: number;
  /** An exchange already in flight for this credential (D30). */
  inFlight?: Promise<{ token: string; expiresAt: number }>;
}

/**
 * In-process token cache. Keyed by a HASH of the private key plus the scope,
 * never by `client_email` (D31): rotating a compromised key keeps the SAME
 * client_email, so an email-keyed cache would keep serving the revoked key's
 * token for up to 55 minutes after the rotation. Nothing is persisted, and the
 * PEM itself never leaves this module.
 */
const tokenCache = new Map<string, CacheEntry>();

function cacheKey(sa: ServiceAccount): string {
  return `${createHash('sha256').update(sa.privateKey).digest('hex')}\n${SCOPE}`;
}

/** Test seam — the cache is module state, so a suite exercising hit/miss must
 *  be able to start from empty. */
export function clearTokenCache(): void {
  tokenCache.clear();
}

/**
 * A usable access token for this credential, minting one only when the cache
 * has nothing fresh. Concurrent callers on a cold cache await ONE exchange:
 * `gsc_sites` and `gsc_queries` in a single `executeParallel` batch is the
 * ordinary case, not an edge one (D30).
 */
export async function getAccessToken(
  sa: ServiceAccount,
  fetchFn: FetchLike,
  signal?: AbortSignal,
): Promise<string> {
  const key = cacheKey(sa);
  const entry = tokenCache.get(key);
  if (entry?.token && entry.expiresAt && Date.now() < entry.expiresAt - EXPIRY_SAFETY_MARGIN_MS) {
    return entry.token;
  }
  if (entry?.inFlight) return (await entry.inFlight).token;

  const inFlight = mintAccessToken(sa, fetchFn, signal);
  tokenCache.set(key, { inFlight });
  try {
    const minted = await inFlight;
    tokenCache.set(key, { token: minted.token, expiresAt: minted.expiresAt });
    return minted.token;
  } catch (err) {
    // A failed mint must not leave a permanently-awaited promise behind.
    tokenCache.delete(key);
    throw err;
  }
}

/**
 * Read the bound service-account credential out of the vault.
 *
 * The secret read gets its OWN try/catch (D32). `ScopedSecretsImpl.get`
 * (packages/core/src/scoped/scoped-secrets.ts) has no try/catch of its own and
 * the wiring backend THROWS `Secret <ref> not found`
 * (packages/wiring/src/build-infrastructure.ts) — so a generic catch would
 * return the RAW VAULT REF in assistant-visible text, which
 * `scoped-secrets.ts`'s own comment says must not happen. `null` here means
 * "no credential", and the caller answers with NO_KEY_MESSAGE; `err.message`
 * is never echoed. A malformed credential still throws, because that is a
 * different answer.
 */
export async function readServiceAccount(
  secrets: ScopedSecretsResolver,
  ref: string,
): Promise<ServiceAccount | null> {
  let raw: string;
  try {
    raw = await secrets.get(ref);
  } catch {
    return null;
  }
  // An empty stored value is "no credential" too — distinct from the throw
  // above, which is the missing-ref case.
  if (!raw.trim()) return null;
  return parseServiceAccountJson(raw);
}
