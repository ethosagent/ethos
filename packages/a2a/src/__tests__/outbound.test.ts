// Phase 7 acceptance gate — the OUTBOUND client driven against a REAL in-process
// server (the same auth + rpc routers the inbound phases ship). No network: the
// client's `fetchImpl` dispatches into a Hono app via `app.request`.
//
// Covered:
//   (a) full round-trip — connect (fetch card + handshake) → sendMessage(sync).
//   (b) delegation containment — the client signs depth+1 and the rpc server
//       admits it; a second call exhausts the fan-out budget → the client throws
//       `fanout_exhausted` and makes NO HTTP call.
// Stolen/wrong-key attacks are covered server-side (auth/rpc tests); not repeated.

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createA2aAuthRouter } from '../auth';
import { A2aDelegationGuard } from '../delegation';
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

/**
 * Assemble a real server for `target`, approving `initiator` on the allowlist.
 * The auth + rpc routers share ONE peer store so the handshake-minted token is
 * validatable by the rpc gate. Returns the Hono app + the counting runner state.
 */
function makeServer(
  target: Agent,
  initiator: Agent,
  sheet: SheetHolder,
  clock: { t: number },
  opts: { rpcGuard?: A2aDelegationGuard } = {},
) {
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
      ...(opts.rpcGuard ? { delegationGuard: opts.rpcGuard } : {}),
    }),
  );
  app.route('/', createA2aWellKnownRouter({ getIdentity: stubIdentity(target, sheet) }));

  return { app, counter };
}

describe('A2aOutboundClient — full round-trip (handshake → sync task)', () => {
  it('connects, verifies the card, handshakes for a token, and gets the echoed result', async () => {
    const target = makeAgent(TARGET_ID);
    const initiator = makeAgent('initiator');
    const sheet: SheetHolder = { skills: ['search'] };
    const clock = { t: Date.now() };
    const { app, counter } = makeServer(target, initiator, sheet, clock);

    const fetchImpl: typeof fetch = async (input, init) => app.request(toUrl(input), init);
    const client = new A2aOutboundClient({ fetchImpl, now: () => clock.t });

    const session = await client.connect({
      wellKnownUrl: WELL_KNOWN_URL,
      expectedFingerprint: target.fingerprint,
      myCard: initiator.card,
      myPrivateKeyPem: initiator.privateKeyPem,
    });
    expect(session.peerCard.id).toBe(TARGET_ID);
    expect(session.token).toBeTruthy();

    const res = await client.sendMessage({
      session,
      myPrivateKeyPem: initiator.privateKeyPem,
      skill: 'search',
      message: 'hi',
    });

    expect(res.ok).toBe(true);
    if (res.ok && res.mode === 'sync') {
      expect(res.state).toBe('completed');
      expect(res.text).toBe('hello world');
    }
    expect(counter.runs).toBe(1);
  });

  it('maps a JSON-RPC error (out-of-scope skill) to { ok:false, code }', async () => {
    const target = makeAgent(TARGET_ID);
    const initiator = makeAgent('initiator');
    const sheet: SheetHolder = { skills: ['search'] };
    const clock = { t: Date.now() };
    const { app } = makeServer(target, initiator, sheet, clock);

    const fetchImpl: typeof fetch = async (input, init) => app.request(toUrl(input), init);
    const client = new A2aOutboundClient({ fetchImpl, now: () => clock.t });
    const session = await client.connect({
      wellKnownUrl: WELL_KNOWN_URL,
      myCard: initiator.card,
      myPrivateKeyPem: initiator.privateKeyPem,
    });

    // `write` is not in the granted scope → FORBIDDEN_SCOPE (-32003).
    const res = await client.sendMessage({
      session,
      myPrivateKeyPem: initiator.privateKeyPem,
      skill: 'write',
      message: 'hi',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe(-32003);
  });
});

describe('A2aOutboundClient — delegation containment (P8)', () => {
  it('signs depth+1 (admitted by the server), then throws fanout_exhausted with NO HTTP call', async () => {
    const target = makeAgent(TARGET_ID);
    const initiator = makeAgent('initiator');
    const sheet: SheetHolder = { skills: ['search'] };
    const clock = { t: Date.now() };
    // The server's own guard (responder side) admits the depth-1 envelope.
    const { app, counter } = makeServer(target, initiator, sheet, clock, {
      rpcGuard: new A2aDelegationGuard(),
    });

    // The initiator's fan-out guard — a distinct process/instance from the
    // server's. Budget 1: exactly one onward call is allowed under the trace.
    const initiatorGuard = new A2aDelegationGuard({ fanOutBudget: 1 });
    const traceId = 'trace-out';

    const rpcHeaders: Headers[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = toUrl(input);
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/a2a/')) {
        rpcHeaders.push(new Headers(init?.headers));
      }
      return app.request(url, init);
    };
    const client = new A2aOutboundClient({ fetchImpl, now: () => clock.t });
    const session = await client.connect({
      wellKnownUrl: WELL_KNOWN_URL,
      myCard: initiator.card,
      myPrivateKeyPem: initiator.privateKeyPem,
    });

    const delegation = {
      traceId,
      depth: 0,
      reserveOutbound: () => initiatorGuard.reserveOutbound(traceId),
    };

    // First onward call — reserves the budget, signs depth+1, server admits.
    const first = await client.sendMessage({
      session,
      myPrivateKeyPem: initiator.privateKeyPem,
      skill: 'search',
      message: 'hi',
      delegation,
    });
    expect(first.ok).toBe(true);
    expect(counter.runs).toBe(1);
    expect(rpcHeaders).toHaveLength(1);
    const headers = rpcHeaders[0] ?? new Headers();
    expect(headers.get('x-a2a-trace-id')).toBe(traceId);
    expect(headers.get('x-a2a-delegation-depth')).toBe('1');
    expect(headers.get('x-a2a-delegation-sig')).not.toBeNull();

    // Second onward call — budget exhausted → throw BEFORE any HTTP.
    let thrown: unknown;
    try {
      await client.sendMessage({
        session,
        myPrivateKeyPem: initiator.privateKeyPem,
        skill: 'search',
        message: 'hi again',
        delegation,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(A2aOutboundError);
    if (thrown instanceof A2aOutboundError) expect(thrown.code).toBe('fanout_exhausted');
    // No second HTTP call, no second runner invocation.
    expect(rpcHeaders).toHaveLength(1);
    expect(counter.runs).toBe(1);
  });
});
