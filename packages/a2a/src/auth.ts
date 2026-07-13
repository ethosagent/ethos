// A2A auth handshake — the default-deny, proof-of-possession endpoint
// (`/a2a-auth/<personalityId>`, plan §9). This is the security-critical core of
// Phase 4. It owns its OWN auth (RouteModule `auth: 'public'`): the handshake
// establishes identity before any trusted channel exists.
//
// Two steps (both JSON POST):
//   1. challenge — peer presents its card. Server: ALLOWLIST FIRST (default-deny)
//      → verify card signature + fingerprint → issue a single-use nonce.
//   2. response — peer returns the nonce + a signature over the DOMAIN-SEPARATED
//      struct { context:'a2a-auth-challenge', nonce, target_agent_id, timestamp }.
//      Server: consume the nonce (single-use) → verify the domain-separated
//      signature against the peer's card key → mint a sender-constrained token.
//
// Every signature goes over a canonical, context-tagged struct — never a bare
// nonce (plan §7). All primitives come from `./crypto` (Node Ed25519) and
// `./tokens` (jose JWT) — nothing is hand-rolled (plan §0A). Layer-clean:
// imports only `@ethosagent/types` + `hono` + sibling package modules.

import type { AgentCard, SecretsResolver } from '@ethosagent/types';
import { Hono } from 'hono';
import { fingerprint, verifyCard, verifyStruct } from './crypto';
import { type A2aAuthReceipt, type SignedA2aAuthReceipt, signReceipt } from './receipts';
import type { A2aAllowlist, A2aPeerStore, NonceStore } from './stores';
import { mintToken } from './tokens';

/** The domain-separated struct the peer signs in step 2 (plan §7). */
export interface A2aChallengeStruct {
  context: 'a2a-auth-challenge';
  nonce: string;
  target_agent_id: string;
  timestamp: number;
}

/** Step-1 request body: the peer's signed card. Agent id = `card.id`. */
export interface ChallengeRequest {
  card: AgentCard;
}

/** Step-2 request body: the nonce + domain-separated signature. */
export interface ChallengeResponse {
  nonce: string;
  /** ms epoch the peer put in the signed struct — echoed so the server reconstructs it. */
  timestamp: number;
  /** base64 Ed25519 signature over the {@link A2aChallengeStruct}. */
  signature: string;
  /** The peer's key fingerprint — identifies which stored peer to verify against. */
  fingerprint: string;
}

export type ChallengeResult =
  | { ok: true; nonce: string; targetAgentId: string }
  | { ok: false; status: number; reason: string; receipt?: SignedA2aAuthReceipt };

export type RespondResult =
  | { ok: true; token: string; expiresAt: number; receipt: SignedA2aAuthReceipt }
  | { ok: false; status: number; reason: string; receipt?: SignedA2aAuthReceipt };

export interface A2aAuthServiceOptions {
  secrets: SecretsResolver;
  allowlist: A2aAllowlist;
  peerStore: A2aPeerStore;
  nonces: NonceStore;
  /** Token lifetime in seconds. Default 3600 (1h, plan O3). */
  tokenTtlSeconds?: number;
  /** Injectable clock (ms epoch). Default `Date.now`. */
  now?: () => number;
  /**
   * Secret ref for a personality's Ed25519 private key (PKCS8 PEM). Default
   * `a2a/<personalityId>/private-key` (Phase 1 decision).
   */
  privateKeyRef?: (personalityId: string) => string;
  /**
   * Audit sink for signed receipts (plan §13). Called for every emitted receipt
   * (accepted + rejected). The real sink (observability-sqlite) is Phase 8; the
   * default is a no-op. Failures here never affect the handshake outcome.
   */
  onReceipt?: (receipt: SignedA2aAuthReceipt) => void;
}

/** The handshake, decoupled from HTTP so the attack tests exercise it directly. */
export interface A2aAuthService {
  challenge(personalityId: string, body: unknown): Promise<ChallengeResult>;
  respond(personalityId: string, body: unknown): Promise<RespondResult>;
  /**
   * Gated reciprocation (plan §9): may THIS agent auto-initiate auth back to the
   * peer? True only if the peer is on this agent's own allowlist (do not
   * reciprocate to strangers). The outbound client call itself is Phase 7 — this
   * is the documented decision hook.
   */
  mayReciprocate(personalityId: string, peerFingerprint: string): Promise<boolean>;
}

const CHALLENGE_CONTEXT = 'a2a-auth-challenge' as const;

export function createA2aAuthService(opts: A2aAuthServiceOptions): A2aAuthService {
  const now = opts.now ?? Date.now;
  const ttlSeconds = opts.tokenTtlSeconds ?? 3600;
  const refFor = opts.privateKeyRef ?? ((id: string) => `a2a/${id}/private-key`);

  function emit(
    privateKeyPem: string,
    personalityId: string,
    peerFingerprint: string,
    decision: 'accepted' | 'rejected',
    reason?: string,
  ): SignedA2aAuthReceipt {
    const receipt: A2aAuthReceipt = {
      event: 'a2a-auth',
      personalityId,
      peerFingerprint,
      decision,
      ts: now(),
    };
    if (reason !== undefined) receipt.reason = reason;
    const signed = signReceipt(receipt, privateKeyPem);
    try {
      opts.onReceipt?.(signed);
    } catch {
      // Audit-sink failures are fail-open — never block the handshake.
    }
    return signed;
  }

  async function challenge(personalityId: string, body: unknown): Promise<ChallengeResult> {
    const privateKeyPem = await opts.secrets.get(refFor(personalityId));
    if (!privateKeyPem) {
      return { ok: false, status: 500, reason: 'agent signing key not configured' };
    }

    if (!isChallengeRequest(body)) {
      return { ok: false, status: 400, reason: 'malformed challenge request' };
    }
    const card = body.card;
    const claimedFingerprint = card.keyFingerprint;

    // (a) ALLOWLIST FIRST — default-deny before any crypto or nonce work.
    const grant = await opts.allowlist.lookup(personalityId, claimedFingerprint);
    if (!grant) {
      const receipt = emit(
        privateKeyPem,
        personalityId,
        claimedFingerprint,
        'rejected',
        'not on allowlist',
      );
      return { ok: false, status: 403, reason: 'peer not on allowlist', receipt };
    }

    // (b) verify the card signature + that its fingerprint binds to its key.
    if (!verifyCard(card)) {
      const receipt = emit(
        privateKeyPem,
        personalityId,
        claimedFingerprint,
        'rejected',
        'card verification failed',
      );
      return { ok: false, status: 401, reason: 'card verification failed', receipt };
    }

    // Persist a DISABLED peer entry so step 2 can recover the peer's public key
    // (the nonce is bound only to the target — plan §9). Enabled at step 2.
    await opts.peerStore.upsert(personalityId, {
      fingerprint: claimedFingerprint,
      card,
      scope: grant.scope,
      enabled: false,
    });

    // (c) issue a fresh single-use nonce bound to the target.
    const nonce = opts.nonces.issue(personalityId);
    return { ok: true, nonce, targetAgentId: personalityId };
  }

  async function respond(personalityId: string, body: unknown): Promise<RespondResult> {
    const privateKeyPem = await opts.secrets.get(refFor(personalityId));
    if (!privateKeyPem) {
      return { ok: false, status: 500, reason: 'agent signing key not configured' };
    }

    if (!isChallengeResponse(body)) {
      return { ok: false, status: 400, reason: 'malformed challenge response' };
    }
    const peerFingerprint = body.fingerprint;

    // (a) consume the nonce — single-use; null if missing, expired, or replayed.
    const record = opts.nonces.consume(body.nonce);
    if (!record || record.targetAgentId !== personalityId) {
      const receipt = emit(
        privateKeyPem,
        personalityId,
        peerFingerprint,
        'rejected',
        'invalid or replayed nonce',
      );
      return { ok: false, status: 401, reason: 'invalid or replayed nonce', receipt };
    }

    // Recover the peer's verified card (persisted at step 1) to get its key.
    const entry = await opts.peerStore.get(personalityId, peerFingerprint);
    if (!entry) {
      const receipt = emit(
        privateKeyPem,
        personalityId,
        peerFingerprint,
        'rejected',
        'no prior challenge for peer',
      );
      return { ok: false, status: 401, reason: 'no prior challenge for peer', receipt };
    }
    const peerPublicKey = Buffer.from(entry.card.publicKey, 'base64');
    // Defensive: the stored card's key must still hash to the claimed fingerprint.
    if (fingerprint(peerPublicKey) !== peerFingerprint) {
      const receipt = emit(
        privateKeyPem,
        personalityId,
        peerFingerprint,
        'rejected',
        'peer key/fingerprint mismatch',
      );
      return { ok: false, status: 401, reason: 'peer key/fingerprint mismatch', receipt };
    }

    // (b) verify the signature over the DOMAIN-SEPARATED struct — a bare-nonce or
    // wrong-context signature reconstructs a different struct and fails.
    const struct: A2aChallengeStruct = {
      context: CHALLENGE_CONTEXT,
      nonce: body.nonce,
      target_agent_id: personalityId,
      timestamp: body.timestamp,
    };
    if (!verifyStruct(struct, body.signature, peerPublicKey)) {
      const receipt = emit(
        privateKeyPem,
        personalityId,
        peerFingerprint,
        'rejected',
        'challenge signature invalid',
      );
      return { ok: false, status: 401, reason: 'challenge signature invalid', receipt };
    }

    // Re-check the allowlist at mint time (grant may have been revoked between
    // steps) and take the CURRENT scope — never a value cached at step 1.
    const grant = await opts.allowlist.lookup(personalityId, peerFingerprint);
    if (!grant) {
      const receipt = emit(
        privateKeyPem,
        personalityId,
        peerFingerprint,
        'rejected',
        'grant revoked',
      );
      return { ok: false, status: 403, reason: 'grant revoked', receipt };
    }

    // (c) mint the sender-constrained token, enable the peer, record the jti.
    const minted = await mintToken(
      {
        peerAgentId: entry.card.id,
        peerFingerprint,
        targetAgentId: personalityId,
        scope: grant.scope,
        ttlSeconds,
        now: now(),
      },
      privateKeyPem,
    );
    await opts.peerStore.upsert(personalityId, {
      fingerprint: peerFingerprint,
      card: entry.card,
      scope: grant.scope,
      tokenRef: minted.claims.jti,
      enabled: true,
    });

    // Stamp inbound "last seen" (plan §11) — fail-open: a touch error must never
    // affect the handshake outcome.
    if (typeof opts.peerStore.touchLastSeen === 'function') {
      try {
        await opts.peerStore.touchLastSeen(personalityId, peerFingerprint, now());
      } catch {
        // fail-open
      }
    }

    const receipt = emit(privateKeyPem, personalityId, peerFingerprint, 'accepted');
    return { ok: true, token: minted.token, expiresAt: minted.expiresAt, receipt };
  }

  async function mayReciprocate(personalityId: string, peerFingerprint: string): Promise<boolean> {
    return (await opts.allowlist.lookup(personalityId, peerFingerprint)) !== null;
  }

  return { challenge, respond, mayReciprocate };
}

/**
 * Build the public `/a2a-auth` Hono sub-router. Routes are declared RELATIVE to
 * the RouteModule basePath `/a2a-auth` (the seam mounts it with
 * `app.route('/a2a-auth', router)`, `auth: 'public'`), yielding:
 *
 *   POST /a2a-auth/:personalityId/challenge   → { nonce, target_agent_id }
 *   POST /a2a-auth/:personalityId/response     → { token, expiresAt }
 *
 * The router is a thin HTTP adapter over {@link A2aAuthService}; all decisions
 * live in the service so they are testable without HTTP.
 */
export function createA2aAuthRouter(opts: A2aAuthServiceOptions): Hono {
  const service = createA2aAuthService(opts);
  const router = new Hono();

  router.post('/:personalityId/challenge', async (c) => {
    const personalityId = c.req.param('personalityId');
    let body: unknown = null;
    try {
      body = await c.req.json();
    } catch {
      body = null;
    }
    const result = await service.challenge(personalityId, body);
    if (!result.ok) {
      return c.json({ error: 'REJECTED', message: result.reason }, statusOf(result.status));
    }
    return c.json({ nonce: result.nonce, target_agent_id: result.targetAgentId });
  });

  router.post('/:personalityId/response', async (c) => {
    const personalityId = c.req.param('personalityId');
    let body: unknown = null;
    try {
      body = await c.req.json();
    } catch {
      body = null;
    }
    const result = await service.respond(personalityId, body);
    if (!result.ok) {
      return c.json({ error: 'REJECTED', message: result.reason }, statusOf(result.status));
    }
    return c.json({ token: result.token, expiresAt: result.expiresAt });
  });

  return router;
}

// Hono's ContentfulStatusCode is a numeric union; narrow our small set.
function statusOf(status: number): 400 | 401 | 403 | 500 {
  if (status === 400 || status === 401 || status === 403 || status === 500) return status;
  return 500;
}

function isChallengeRequest(value: unknown): value is ChallengeRequest {
  if (value === null || typeof value !== 'object') return false;
  const card = (value as { card?: unknown }).card;
  if (card === null || typeof card !== 'object') return false;
  const v = card as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.publicKey === 'string' &&
    typeof v.keyFingerprint === 'string' &&
    typeof v.signature === 'string'
  );
}

function isChallengeResponse(value: unknown): value is ChallengeResponse {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.nonce === 'string' &&
    typeof v.timestamp === 'number' &&
    typeof v.signature === 'string' &&
    typeof v.fingerprint === 'string'
  );
}
