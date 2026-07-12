// Phase 9 acceptance gate — REVOCATION drill (plan §15 / O3). A minted token is
// NOT a bearer capability for its full lifetime: the peer-store revocation gate
// (validateToken, wired into the RPC `authenticate` path) re-checks the peer on
// EVERY request. Two independent revocation levers, both proven here:
//
//   (a) disable the peer (`enabled:false`)      → the same unexpired JWT is dead.
//   (b) rotate the peer's `tokenRef` (re-handshake mints a new jti) → the OLD
//       token's jti no longer matches → dead.
//
// Both reach the unauthorized path (`-32001`). The token itself is never mutated
// or re-minted — only the peer-store state changes, and that is enough.

import { describe, expect, it } from 'vitest';
import {
  A2A_METHOD_MESSAGE_SEND,
  type A2aRequestCredentials,
  createA2aRpcService,
  type JsonRpcResponse,
} from '../rpc';
import {
  countingRunner,
  HELLO_SCRIPT,
  makeAgent,
  mintPeerToken,
  newPeerStore,
  type SheetHolder,
  signPop,
  stubIdentity,
  TARGET_ID,
} from './a2a-fixtures';

function syncSend() {
  return {
    jsonrpc: '2.0' as const,
    id: 1,
    method: A2A_METHOD_MESSAGE_SEND,
    params: { skill: 'search', message: 'hi' },
  };
}

function errorCode(res: JsonRpcResponse): number | undefined {
  return 'error' in res ? res.error.code : undefined;
}

describe('Revocation drill (plan §15 / O3)', () => {
  it('accepts a valid token, then rejects it once the peer is disabled', async () => {
    const target = makeAgent(TARGET_ID);
    const peer = makeAgent('peer-a');
    const sheet: SheetHolder = { skills: ['search'] };
    const peerStore = newPeerStore();
    const clock = { t: Date.now() };
    const service = createA2aRpcService({
      getIdentity: stubIdentity(target, sheet),
      peerStore,
      runner: countingRunner(HELLO_SCRIPT, { runs: 0 }),
      now: () => clock.t,
    });
    const minted = await mintPeerToken(target, peer, ['search'], peerStore, { now: clock.t });

    const send = (ts: number): Promise<JsonRpcResponse> => {
      const creds: A2aRequestCredentials = {
        token: minted.token,
        proofSignature: signPop(peer, A2A_METHOD_MESSAGE_SEND, minted.claims.jti, ts),
        proofTimestamp: ts,
      };
      return service.handleRpc(TARGET_ID, syncSend(), creds);
    };

    // Baseline — the token is accepted while the peer is enabled.
    const ok = await send(clock.t);
    expect('result' in ok).toBe(true);

    // Disable the peer (revocation lever a). The token is still cryptographically
    // valid and unexpired — only the peer-store `enabled` flag flipped.
    const entry = await peerStore.get(TARGET_ID, peer.fingerprint);
    if (!entry) throw new Error('peer entry missing');
    await peerStore.upsert(TARGET_ID, { ...entry, enabled: false });

    clock.t += 1000; // fresh PoP window (proofs are single-use)
    const denied = await send(clock.t);
    expect(errorCode(denied)).toBe(-32001);
  });

  it('rejects the old token after the peer tokenRef is rotated (re-handshake)', async () => {
    const target = makeAgent(TARGET_ID);
    const peer = makeAgent('peer-a');
    const sheet: SheetHolder = { skills: ['search'] };
    const peerStore = newPeerStore();
    const clock = { t: Date.now() };
    const service = createA2aRpcService({
      getIdentity: stubIdentity(target, sheet),
      peerStore,
      runner: countingRunner(HELLO_SCRIPT, { runs: 0 }),
      now: () => clock.t,
    });
    const minted = await mintPeerToken(target, peer, ['search'], peerStore, { now: clock.t });

    const send = (ts: number): Promise<JsonRpcResponse> => {
      const creds: A2aRequestCredentials = {
        token: minted.token,
        proofSignature: signPop(peer, A2A_METHOD_MESSAGE_SEND, minted.claims.jti, ts),
        proofTimestamp: ts,
      };
      return service.handleRpc(TARGET_ID, syncSend(), creds);
    };

    // Baseline — the token is accepted.
    const ok = await send(clock.t);
    expect('result' in ok).toBe(true);

    // A re-handshake mints a NEW jti — simulate it by rotating the peer's
    // tokenRef while leaving the peer enabled. The old token's jti no longer
    // matches → the revocation gate rejects it.
    const entry = await peerStore.get(TARGET_ID, peer.fingerprint);
    if (!entry) throw new Error('peer entry missing');
    await peerStore.upsert(TARGET_ID, { ...entry, enabled: true, tokenRef: 'rotated-new-jti' });

    clock.t += 1000;
    const denied = await send(clock.t);
    expect(errorCode(denied)).toBe(-32001);
  });
});
