// Phase 9 acceptance gate — MULTI-TENANCY isolation (plan §15). The trust state
// is STRUCTURALLY per-personality: allowlist grants, peer entries, and the nonce
// binding are all keyed by the owning personality, so one personality's peer is
// invisible to another. This suite CONFIRMS that isolation directly, and closes
// the one remaining cross-personality READ gap — the async task SSE stream.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { A2aIdentityProvider } from '@ethosagent/types';
import { EthosError } from '@ethosagent/types';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { signCard } from '../crypto';
import { A2A_METHOD_TASKS_SUBSCRIBE, createA2aRpcRouter } from '../rpc';
import { MemoryNonceStore, StorageA2aAllowlist, StorageA2aPeerStore } from '../stores';
import { type A2aTask, InMemoryA2aTaskStore } from '../task-store';
import { mintToken } from '../tokens';
import { type Agent, countingRunner, HELLO_SCRIPT, makeAgent, signPop } from './a2a-fixtures';

// ---------------------------------------------------------------------------
// A) Store isolation — one personality's peer/allowlist entry is invisible to another.
// ---------------------------------------------------------------------------

describe('Multi-tenancy — per-personality store isolation (plan §15)', () => {
  it("alpha's allowlist grant + peer entry are invisible to beta", async () => {
    const storage = new InMemoryStorage();
    const baseDir = '/ethos/a2a';
    const allowlist = new StorageA2aAllowlist(storage, baseDir);
    const peerStore = new StorageA2aPeerStore(storage, baseDir);
    const peer = makeAgent('peer-a');

    // Approve + persist the peer UNDER personality 'alpha'.
    await storage.mkdir(`${baseDir}/alpha/allowlist`);
    await storage.write(
      `${baseDir}/alpha/allowlist/${peer.fingerprint}.json`,
      JSON.stringify({ scope: ['search'], enabled: true }),
    );
    await peerStore.upsert('alpha', {
      fingerprint: peer.fingerprint,
      card: peer.card,
      scope: ['search'],
      tokenRef: 'jti-alpha',
      enabled: true,
    });

    // Alpha sees its own grant + peer.
    expect(await allowlist.lookup('alpha', peer.fingerprint)).not.toBeNull();
    expect(await peerStore.get('alpha', peer.fingerprint)).not.toBeNull();

    // Beta sees NOTHING — the same fingerprint is not approved for beta.
    expect(await allowlist.lookup('beta', peer.fingerprint)).toBeNull();
    expect(await peerStore.get('beta', peer.fingerprint)).toBeNull();
  });

  it('a nonce issued for target alpha is bound to alpha, not beta', () => {
    // The handshake rejects a nonce whose `targetAgentId !== personalityId`
    // (auth.ts). This confirms the binding the check relies on: a nonce minted
    // for alpha carries alpha as its target and can never satisfy beta.
    const nonces = new MemoryNonceStore();
    const nonce = nonces.issue('alpha');
    const record = nonces.consume(nonce);
    expect(record?.targetAgentId).toBe('alpha');
    expect(record?.targetAgentId).not.toBe('beta');
  });
});

// ---------------------------------------------------------------------------
// B) SSE task-ownership — a task owned by one personality is not readable via
//    another personality's SSE route, even by a peer legitimately authed there.
// ---------------------------------------------------------------------------

/** An identity provider serving several personalities from one router. */
function multiIdentity(agents: Agent[], skills: string[]): A2aIdentityProvider {
  const byId = new Map(agents.map((a) => [a.id, a]));
  return {
    async getIdentity(personalityId, audience) {
      const agent = byId.get(personalityId);
      if (!agent) {
        throw new EthosError({
          code: 'PERSONALITY_NOT_FOUND',
          cause: `Personality "${personalityId}" not found.`,
          action: 'unknown',
        });
      }
      const visible =
        audience === 'stranger' ? [] : skills.map((name) => ({ name, description: name }));
      const unsigned = { ...agent.unsigned, skills: visible };
      return { ...unsigned, signature: signCard(unsigned, agent.privateKeyPem) };
    },
  };
}

/** Mint a token for `peer` under `personalityId` and enable it in the peer store. */
async function mintUnder(
  personalityId: string,
  target: Agent,
  peer: Agent,
  scope: string[],
  peerStore: StorageA2aPeerStore,
) {
  const minted = await mintToken(
    {
      peerAgentId: peer.id,
      peerFingerprint: peer.fingerprint,
      targetAgentId: personalityId,
      scope,
    },
    target.privateKeyPem,
  );
  await peerStore.upsert(personalityId, {
    fingerprint: peer.fingerprint,
    card: peer.card,
    scope,
    tokenRef: minted.claims.jti,
    enabled: true,
  });
  return minted;
}

function sseHeaders(peer: Agent, token: string, jti: string, ts: number): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'x-a2a-pop': signPop(peer, A2A_METHOD_TASKS_SUBSCRIBE, jti, ts),
    'x-a2a-pop-timestamp': String(ts),
  };
}

describe('Multi-tenancy — SSE task-ownership check (plan §15)', () => {
  it('404s a task owned by alpha when read via betas SSE route (no cross-read)', async () => {
    const alpha = makeAgent('alpha');
    const beta = makeAgent('beta');
    const peerA = makeAgent('peer-a');
    const peerB = makeAgent('peer-b');
    const peerStore = new StorageA2aPeerStore(new InMemoryStorage(), '/ethos/a2a');
    const store = new InMemoryA2aTaskStore();

    const app = new Hono();
    app.route(
      '/a2a',
      createA2aRpcRouter({
        getIdentity: multiIdentity([alpha, beta], ['search']),
        peerStore,
        runner: countingRunner(HELLO_SCRIPT, { runs: 0 }),
        taskStore: store,
      }),
    );

    // A completed task OWNED by personality alpha.
    const alphaTask: A2aTask = {
      id: 'alpha-task-1',
      status: 'completed',
      result: 'alpha secret result',
      createdAt: 1,
      idempotencyKey: 'k',
      traceId: 't',
      peerFingerprint: peerA.fingerprint,
      personalityId: 'alpha',
    };
    await store.create(alphaTask);

    const alphaMint = await mintUnder('alpha', alpha, peerA, ['search'], peerStore);
    const betaMint = await mintUnder('beta', beta, peerB, ['search'], peerStore);
    const ts = Date.now();

    // Beta's peer authenticates for beta and tries to read alpha's task → 404.
    const cross = await app.request(`/a2a/beta/tasks/${alphaTask.id}/events`, {
      headers: sseHeaders(peerB, betaMint.token, betaMint.claims.jti, ts),
    });
    expect(cross.status).toBe(404);

    // Control: alpha's own peer reads the SAME task via alpha's route → 200.
    const own = await app.request(`/a2a/alpha/tasks/${alphaTask.id}/events`, {
      headers: sseHeaders(peerA, alphaMint.token, alphaMint.claims.jti, ts),
    });
    expect(own.status).toBe(200);
    const body = await own.text();
    expect(body).toContain('alpha secret result');
  });
});
