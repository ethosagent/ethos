// Phase 8 acceptance gate — the MESH self-loop guard (plan §14).
//
// Calling MY OWN agent (peer fingerprint == my fingerprint) is refused by
// default and allowed only behind the explicit `allowSelfLoop` flag. The client
// is driven against a REAL in-process server (the same auth + rpc routers the
// inbound phases ship), no network.

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createA2aAuthRouter } from '../auth';
import { A2aOutboundClient, A2aOutboundError } from '../outbound';
import { createA2aRpcRouter } from '../rpc';
import { MemoryNonceStore, type PeerGrant } from '../stores';
import { createA2aWellKnownRouter } from '../well-known';
import {
  type Agent,
  countingRunner,
  HELLO_SCRIPT,
  makeAgent,
  newPeerStore,
  type SheetHolder,
  stubAllowlist,
  stubIdentity,
  stubSecrets,
  TARGET_ID,
} from './a2a-fixtures';

const WELL_KNOWN_URL = `http://localhost:8787/.well-known/agent-card.json?personality=${TARGET_ID}`;

function toUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** A server that approves `initiator` (here: the agent itself) on the allowlist. */
function makeServer(target: Agent, initiator: Agent, sheet: SheetHolder, clock: { t: number }) {
  const peerStore = newPeerStore();
  const counter = { runs: 0 };
  const approved = new Map<string, PeerGrant>([
    [
      initiator.fingerprint,
      { fingerprint: initiator.fingerprint, scope: ['search'], enabled: true },
    ],
  ]);
  const app = new Hono();
  app.route(
    '/a2a-auth',
    createA2aAuthRouter({
      secrets: stubSecrets({ [`a2a/${target.id}/private-key`]: target.privateKeyPem }),
      allowlist: stubAllowlist(approved),
      peerStore,
      nonces: new MemoryNonceStore({ now: () => clock.t }),
      now: () => clock.t,
    }),
  );
  app.route(
    '/a2a',
    createA2aRpcRouter({
      getIdentity: stubIdentity(target, sheet),
      peerStore,
      runner: countingRunner(HELLO_SCRIPT, counter),
      now: () => clock.t,
    }),
  );
  app.route('/', createA2aWellKnownRouter({ getIdentity: stubIdentity(target, sheet) }));
  return { app, counter };
}

describe('A2aOutboundClient — self-loop guard (plan §14)', () => {
  it('refuses to call my own agent by default (fingerprints match)', async () => {
    const me = makeAgent(TARGET_ID);
    const sheet: SheetHolder = { skills: ['search'] };
    const clock = { t: Date.now() };
    const { app, counter } = makeServer(me, me, sheet, clock);
    const fetchImpl: typeof fetch = async (input, init) => app.request(toUrl(input), init);
    const client = new A2aOutboundClient({ fetchImpl, now: () => clock.t });

    let thrown: unknown;
    try {
      await client.connect({
        wellKnownUrl: WELL_KNOWN_URL,
        expectedFingerprint: me.fingerprint,
        myCard: me.card,
        myPrivateKeyPem: me.privateKeyPem,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(A2aOutboundError);
    if (thrown instanceof A2aOutboundError) expect(thrown.code).toBe('self_loop_forbidden');
    // No handshake, no runner invocation.
    expect(counter.runs).toBe(0);
  });

  it('allows the self-loop when allowSelfLoop is set', async () => {
    const me = makeAgent(TARGET_ID);
    const sheet: SheetHolder = { skills: ['search'] };
    const clock = { t: Date.now() };
    const { app, counter } = makeServer(me, me, sheet, clock);
    const fetchImpl: typeof fetch = async (input, init) => app.request(toUrl(input), init);
    const client = new A2aOutboundClient({ fetchImpl, now: () => clock.t });

    const session = await client.connect({
      wellKnownUrl: WELL_KNOWN_URL,
      expectedFingerprint: me.fingerprint,
      myCard: me.card,
      myPrivateKeyPem: me.privateKeyPem,
      allowSelfLoop: true,
    });
    expect(session.token).toBeTruthy();

    const res = await client.sendMessage({
      session,
      myPrivateKeyPem: me.privateKeyPem,
      skill: 'search',
      message: 'hi me',
    });
    expect(res.ok).toBe(true);
    if (res.ok && res.mode === 'sync') expect(res.state).toBe('completed');
    expect(counter.runs).toBe(1);
  });
});
