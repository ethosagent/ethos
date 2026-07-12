// Phase 4 acceptance gate — the auth handshake attack tests (plan §0A / §9).
// Every attack below MUST be rejected; the happy path MUST round-trip to a
// valid, sender-constrained token. The service is exercised directly (no HTTP)
// plus one router mount mirroring the Phase-2 RouteModule seam.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { AgentCard, SecretRef, SecretsResolver } from '@ethosagent/types';
import { Hono } from 'hono';
import { importPKCS8, SignJWT } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';
import { createA2aAuthRouter, createA2aAuthService } from '../auth';
import { buildDidDocument, fingerprint, generateEd25519, signCard, signStruct } from '../crypto';
import { verifyReceipt } from '../receipts';
import {
  type A2aAllowlist,
  MemoryNonceStore,
  type PeerGrant,
  StorageA2aAllowlist,
  StorageA2aPeerStore,
} from '../stores';
import { mintToken, validateToken } from '../tokens';

// --- Test agents -----------------------------------------------------------

interface Agent {
  id: string;
  privateKeyPem: string;
  rawPublicKey: Buffer;
  fingerprint: string;
  card: AgentCard;
}

function makeAgent(id: string): Agent {
  const { privateKeyPem, rawPublicKey } = generateEd25519();
  const fp = fingerprint(rawPublicKey);
  const jsonRpc = `http://localhost:8787/a2a/${id}`;
  const unsigned: Omit<AgentCard, 'signature'> = {
    id,
    name: id,
    description: `Agent ${id}.`,
    protocolVersion: 'a2a/0.1',
    skills: [],
    endpoints: { jsonRpc, auth: `http://localhost:8787/a2a-auth/${id}` },
    publicKey: rawPublicKey.toString('base64'),
    keyFingerprint: fp,
    signatureAlg: 'ed25519',
    did: buildDidDocument(rawPublicKey, jsonRpc),
  };
  return {
    id,
    privateKeyPem,
    rawPublicKey,
    fingerprint: fp,
    card: { ...unsigned, signature: signCard(unsigned, privateKeyPem) },
  };
}

// In-memory SecretsResolver holding the target's private key.
function stubSecrets(entries: Record<string, string>): SecretsResolver {
  const map = new Map(Object.entries(entries));
  return {
    async get(ref: SecretRef) {
      return map.get(ref) ?? null;
    },
    async set(ref: SecretRef, value: string) {
      map.set(ref, value);
    },
    async delete(ref: SecretRef) {
      map.delete(ref);
    },
    async list() {
      return [...map.keys()];
    },
  };
}

// Allowlist stub: approves a fixed set of fingerprints with a scope.
function stubAllowlist(approved: Map<string, PeerGrant>): A2aAllowlist {
  return {
    async lookup(_personalityId, peerFingerprint) {
      return approved.get(peerFingerprint) ?? null;
    },
  };
}

// --- Harness ---------------------------------------------------------------

const TARGET_ID = 'researcher';

function signChallenge(
  peer: Agent,
  nonce: string,
  targetAgentId: string,
  timestamp: number,
): string {
  return signStruct(
    { context: 'a2a-auth-challenge', nonce, target_agent_id: targetAgentId, timestamp },
    peer.privateKeyPem,
  );
}

async function makeHarness(opts: { approvedScope?: string[] } = {}) {
  const target = makeAgent(TARGET_ID);
  const peer = makeAgent('peer-a');
  // Realistic base time so a minted token's 1h window brackets the real clock
  // that `validateToken` uses by default in the happy-path assertion.
  const clock = { t: Date.now() };
  const now = () => clock.t;

  const storage = new InMemoryStorage();
  const receipts: import('../receipts').SignedA2aAuthReceipt[] = [];

  const service = createA2aAuthService({
    secrets: stubSecrets({ [`a2a/${TARGET_ID}/private-key`]: target.privateKeyPem }),
    allowlist: stubAllowlist(
      new Map([
        [
          peer.fingerprint,
          { fingerprint: peer.fingerprint, scope: opts.approvedScope ?? ['search'], enabled: true },
        ],
      ]),
    ),
    peerStore: new StorageA2aPeerStore(storage, '/ethos/a2a'),
    nonces: new MemoryNonceStore({ now, ttlMs: 60_000 }),
    now,
    onReceipt: (r) => receipts.push(r),
  });

  return { target, peer, service, clock, receipts };
}

// --- Happy path ------------------------------------------------------------

describe('A2A auth handshake — happy path', () => {
  it('an allowlisted peer completes both steps and receives a valid, sender-constrained token', async () => {
    const { target, peer, service, clock, receipts } = await makeHarness({
      approvedScope: ['search'],
    });

    const ch = await service.challenge(TARGET_ID, { card: peer.card });
    expect(ch.ok).toBe(true);
    if (!ch.ok) return;
    expect(ch.targetAgentId).toBe(TARGET_ID);

    const ts = clock.t;
    const sig = signChallenge(peer, ch.nonce, TARGET_ID, ts);
    const res = await service.respond(TARGET_ID, {
      nonce: ch.nonce,
      timestamp: ts,
      signature: sig,
      fingerprint: peer.fingerprint,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.expiresAt).toBeGreaterThan(clock.t);

    // The token validates and carries the sender-constraint bound to the peer.
    const v = await validateToken(res.token, {
      targetPublicKey: target.rawPublicKey,
      presentedFingerprint: peer.fingerprint,
      issuer: TARGET_ID,
      audience: TARGET_ID,
    });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.claims.cnf.jkt).toBe(peer.fingerprint);
    expect(v.claims.scope).toEqual(['search']);
    expect(v.claims.sub).toBe(peer.id);

    // An accepted, tamper-evident receipt was emitted and verifies against the target key.
    const accepted = receipts.find((r) => r.receipt.decision === 'accepted');
    expect(accepted).toBeDefined();
    if (accepted) expect(verifyReceipt(accepted, target.rawPublicKey)).toBe(true);
  });
});

// --- Attack 1: replayed nonce ---------------------------------------------

describe('Attack 1 — replayed nonce', () => {
  it('rejects a second use of the same nonce', async () => {
    const { peer, service, clock } = await makeHarness();
    const ch = await service.challenge(TARGET_ID, { card: peer.card });
    if (!ch.ok) throw new Error('challenge failed');
    const ts = clock.t;
    const sig = signChallenge(peer, ch.nonce, TARGET_ID, ts);
    const body = { nonce: ch.nonce, timestamp: ts, signature: sig, fingerprint: peer.fingerprint };

    const first = await service.respond(TARGET_ID, body);
    expect(first.ok).toBe(true);

    const second = await service.respond(TARGET_ID, body);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.status).toBe(401);
  });
});

// --- Attack 2: wrong / absent signature -----------------------------------

describe('Attack 2 — wrong or absent signature', () => {
  it('rejects a garbage signature', async () => {
    const { peer, service, clock } = await makeHarness();
    const ch = await service.challenge(TARGET_ID, { card: peer.card });
    if (!ch.ok) throw new Error('challenge failed');
    const res = await service.respond(TARGET_ID, {
      nonce: ch.nonce,
      timestamp: clock.t,
      signature: Buffer.from('not-a-real-signature').toString('base64'),
      fingerprint: peer.fingerprint,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });

  it('rejects an absent signature (malformed body)', async () => {
    const { peer, service, clock } = await makeHarness();
    const ch = await service.challenge(TARGET_ID, { card: peer.card });
    if (!ch.ok) throw new Error('challenge failed');
    const res = await service.respond(TARGET_ID, {
      nonce: ch.nonce,
      timestamp: clock.t,
      fingerprint: peer.fingerprint,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(400);
  });
});

// --- Attack 3: non-allowlisted peer ---------------------------------------

describe('Attack 3 — non-allowlisted peer', () => {
  it('rejects at step 1 before any nonce is issued', async () => {
    const stranger = makeAgent('stranger');
    const target = makeAgent(TARGET_ID);
    const nonces = new MemoryNonceStore();
    let issued = 0;
    const spyNonces = {
      issue: (t: string) => {
        issued++;
        return nonces.issue(t);
      },
      consume: (n: string) => nonces.consume(n),
    };
    const service = createA2aAuthService({
      secrets: stubSecrets({ [`a2a/${TARGET_ID}/private-key`]: target.privateKeyPem }),
      allowlist: stubAllowlist(new Map()), // nobody approved → default-deny
      peerStore: new StorageA2aPeerStore(new InMemoryStorage(), '/ethos/a2a'),
      nonces: spyNonces,
    });

    const ch = await service.challenge(TARGET_ID, { card: stranger.card });
    expect(ch.ok).toBe(false);
    if (!ch.ok) {
      expect(ch.status).toBe(403);
      expect(ch.receipt?.receipt.decision).toBe('rejected');
    }
    expect(issued).toBe(0); // no nonce work happened for a stranger
  });
});

// --- Attack 4: expired nonce ----------------------------------------------

describe('Attack 4 — expired nonce', () => {
  it('rejects a nonce used after its TTL', async () => {
    const { peer, service, clock } = await makeHarness();
    const ch = await service.challenge(TARGET_ID, { card: peer.card });
    if (!ch.ok) throw new Error('challenge failed');
    const ts = clock.t;
    const sig = signChallenge(peer, ch.nonce, TARGET_ID, ts);

    clock.t += 61_000; // advance past the 60s TTL

    const res = await service.respond(TARGET_ID, {
      nonce: ch.nonce,
      timestamp: ts,
      signature: sig,
      fingerprint: peer.fingerprint,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });
});

// --- Attack 5: bare-nonce / wrong-domain signature ------------------------

describe('Attack 5 — bare-nonce or wrong-domain signature', () => {
  it('rejects a signature over the bare nonce (no domain separation)', async () => {
    const { peer, service, clock } = await makeHarness();
    const ch = await service.challenge(TARGET_ID, { card: peer.card });
    if (!ch.ok) throw new Error('challenge failed');
    const bareNonceSig = signStruct(ch.nonce, peer.privateKeyPem); // signs just the nonce string
    const res = await service.respond(TARGET_ID, {
      nonce: ch.nonce,
      timestamp: clock.t,
      signature: bareNonceSig,
      fingerprint: peer.fingerprint,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });

  it('rejects a signature over a struct with the wrong context', async () => {
    const { peer, service, clock } = await makeHarness();
    const ch = await service.challenge(TARGET_ID, { card: peer.card });
    if (!ch.ok) throw new Error('challenge failed');
    const ts = clock.t;
    const wrongContextSig = signStruct(
      {
        context: 'some-other-protocol',
        nonce: ch.nonce,
        target_agent_id: TARGET_ID,
        timestamp: ts,
      },
      peer.privateKeyPem,
    );
    const res = await service.respond(TARGET_ID, {
      nonce: ch.nonce,
      timestamp: ts,
      signature: wrongContextSig,
      fingerprint: peer.fingerprint,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });
});

// --- Attack 6: sender-constrained token binding ---------------------------

describe('Attack 6 — sender-constrained token', () => {
  let target: Agent;
  let peer: Agent;
  beforeEach(() => {
    target = makeAgent(TARGET_ID);
    peer = makeAgent('peer-a');
  });

  it('the minted token carries cnf.jkt = the peer fingerprint', async () => {
    const minted = await mintToken(
      {
        peerAgentId: peer.id,
        peerFingerprint: peer.fingerprint,
        targetAgentId: TARGET_ID,
        scope: ['search'],
      },
      target.privateKeyPem,
    );
    expect(minted.claims.cnf.jkt).toBe(peer.fingerprint);
  });

  it('rejects a token whose cnf does not match the presenting peer', async () => {
    const minted = await mintToken(
      {
        peerAgentId: peer.id,
        peerFingerprint: peer.fingerprint,
        targetAgentId: TARGET_ID,
        scope: [],
      },
      target.privateKeyPem,
    );
    const other = makeAgent('other');
    const v = await validateToken(minted.token, {
      targetPublicKey: target.rawPublicKey,
      presentedFingerprint: other.fingerprint, // a different peer presents it
      issuer: TARGET_ID,
      audience: TARGET_ID,
    });
    expect(v.ok).toBe(false);
  });

  it('rejects a token with no cnf claim at all', async () => {
    // Mint a raw JWT WITHOUT a cnf claim (bypasses mintToken).
    const key = await importPKCS8(target.privateKeyPem, 'EdDSA');
    const noCnf = await new SignJWT({ scope: [] })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
      .setSubject(peer.id)
      .setIssuer(TARGET_ID)
      .setAudience(TARGET_ID)
      .setIssuedAt()
      .setExpirationTime('1h')
      .setJti('x')
      .sign(key);
    const v = await validateToken(noCnf, {
      targetPublicKey: target.rawPublicKey,
      presentedFingerprint: peer.fingerprint,
      issuer: TARGET_ID,
      audience: TARGET_ID,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/cnf/);
  });

  it('honours the peer-store revocation gate (enabled + jti)', async () => {
    const storage = new InMemoryStorage();
    const peerStore = new StorageA2aPeerStore(storage, '/ethos/a2a');
    const minted = await mintToken(
      {
        peerAgentId: peer.id,
        peerFingerprint: peer.fingerprint,
        targetAgentId: TARGET_ID,
        scope: [],
      },
      target.privateKeyPem,
    );
    // Peer present but DISABLED → reject.
    await peerStore.upsert(TARGET_ID, {
      fingerprint: peer.fingerprint,
      card: peer.card,
      scope: [],
      tokenRef: minted.claims.jti,
      enabled: false,
    });
    const disabled = await validateToken(minted.token, {
      targetPublicKey: target.rawPublicKey,
      presentedFingerprint: peer.fingerprint,
      issuer: TARGET_ID,
      audience: TARGET_ID,
      peerStore,
      personalityId: TARGET_ID,
    });
    expect(disabled.ok).toBe(false);

    // Enabled but a stale jti (token rotated) → reject.
    await peerStore.upsert(TARGET_ID, {
      fingerprint: peer.fingerprint,
      card: peer.card,
      scope: [],
      tokenRef: 'a-newer-jti',
      enabled: true,
    });
    const rotated = await validateToken(minted.token, {
      targetPublicKey: target.rawPublicKey,
      presentedFingerprint: peer.fingerprint,
      issuer: TARGET_ID,
      audience: TARGET_ID,
      peerStore,
      personalityId: TARGET_ID,
    });
    expect(rotated.ok).toBe(false);
  });
});

// --- Router mount (Phase-2 RouteModule seam) ------------------------------

describe('createA2aAuthRouter — mounted via the Phase-2 route seam', () => {
  it('round-trips challenge → response over HTTP and rejects strangers', async () => {
    const target = makeAgent(TARGET_ID);
    const peer = makeAgent('peer-a');
    const nonces = new MemoryNonceStore();
    const router = createA2aAuthRouter({
      secrets: stubSecrets({ [`a2a/${TARGET_ID}/private-key`]: target.privateKeyPem }),
      allowlist: stubAllowlist(
        new Map([
          [peer.fingerprint, { fingerprint: peer.fingerprint, scope: ['search'], enabled: true }],
        ]),
      ),
      peerStore: new StorageA2aPeerStore(new InMemoryStorage(), '/ethos/a2a'),
      nonces,
    });
    // Mirror the RouteModule seam: basePath '/a2a-auth', auth 'public'.
    const app = new Hono();
    app.route('/a2a-auth', router);

    const chRes = await app.request(`/a2a-auth/${TARGET_ID}/challenge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ card: peer.card }),
    });
    expect(chRes.status).toBe(200);
    const ch = (await chRes.json()) as { nonce: string; target_agent_id: string };
    expect(ch.target_agent_id).toBe(TARGET_ID);

    const ts = Date.now();
    const sig = signChallenge(peer, ch.nonce, TARGET_ID, ts);
    const respRes = await app.request(`/a2a-auth/${TARGET_ID}/response`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nonce: ch.nonce,
        timestamp: ts,
        signature: sig,
        fingerprint: peer.fingerprint,
      }),
    });
    expect(respRes.status).toBe(200);
    const tok = (await respRes.json()) as { token: string; expiresAt: number };
    const v = await validateToken(tok.token, {
      targetPublicKey: target.rawPublicKey,
      presentedFingerprint: peer.fingerprint,
      issuer: TARGET_ID,
      audience: TARGET_ID,
    });
    expect(v.ok).toBe(true);

    // A stranger is rejected at step 1.
    const stranger = makeAgent('stranger');
    const strangerRes = await app.request(`/a2a-auth/${TARGET_ID}/challenge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ card: stranger.card }),
    });
    expect(strangerRes.status).toBe(403);
  });
});

// --- Default Storage-backed allowlist -------------------------------------

describe('StorageA2aAllowlist — default impl', () => {
  it('default-denies unknown and disabled peers, approves enabled ones', async () => {
    const storage = new InMemoryStorage();
    const allowlist = new StorageA2aAllowlist(storage, '/ethos/a2a');

    // Unknown peer → null.
    expect(await allowlist.lookup(TARGET_ID, 'unknownfp')).toBeNull();

    await storage.mkdir('/ethos/a2a/researcher/allowlist');
    await storage.write(
      '/ethos/a2a/researcher/allowlist/enabledfp.json',
      JSON.stringify({ scope: ['search'], enabled: true }),
    );
    await storage.write(
      '/ethos/a2a/researcher/allowlist/disabledfp.json',
      JSON.stringify({ scope: ['search'], enabled: false }),
    );

    const enabled = await allowlist.lookup(TARGET_ID, 'enabledfp');
    expect(enabled).toEqual({ fingerprint: 'enabledfp', scope: ['search'], enabled: true });
    expect(await allowlist.lookup(TARGET_ID, 'disabledfp')).toBeNull();
  });
});
