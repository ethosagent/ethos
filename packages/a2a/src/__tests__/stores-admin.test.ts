// Stage-1a data-layer foundation (plan §2a / §3 / §11): the admin/management
// surfaces (list / upsert / setEnabled / remove), the debounced `lastSeenAt`
// stamp, and the `*` full-access scope — all exercised WITHOUT regressing the
// minimal read-only handshake hot path.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it, vi } from 'vitest';
import { createA2aAuthService } from '../auth';
import { signStruct } from '../crypto';
import {
  A2A_METHOD_MESSAGE_SEND,
  type A2aRequestCredentials,
  createA2aRpcService,
  type JsonRpcResponse,
} from '../rpc';
import {
  type A2aPeerStore,
  MemoryNonceStore,
  type PeerEntry,
  StorageA2aAllowlist,
  StorageA2aPeerStore,
} from '../stores';
import {
  type Agent,
  countingRunner,
  HELLO_SCRIPT,
  makeAgent,
  mintPeerToken,
  newPeerStore,
  type SheetHolder,
  signPop,
  stubAllowlist,
  stubIdentity,
  stubSecrets,
  TARGET_ID,
} from './a2a-fixtures';

const CARD = makeAgent('peer-card').card;

function peerEntry(fingerprint: string, extra: Partial<PeerEntry> = {}): PeerEntry {
  return { fingerprint, card: CARD, scope: [], enabled: false, ...extra };
}

function errorCode(res: JsonRpcResponse): number | undefined {
  return 'error' in res ? res.error.code : undefined;
}

describe('A2aAllowlistAdmin — list / setEnabled / remove', () => {
  it('list returns every entry (enabled + disabled), including the optional label + url', async () => {
    const allowlist = new StorageA2aAllowlist(new InMemoryStorage(), '/ethos/a2a');
    await allowlist.upsert('pid', {
      fingerprint: 'fp1',
      scope: ['*'],
      enabled: false,
      label: 'EM',
      url: 'https://peer.example/.well-known/agent-card.json?personality=em',
    });
    await allowlist.upsert('pid', { fingerprint: 'fp2', scope: ['search'], enabled: true });

    const rows = await allowlist.list('pid');
    expect(rows).toHaveLength(2);
    const byFp = new Map(rows.map((r) => [r.fingerprint, r]));
    expect(byFp.get('fp1')).toEqual({
      fingerprint: 'fp1',
      scope: ['*'],
      enabled: false,
      label: 'EM',
      url: 'https://peer.example/.well-known/agent-card.json?personality=em',
    });
    expect(byFp.get('fp2')).toEqual({ fingerprint: 'fp2', scope: ['search'], enabled: true });
  });

  it('setEnabled flips one entry and preserves scope + label + url', async () => {
    const allowlist = new StorageA2aAllowlist(new InMemoryStorage(), '/ethos/a2a');
    await allowlist.upsert('pid', {
      fingerprint: 'fp1',
      scope: ['a'],
      enabled: false,
      label: 'X',
      url: 'https://x.example/card',
    });

    // Disabled → lookup denies.
    expect(await allowlist.lookup('pid', 'fp1')).toBeNull();

    await allowlist.setEnabled('pid', 'fp1', true);
    const [row] = await allowlist.list('pid');
    expect(row).toEqual({
      fingerprint: 'fp1',
      scope: ['a'],
      enabled: true,
      label: 'X',
      url: 'https://x.example/card',
    });
    // Now enabled → lookup grants (label stripped: lookup returns a PeerGrant).
    expect(await allowlist.lookup('pid', 'fp1')).toEqual({
      fingerprint: 'fp1',
      scope: ['a'],
      enabled: true,
    });
  });

  it('setEnabled is a no-op for an absent entry (no throw, nothing written)', async () => {
    const allowlist = new StorageA2aAllowlist(new InMemoryStorage(), '/ethos/a2a');
    await expect(allowlist.setEnabled('pid', 'ghost', true)).resolves.toBeUndefined();
    expect(await allowlist.list('pid')).toEqual([]);
  });

  it('remove deletes the entry', async () => {
    const allowlist = new StorageA2aAllowlist(new InMemoryStorage(), '/ethos/a2a');
    await allowlist.upsert('pid', { fingerprint: 'fp1', scope: [], enabled: true });
    await allowlist.upsert('pid', { fingerprint: 'fp2', scope: [], enabled: true });

    await allowlist.remove('pid', 'fp1');
    const rows = await allowlist.list('pid');
    expect(rows.map((r) => r.fingerprint)).toEqual(['fp2']);
    expect(await allowlist.lookup('pid', 'fp1')).toBeNull();
  });

  it('label round-trips upsert → list, and the hot-path lookup still grants for a labeled entry', async () => {
    const allowlist = new StorageA2aAllowlist(new InMemoryStorage(), '/ethos/a2a');
    await allowlist.upsert('pid', {
      fingerprint: 'fpx',
      scope: ['brief'],
      enabled: true,
      label: 'Peer X',
    });

    const [row] = await allowlist.list('pid');
    expect(row?.label).toBe('Peer X');
    // lookup ignores the unknown `label` field and returns a valid PeerGrant.
    expect(await allowlist.lookup('pid', 'fpx')).toEqual({
      fingerprint: 'fpx',
      scope: ['brief'],
      enabled: true,
    });
  });
});

describe('A2aPeerStoreAdmin — list', () => {
  it('list returns every peer entry for the personality', async () => {
    const peers = new StorageA2aPeerStore(new InMemoryStorage(), '/ethos/a2a');
    await peers.upsert('pid', peerEntry('p1'));
    await peers.upsert('pid', peerEntry('p2', { enabled: true, lastSeenAt: 5 }));

    const rows = await peers.list('pid');
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.fingerprint))).toEqual(new Set(['p1', 'p2']));
    expect(rows.find((r) => r.fingerprint === 'p2')?.lastSeenAt).toBe(5);
  });

  it('list returns [] for a personality with no peers', async () => {
    const peers = new StorageA2aPeerStore(new InMemoryStorage(), '/ethos/a2a');
    expect(await peers.list('nobody')).toEqual([]);
  });
});

describe('touchLastSeen — debounced inbound stamp (plan §11)', () => {
  // Realistic wall-clock base (well past the 60s debounce), matching production
  // where `now` is `Date.now()`.
  const T0 = 1_700_000_000_000;

  it('stamps on first call, skips a rewrite within the window, updates after it', async () => {
    const storage = new InMemoryStorage();
    const peers = new StorageA2aPeerStore(storage, '/ethos/a2a');
    await peers.upsert('pid', peerEntry('p1'));
    const writeSpy = vi.spyOn(storage, 'writeAtomic');

    // First call: no prior lastSeenAt → writes.
    await peers.touchLastSeen('pid', 'p1', T0);
    expect((await peers.get('pid', 'p1'))?.lastSeenAt).toBe(T0);
    expect(writeSpy).toHaveBeenCalledTimes(1);

    // Second call within 60s: does NOT rewrite (timestamp unchanged, no write).
    await peers.touchLastSeen('pid', 'p1', T0 + 59_999);
    expect((await peers.get('pid', 'p1'))?.lastSeenAt).toBe(T0);
    expect(writeSpy).toHaveBeenCalledTimes(1);

    // Call after the window: updates.
    await peers.touchLastSeen('pid', 'p1', T0 + 60_000);
    expect((await peers.get('pid', 'p1'))?.lastSeenAt).toBe(T0 + 60_000);
    expect(writeSpy).toHaveBeenCalledTimes(2);
  });

  it('is a no-op for an absent entry (no throw, no write)', async () => {
    const storage = new InMemoryStorage();
    const peers = new StorageA2aPeerStore(storage, '/ethos/a2a');
    const writeSpy = vi.spyOn(storage, 'writeAtomic');
    await expect(peers.touchLastSeen('pid', 'ghost', T0)).resolves.toBeUndefined();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('preserves all other fields when it rewrites', async () => {
    const peers = new StorageA2aPeerStore(new InMemoryStorage(), '/ethos/a2a');
    await peers.upsert('pid', peerEntry('p1', { enabled: true, scope: ['x'], tokenRef: 'jti-1' }));
    await peers.touchLastSeen('pid', 'p1', T0);
    const entry = await peers.get('pid', 'p1');
    expect(entry).toMatchObject({
      fingerprint: 'p1',
      enabled: true,
      scope: ['x'],
      tokenRef: 'jti-1',
      lastSeenAt: T0,
    });
  });
});

describe('`*` full-access scope (plan §2a)', () => {
  it('invokes an exposed skill but stays bounded by exposure (non-exposed → -32003)', async () => {
    const target = makeAgent(TARGET_ID);
    const peer = makeAgent('peer-a');
    // Sheet exposes ONLY `search` — `admin` is not exposed by the owner.
    const sheet: SheetHolder = { skills: ['search'] };
    const peerStore = newPeerStore();
    const counter = { runs: 0 };
    const clock = { t: Date.now() };
    const service = createA2aRpcService({
      getIdentity: stubIdentity(target, sheet),
      peerStore,
      runner: countingRunner(HELLO_SCRIPT, counter),
      now: () => clock.t,
    });
    // A wildcard grant — the token carries scope ['*'] verbatim.
    const minted = await mintPeerToken(target, peer, ['*'], peerStore, { now: clock.t });

    const call = (skill: string, ts: number) =>
      service.handleRpc(
        TARGET_ID,
        {
          jsonrpc: '2.0',
          id: 1,
          method: A2A_METHOD_MESSAGE_SEND,
          params: { skill, message: 'hi' },
        },
        {
          token: minted.token,
          proofSignature: signPop(peer, A2A_METHOD_MESSAGE_SEND, minted.claims.jti, ts),
          proofTimestamp: ts,
        },
      );

    // Exposed skill → `*` reaches it.
    const ok = await call('search', clock.t);
    expect('error' in ok).toBe(false);
    expect(counter.runs).toBe(1);

    // Non-exposed skill → sheet-intersection still rejects (`*` is bounded).
    clock.t += 1;
    const denied = await call('admin', clock.t);
    expect(errorCode(denied)).toBe(-32003);
    expect(counter.runs).toBe(1);
  });
});

// Drive a full challenge → response handshake to completion, returning the
// respond() result. `peerStore` is injected so a throwing wrapper can be tested.
async function runHandshake(
  target: Agent,
  peer: Agent,
  peerStore: A2aPeerStore,
  clock: { t: number },
) {
  const service = createA2aAuthService({
    secrets: stubSecrets({ [`a2a/${TARGET_ID}/private-key`]: target.privateKeyPem }),
    allowlist: stubAllowlist(
      new Map([
        [peer.fingerprint, { fingerprint: peer.fingerprint, scope: ['search'], enabled: true }],
      ]),
    ),
    peerStore,
    nonces: new MemoryNonceStore({ now: () => clock.t, ttlMs: 60_000 }),
    now: () => clock.t,
  });
  const ch = await service.challenge(TARGET_ID, { card: peer.card });
  if (!ch.ok) throw new Error('challenge failed');
  const sig = signStruct(
    {
      context: 'a2a-auth-challenge',
      nonce: ch.nonce,
      target_agent_id: TARGET_ID,
      timestamp: clock.t,
    },
    peer.privateKeyPem,
  );
  return service.respond(TARGET_ID, {
    nonce: ch.nonce,
    timestamp: clock.t,
    signature: sig,
    fingerprint: peer.fingerprint,
  });
}

describe('touchLastSeen stamping + fail-open on the handshake path (plan §11)', () => {
  it('a successful respond() stamps lastSeenAt on the peer entry', async () => {
    const target = makeAgent(TARGET_ID);
    const peer = makeAgent('peer-a');
    const peerStore = newPeerStore();
    const clock = { t: Date.now() };

    const res = await runHandshake(target, peer, peerStore, clock);
    expect(res.ok).toBe(true);
    expect((await peerStore.get(TARGET_ID, peer.fingerprint))?.lastSeenAt).toBe(clock.t);
  });

  it('a throwing touchLastSeen does not change the handshake result', async () => {
    const target = makeAgent(TARGET_ID);
    const peer = makeAgent('peer-a');
    const base = newPeerStore();
    const clock = { t: Date.now() };
    const throwingStore: A2aPeerStore = {
      get: (p, f) => base.get(p, f),
      upsert: (p, e) => base.upsert(p, e),
      async touchLastSeen() {
        throw new Error('boom');
      },
    };

    const res = await runHandshake(target, peer, throwingStore, clock);
    expect(res.ok).toBe(true);
    // The mint still enabled the peer despite the touch failure.
    expect((await base.get(TARGET_ID, peer.fingerprint))?.enabled).toBe(true);
  });
});

describe('touchLastSeen fail-open on the RPC path (plan §11)', () => {
  it('a throwing touchLastSeen does not change the RPC result', async () => {
    const target = makeAgent(TARGET_ID);
    const peer = makeAgent('peer-a');
    const sheet: SheetHolder = { skills: ['search'] };
    const base = newPeerStore();
    const counter = { runs: 0 };
    const clock = { t: Date.now() };
    // Same underlying storage as `base` for get/upsert; touchLastSeen throws.
    const throwingStore: A2aPeerStore = {
      get: (p, f) => base.get(p, f),
      upsert: (p, e) => base.upsert(p, e),
      async touchLastSeen() {
        throw new Error('boom');
      },
    };
    const service = createA2aRpcService({
      getIdentity: stubIdentity(target, sheet),
      peerStore: throwingStore,
      runner: countingRunner(HELLO_SCRIPT, counter),
      now: () => clock.t,
    });
    const minted = await mintPeerToken(target, peer, ['search'], base, { now: clock.t });
    const ts = clock.t;
    const res = await service.handleRpc(
      TARGET_ID,
      {
        jsonrpc: '2.0',
        id: 1,
        method: A2A_METHOD_MESSAGE_SEND,
        params: { skill: 'search', message: 'hi' },
      },
      {
        token: minted.token,
        proofSignature: signPop(peer, A2A_METHOD_MESSAGE_SEND, minted.claims.jti, ts),
        proofTimestamp: ts,
      } satisfies A2aRequestCredentials,
    );

    expect('error' in res).toBe(false);
    expect(counter.runs).toBe(1);
  });
});
