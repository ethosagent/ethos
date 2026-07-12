// A2A access tokens — sender-constrained EdDSA JWTs (plan §9 / O11).
//
// A token is minted by the TARGET agent's Ed25519 key and presented by the peer
// on every `/a2a` request. It is sender-constrained per RFC 7800: the `cnf.jkt`
// claim binds the token to the peer's key fingerprint, so a stolen token
// without the peer's private key is inert (the per-REQUEST proof-of-possession
// that enforces this end-to-end lands in Phase 5; Phase 4 mints the binding and
// validates it here).
//
// We do NOT hand-roll JWT/JWS — `jose` (vetted) does the signing and
// verification (plan §0A). This module depends only on `jose` + `node:crypto`
// (via the raw key Buffer) + `@ethosagent/a2a` sibling stores — no extensions,
// no apps.

import { randomUUID } from 'node:crypto';
import { importJWK, importPKCS8, jwtVerify, SignJWT } from 'jose';
import type { A2aPeerStore } from './stores';

/** The claim set carried by an A2A access token. */
export interface A2aTokenClaims {
  /** Peer agent id. */
  sub: string;
  /** Minting (target) agent id. */
  iss: string;
  /** Intended audience — the target agent id. */
  aud: string;
  iat: number;
  exp: number;
  /** Token id — recorded as the peer's `tokenRef` for revocation. */
  jti: string;
  /** Granted skill names (default `[]`). */
  scope: string[];
  /** RFC 7800 sender-constraint: the peer key fingerprint this token is bound to. */
  cnf: { jkt: string };
}

export interface MintTokenParams {
  peerAgentId: string;
  /** The peer's key fingerprint — becomes `cnf.jkt`. */
  peerFingerprint: string;
  targetAgentId: string;
  scope: string[];
  /** Token lifetime in seconds. Default 3600 (1h, plan O3). */
  ttlSeconds?: number;
  /** ms epoch, for deterministic tests. Default `Date.now()`. */
  now?: number;
  /** Override the generated `jti` (tests). Default a random UUID. */
  jti?: string;
}

export interface MintedToken {
  token: string;
  claims: A2aTokenClaims;
  /** ms epoch expiry, mirrors `claims.exp * 1000`. */
  expiresAt: number;
}

/**
 * Mint a sender-constrained EdDSA JWT signed by the target's Ed25519 private
 * key (PKCS8 PEM). The token carries `cnf.jkt = peerFingerprint`.
 */
export async function mintToken(
  params: MintTokenParams,
  privateKeyPem: string,
): Promise<MintedToken> {
  const nowMs = params.now ?? Date.now();
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + (params.ttlSeconds ?? 3600);
  const jti = params.jti ?? randomUUID();
  const claims: A2aTokenClaims = {
    sub: params.peerAgentId,
    iss: params.targetAgentId,
    aud: params.targetAgentId,
    iat,
    exp,
    jti,
    scope: params.scope,
    cnf: { jkt: params.peerFingerprint },
  };

  const key = await importPKCS8(privateKeyPem, 'EdDSA');
  const token = await new SignJWT({ scope: claims.scope, cnf: claims.cnf })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer(claims.iss)
    .setAudience(claims.aud)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setJti(jti)
    .sign(key);

  return { token, claims, expiresAt: exp * 1000 };
}

export interface ValidateTokenOptions {
  /** The minting (target) agent's raw 32-byte Ed25519 public key. */
  targetPublicKey: Buffer;
  /** Fingerprint of the peer presenting the token — must equal `cnf.jkt`. */
  presentedFingerprint: string;
  /** Expected `iss` (the target agent id). */
  issuer: string;
  /** Expected `aud` (the target agent id). */
  audience: string;
  /** ms epoch, for deterministic expiry tests. Default `Date.now()`. */
  now?: number;
  /**
   * When supplied (with `personalityId`), enforces the `enabled` flag and that
   * the token's `jti` matches the peer's recorded `tokenRef` — the revocation
   * gate (plan O3). Omit for pure crypto+cnf validation.
   */
  peerStore?: A2aPeerStore;
  personalityId?: string;
}

export type TokenValidation = { ok: true; claims: A2aTokenClaims } | { ok: false; reason: string };

/**
 * Validate an A2A access token: (a) EdDSA signature over the target's key +
 * `iss`/`aud`/`exp` via `jose`; (b) sender-constraint — `cnf.jkt` present and
 * equal to the presenting peer's fingerprint; (c) optionally the peer-store
 * revocation gate (`enabled` + `jti === tokenRef`). Never throws — returns a
 * discriminated result.
 */
export async function validateToken(
  token: string,
  opts: ValidateTokenOptions,
): Promise<TokenValidation> {
  const key = await importJWK(
    { kty: 'OKP', crv: 'Ed25519', x: opts.targetPublicKey.toString('base64url') },
    'EdDSA',
  );

  let payload: Record<string, unknown>;
  try {
    const result = await jwtVerify(token, key, {
      issuer: opts.issuer,
      audience: opts.audience,
      algorithms: ['EdDSA'],
      currentDate: opts.now !== undefined ? new Date(opts.now) : undefined,
    });
    payload = result.payload as Record<string, unknown>;
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'token verification failed' };
  }

  const cnf = payload.cnf;
  if (cnf === null || typeof cnf !== 'object' || !('jkt' in cnf) || typeof cnf.jkt !== 'string') {
    return { ok: false, reason: 'token missing cnf sender-constraint' };
  }
  const jkt = cnf.jkt;
  if (jkt !== opts.presentedFingerprint) {
    return { ok: false, reason: 'cnf.jkt does not match the presenting peer' };
  }

  const claims: A2aTokenClaims = {
    sub: typeof payload.sub === 'string' ? payload.sub : '',
    iss: typeof payload.iss === 'string' ? payload.iss : '',
    aud: typeof payload.aud === 'string' ? payload.aud : '',
    iat: typeof payload.iat === 'number' ? payload.iat : 0,
    exp: typeof payload.exp === 'number' ? payload.exp : 0,
    jti: typeof payload.jti === 'string' ? payload.jti : '',
    scope: Array.isArray(payload.scope)
      ? payload.scope.filter((s): s is string => typeof s === 'string')
      : [],
    cnf: { jkt },
  };

  if (opts.peerStore && opts.personalityId) {
    const entry = await opts.peerStore.get(opts.personalityId, opts.presentedFingerprint);
    if (!entry?.enabled) return { ok: false, reason: 'peer disabled or unknown' };
    if (entry.tokenRef && entry.tokenRef !== claims.jti) {
      return { ok: false, reason: 'token revoked (jti does not match peer tokenRef)' };
    }
  }

  return { ok: true, claims };
}
