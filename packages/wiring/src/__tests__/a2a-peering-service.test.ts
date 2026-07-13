// A2aPeeringService (plan §4) — the DRY trust core. Exercised over
// InMemoryStorage-backed stores + a hand-built AgentCard identity/fetch stub, so
// no real network or crypto is needed. Asserts the trust invariants written HERE
// (verify-first, saved-disabled, full-access ['*']) hold regardless of surface.

import { A2aClientError, StorageA2aAllowlist, StorageA2aPeerStore } from '@ethosagent/a2a';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { A2aIdentityProvider, AgentAudience, AgentCard } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { A2aPeeringService } from '../a2a-peering-service';

const BASE = '/ethos/a2a';

function makeCard(overrides: Partial<AgentCard> = {}): AgentCard {
  const id = overrides.id ?? 'swing-trader';
  return {
    id,
    name: overrides.name ?? 'Swing Trader',
    description: 'A trading agent.',
    protocolVersion: 'a2a/0.1',
    skills: overrides.skills ?? [],
    endpoints: overrides.endpoints ?? {
      jsonRpc: `http://localhost:3000/a2a/${id}`,
      auth: `http://localhost:3000/a2a-auth/${id}`,
    },
    publicKey: 'cHViCg==',
    keyFingerprint: overrides.keyFingerprint ?? '441ac7fe5ce567bfdbe3ca8c6baad206',
    signatureAlg: 'ed25519',
    signature: 'c2lnCg==',
    did: overrides.did ?? {
      id: 'did:key:z6MkExample',
      verificationMethod: {
        id: 'did:key:z6MkExample#key',
        type: 'Ed25519VerificationKey2020',
        controller: 'did:key:z6MkExample',
        publicKeyMultibase: 'z6MkExample',
      },
      service: [],
    },
  };
}

/**
 * Identity stub: `internal` exposes both skills, `trusted-peer` exposes only
 * `market-brief` — mirrors the owner opt-in the real provider applies.
 */
function stubIdentity(id = 'swing-trader'): A2aIdentityProvider {
  return {
    async getIdentity(personalityId: string, audience: AgentAudience): Promise<AgentCard> {
      const all = [
        { name: 'market-brief', description: 'brief' },
        { name: 'private-notes', description: 'secret' },
      ];
      const skills =
        audience === 'internal'
          ? all
          : audience === 'trusted-peer'
            ? all.filter((s) => s.name === 'market-brief')
            : [];
      return makeCard({ id: personalityId || id, skills });
    },
  };
}

function stores(storage = new InMemoryStorage()) {
  return {
    storage,
    allowlist: new StorageA2aAllowlist(storage, BASE),
    peers: new StorageA2aPeerStore(storage, BASE),
  };
}

describe('A2aPeeringService.identity', () => {
  it('returns the shareable identity view with exposed skills + derived well-known URL', async () => {
    const { allowlist, peers } = stores();
    const svc = new A2aPeeringService({ identity: stubIdentity(), allowlist, peers });

    const view = await svc.identity('swing-trader');
    expect(view).toEqual({
      personalityId: 'swing-trader',
      name: 'Swing Trader',
      fingerprint: '441ac7fe5ce567bfdbe3ca8c6baad206',
      wellKnownUrl: 'http://localhost:3000/.well-known/agent-card.json?personality=swing-trader',
      jsonRpcUrl: 'http://localhost:3000/a2a/swing-trader',
      authUrl: 'http://localhost:3000/a2a-auth/swing-trader',
      did: 'did:key:z6MkExample',
      // Only the trusted-peer skill, NOT the internal-only one.
      exposedSkills: ['market-brief'],
    });
  });

  it('maps a PERSONALITY_NOT_FOUND to unknown_personality', async () => {
    const { allowlist, peers } = stores();
    const identity: A2aIdentityProvider = {
      async getIdentity() {
        const { EthosError } = await import('@ethosagent/types');
        throw new EthosError({
          code: 'PERSONALITY_NOT_FOUND',
          cause: 'nope',
          action: 'list ids',
        });
      },
    };
    const svc = new A2aPeeringService({ identity, allowlist, peers });
    await expect(svc.identity('ghost')).rejects.toMatchObject({
      name: 'A2aPeeringError',
      code: 'unknown_personality',
    });
  });
});

describe('A2aPeeringService.previewPeer', () => {
  it('returns the fetched card + fingerprint without writing', async () => {
    const { allowlist, peers } = stores();
    const card = makeCard({ id: 'em', keyFingerprint: 'c4d022bc' });
    const svc = new A2aPeeringService({
      identity: stubIdentity(),
      allowlist,
      peers,
      fetchCard: async () => card,
    });

    const preview = await svc.previewPeer('http://peer/card');
    expect(preview.fingerprint).toBe('c4d022bc');
    expect(preview.card).toBe(card);
    expect(await allowlist.list('swing-trader')).toEqual([]);
    expect(await peers.list('swing-trader')).toEqual([]);
  });
});

describe('A2aPeeringService.addPeer', () => {
  it('writes a DISABLED, full-access allowlist + peer entry and returns the row', async () => {
    const { allowlist, peers } = stores();
    const card = makeCard({ id: 'em', name: 'EM', keyFingerprint: 'c4d022bc' });
    const svc = new A2aPeeringService({
      identity: stubIdentity(),
      allowlist,
      peers,
      fetchCard: async () => card,
    });

    const row = await svc.addPeer('swing-trader', {
      url: 'http://peer/card',
      expectedFingerprint: 'c4d022bc',
      label: 'My EM',
    });
    expect(row).toEqual({
      fingerprint: 'c4d022bc',
      label: 'My EM',
      cardName: 'EM',
      url: 'http://peer/card',
      access: 'full',
      enabled: false,
    });

    const [grant] = await allowlist.list('swing-trader');
    expect(grant).toEqual({
      fingerprint: 'c4d022bc',
      scope: ['*'],
      enabled: false,
      label: 'My EM',
      url: 'http://peer/card',
    });
    const [peer] = await peers.list('swing-trader');
    expect(peer).toMatchObject({ fingerprint: 'c4d022bc', scope: ['*'], enabled: false });
    // Disabled → the hot-path lookup denies.
    expect(await allowlist.lookup('swing-trader', 'c4d022bc')).toBeNull();
  });

  it('throws fingerprint_mismatch and writes NOTHING when the anchor differs', async () => {
    const { allowlist, peers } = stores();
    const svc = new A2aPeeringService({
      identity: stubIdentity(),
      allowlist,
      peers,
      // Simulate the real client's mismatch behaviour when expectedFingerprint set.
      fetchCard: async (_url, opts) => {
        const card = makeCard({ id: 'em', keyFingerprint: 'actual-fp' });
        if (opts?.expectedFingerprint && opts.expectedFingerprint !== card.keyFingerprint) {
          throw new A2aClientError('fingerprint_mismatch', 'mismatch');
        }
        return card;
      },
    });

    await expect(
      svc.addPeer('swing-trader', {
        url: 'http://peer/card',
        expectedFingerprint: 'wrong-fp',
      }),
    ).rejects.toMatchObject({ name: 'A2aPeeringError', code: 'fingerprint_mismatch' });

    expect(await allowlist.list('swing-trader')).toEqual([]);
    expect(await peers.list('swing-trader')).toEqual([]);
  });

  it('maps a bad_signature client error to invalid_card', async () => {
    const { allowlist, peers } = stores();
    const svc = new A2aPeeringService({
      identity: stubIdentity(),
      allowlist,
      peers,
      fetchCard: async () => {
        throw new A2aClientError('bad_signature', 'forged');
      },
    });
    await expect(svc.addPeer('swing-trader', { url: 'http://peer/card' })).rejects.toMatchObject({
      name: 'A2aPeeringError',
      code: 'invalid_card',
    });
  });
});

describe('A2aPeeringService.listPeers', () => {
  it('joins allowlist label/url/enabled with peer cardName + lastSeenAt', async () => {
    const { allowlist, peers } = stores();
    await allowlist.upsert('swing-trader', {
      fingerprint: 'c4d022bc',
      scope: ['*'],
      enabled: true,
      label: 'EM',
      url: 'http://peer/card',
    });
    await peers.upsert('swing-trader', {
      fingerprint: 'c4d022bc',
      card: makeCard({ id: 'em', name: 'EM Card Name' }),
      scope: ['*'],
      enabled: true,
      lastSeenAt: 1234,
    });
    // An allowlist-only entry (no peer store row yet) still lists, without card data.
    await allowlist.upsert('swing-trader', {
      fingerprint: 'nopeer',
      scope: ['*'],
      enabled: false,
    });

    const svc = new A2aPeeringService({ identity: stubIdentity(), allowlist, peers });
    const rows = await svc.listPeers('swing-trader');
    const byFp = new Map(rows.map((r) => [r.fingerprint, r]));
    expect(byFp.get('c4d022bc')).toEqual({
      fingerprint: 'c4d022bc',
      label: 'EM',
      url: 'http://peer/card',
      cardName: 'EM Card Name',
      access: 'full',
      enabled: true,
      lastSeenAt: 1234,
    });
    expect(byFp.get('nopeer')).toEqual({
      fingerprint: 'nopeer',
      access: 'full',
      enabled: false,
    });
  });
});

describe('A2aPeeringService.setEnabled', () => {
  it('disable flips BOTH the allowlist grant and an enabled peer entry', async () => {
    const { allowlist, peers } = stores();
    await allowlist.upsert('swing-trader', { fingerprint: 'fp', scope: ['*'], enabled: true });
    await peers.upsert('swing-trader', {
      fingerprint: 'fp',
      card: makeCard(),
      scope: ['*'],
      enabled: true,
    });

    const svc = new A2aPeeringService({ identity: stubIdentity(), allowlist, peers });
    await svc.setEnabled('swing-trader', 'fp', false);

    expect(await allowlist.lookup('swing-trader', 'fp')).toBeNull();
    expect((await peers.get('swing-trader', 'fp'))?.enabled).toBe(false);
  });

  it('enable flips only the allowlist grant, leaving the peer entry alone', async () => {
    const { allowlist, peers } = stores();
    await allowlist.upsert('swing-trader', { fingerprint: 'fp', scope: ['*'], enabled: false });
    await peers.upsert('swing-trader', {
      fingerprint: 'fp',
      card: makeCard(),
      scope: ['*'],
      enabled: false,
    });

    const svc = new A2aPeeringService({ identity: stubIdentity(), allowlist, peers });
    await svc.setEnabled('swing-trader', 'fp', true);

    expect(await allowlist.lookup('swing-trader', 'fp')).not.toBeNull();
    // Peer entry untouched — the handshake re-enables it on the next mint.
    expect((await peers.get('swing-trader', 'fp'))?.enabled).toBe(false);
  });
});

describe('A2aPeeringService.removePeer', () => {
  it('removes the grant (default-deny) and disables an existing peer entry', async () => {
    const { allowlist, peers } = stores();
    await allowlist.upsert('swing-trader', { fingerprint: 'fp', scope: ['*'], enabled: true });
    await peers.upsert('swing-trader', {
      fingerprint: 'fp',
      card: makeCard(),
      scope: ['*'],
      enabled: true,
    });

    const svc = new A2aPeeringService({ identity: stubIdentity(), allowlist, peers });
    await svc.removePeer('swing-trader', 'fp');

    expect(await allowlist.list('swing-trader')).toEqual([]);
    expect(await allowlist.lookup('swing-trader', 'fp')).toBeNull();
    expect((await peers.get('swing-trader', 'fp'))?.enabled).toBe(false);
  });
});

describe('A2aPeeringService.exposableSkills', () => {
  it('marks each internal skill exposed iff it is on the trusted-peer card', async () => {
    const { allowlist, peers } = stores();
    const svc = new A2aPeeringService({ identity: stubIdentity(), allowlist, peers });
    const skills = await svc.exposableSkills('swing-trader');
    expect(skills).toEqual([
      { name: 'market-brief', exposed: true },
      { name: 'private-notes', exposed: false },
    ]);
  });
});
