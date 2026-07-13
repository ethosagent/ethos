import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import type { A2aIdentityView, A2aPeeringService, A2aPeerRow } from '@ethosagent/wiring';
import { A2aPeeringError } from '@ethosagent/wiring';
import { call, ORPCError } from '@orpc/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebApi, WebTokenRepository } from '../../index';
import type { A2aControl } from '../../routes/route-module';
import { a2aRouter } from '../../rpc/a2a';
import type { RpcContext } from '../../rpc/context';
import {
  makeStubAgentLoop,
  makeStubMemoryProvider,
  makeStubPersonalityRegistry,
} from '../test-helpers';

// A2A peering RPC namespace. The trust logic lives in the wiring service; these
// tests verify the RPC layer marshals I/O, maps `A2aPeeringError` to typed oRPC
// errors, gates on service availability, and rides the `/rpc` cookie auth. The
// service itself is a stub — its own behaviour is covered in
// packages/wiring/src/__tests__/a2a-peering-service.test.ts.

const IDENTITY: A2aIdentityView = {
  personalityId: 'swing-trader',
  name: 'Swing Trader',
  fingerprint: '441ac7fe5ce567bfdbe3ca8c6baad206',
  wellKnownUrl: 'http://localhost:3000/.well-known/agent-card.json?personality=swing-trader',
  jsonRpcUrl: 'http://localhost:3000/a2a/swing-trader',
  authUrl: 'http://localhost:3000/a2a-auth/swing-trader',
  did: 'did:key:z6MkExample',
  exposedSkills: ['market-brief'],
};

const PEER_ROW: A2aPeerRow = {
  fingerprint: 'c4d022bcabc',
  label: 'EM',
  cardName: 'Engineering Manager',
  url: 'http://peer.example/.well-known/agent-card.json',
  access: 'full',
  enabled: false,
  lastSeenAt: 1_700_000_000_000,
};

interface StubCalls {
  setEnabled: Array<[string, string, boolean]>;
  removePeer: Array<[string, string]>;
  addPeer: Array<[string, { url: string; expectedFingerprint?: string; label?: string }]>;
  controlSetEnabled: boolean[];
}

interface StubOptions {
  /** Override individual peering methods (e.g. to throw). */
  peering?: Partial<A2aPeeringService>;
  /** Initial live-enabled state for the control stub. */
  enabled?: boolean;
  /** Omit the peering service to exercise the NOT_AVAILABLE path. */
  omitPeering?: boolean;
  /** Omit the control to exercise the NOT_AVAILABLE path. */
  omitControl?: boolean;
}

function makeContext(opts: StubOptions = {}): { context: RpcContext; calls: StubCalls } {
  const calls: StubCalls = {
    setEnabled: [],
    removePeer: [],
    addPeer: [],
    controlSetEnabled: [],
  };
  let enabled = opts.enabled ?? false;

  const peering = {
    identity: async () => IDENTITY,
    listPeers: async () => [PEER_ROW],
    previewPeer: async () => ({
      card: {
        id: 'em',
        name: 'Engineering Manager',
        description: 'Ships things',
        protocolVersion: 'a2a/0.1',
        skills: [{ name: 'secret-skill', description: 'x' }],
        endpoints: { jsonRpc: 'http://peer/a2a/em', auth: 'http://peer/a2a-auth/em' },
        publicKey: 'pub',
        keyFingerprint: 'c4d022bcabc',
        signatureAlg: 'ed25519' as const,
        signature: 'sig',
        did: { id: 'did:key:z6MkPeer' },
      },
      fingerprint: 'c4d022bcabc',
    }),
    addPeer: async (
      personalityId: string,
      args: { url: string; expectedFingerprint?: string; label?: string },
    ) => {
      calls.addPeer.push([personalityId, args]);
      return PEER_ROW;
    },
    setEnabled: async (personalityId: string, fingerprint: string, value: boolean) => {
      calls.setEnabled.push([personalityId, fingerprint, value]);
    },
    removePeer: async (personalityId: string, fingerprint: string) => {
      calls.removePeer.push([personalityId, fingerprint]);
    },
    exposableSkills: async () => [
      { name: 'market-brief', exposed: true },
      { name: 'private-tool', exposed: false },
    ],
    ...opts.peering,
  };

  const control: A2aControl = {
    isEnabled: () => enabled,
    setEnabled: async (value: boolean) => {
      calls.controlSetEnabled.push(value);
      enabled = value;
    },
  };

  // Cast: the handlers only touch `a2aPeering` + `a2aControl`; the full
  // RpcContext would drag in every service for a unit-level test.
  const context = {
    ...(opts.omitPeering ? {} : { a2aPeering: peering as unknown as A2aPeeringService }),
    ...(opts.omitControl ? {} : { a2aControl: control }),
  } as unknown as RpcContext;

  return { context, calls };
}

describe('a2a RPC — settings toggle', () => {
  it('settings.get reflects the live control state', async () => {
    const { context } = makeContext({ enabled: true });
    const res = await call(a2aRouter.settings.get, {}, { context });
    expect(res).toEqual({ enabled: true });
  });

  it('settings.set flips + persists, then returns the live state', async () => {
    const { context, calls } = makeContext({ enabled: false });
    const res = await call(a2aRouter.settings.set, { enabled: true }, { context });
    expect(res).toEqual({ enabled: true });
    expect(calls.controlSetEnabled).toEqual([true]);
    // Round-trip: a subsequent get sees the flipped state.
    const after = await call(a2aRouter.settings.get, {}, { context });
    expect(after).toEqual({ enabled: true });
  });
});

describe('a2a RPC — reads', () => {
  it('identity returns the shareable view', async () => {
    const { context } = makeContext();
    const res = await call(a2aRouter.identity, { personalityId: 'swing-trader' }, { context });
    expect(res).toEqual(IDENTITY);
  });

  it('peers.list returns rows', async () => {
    const { context } = makeContext();
    const res = await call(a2aRouter.peers.list, { personalityId: 'swing-trader' }, { context });
    expect(res).toEqual([PEER_ROW]);
  });

  it('peers.preview returns only fingerprint + name + description (not the card)', async () => {
    const { context } = makeContext();
    const res = await call(
      a2aRouter.peers.preview,
      { url: 'http://peer.example/card' },
      { context },
    );
    expect(res).toEqual({
      fingerprint: 'c4d022bcabc',
      name: 'Engineering Manager',
      description: 'Ships things',
    });
    // The signed card, its skills, and its public key must NOT leak.
    expect(Object.keys(res).sort()).toEqual(['description', 'fingerprint', 'name']);
  });

  it('skills.listExposable returns the exposure flags', async () => {
    const { context } = makeContext();
    const res = await call(
      a2aRouter.skills.listExposable,
      { personalityId: 'swing-trader' },
      { context },
    );
    expect(res).toEqual([
      { name: 'market-brief', exposed: true },
      { name: 'private-tool', exposed: false },
    ]);
  });
});

describe('a2a RPC — mutations', () => {
  it('peers.add happy path forwards args + returns the row', async () => {
    const { context, calls } = makeContext();
    const res = await call(
      a2aRouter.peers.add,
      {
        personalityId: 'swing-trader',
        url: 'http://peer.example/card',
        expectedFingerprint: 'c4d022bcabc',
        label: 'EM',
      },
      { context },
    );
    expect(res).toEqual(PEER_ROW);
    expect(calls.addPeer).toEqual([
      [
        'swing-trader',
        { url: 'http://peer.example/card', expectedFingerprint: 'c4d022bcabc', label: 'EM' },
      ],
    ]);
  });

  it('peers.add fingerprint_mismatch → 400 FINGERPRINT_MISMATCH', async () => {
    const { context } = makeContext({
      peering: {
        addPeer: async () => {
          throw new A2aPeeringError('fingerprint_mismatch', 'Fingerprint does not match');
        },
      },
    });
    try {
      await call(
        a2aRouter.peers.add,
        {
          personalityId: 'swing-trader',
          url: 'http://peer.example/card',
          expectedFingerprint: 'deadbeef',
        },
        { context },
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ORPCError);
      const orpc = err as ORPCError<string, unknown>;
      expect(orpc.code).toBe('FINGERPRINT_MISMATCH');
      expect(orpc.status).toBe(400);
      expect(orpc.message).toBe('Fingerprint does not match');
    }
  });

  it('unknown_personality → 404 NOT_FOUND', async () => {
    const { context } = makeContext({
      peering: {
        identity: async () => {
          throw new A2aPeeringError('unknown_personality', 'No such personality');
        },
      },
    });
    try {
      await call(a2aRouter.identity, { personalityId: 'ghost' }, { context });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ORPCError);
      expect((err as ORPCError<string, unknown>).code).toBe('NOT_FOUND');
      expect((err as ORPCError<string, unknown>).status).toBe(404);
    }
  });

  it('fetch_failed → 502 A2A_UPSTREAM_ERROR', async () => {
    const { context } = makeContext({
      peering: {
        previewPeer: async () => {
          throw new A2aPeeringError('fetch_failed', 'Could not reach peer');
        },
      },
    });
    try {
      await call(a2aRouter.peers.preview, { url: 'http://down.example' }, { context });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ORPCError);
      expect((err as ORPCError<string, unknown>).code).toBe('A2A_UPSTREAM_ERROR');
      expect((err as ORPCError<string, unknown>).status).toBe(502);
    }
  });

  it('peers.setEnabled calls through', async () => {
    const { context, calls } = makeContext();
    const res = await call(
      a2aRouter.peers.setEnabled,
      { personalityId: 'swing-trader', fingerprint: 'c4d022bcabc', enabled: true },
      { context },
    );
    expect(res).toEqual({ ok: true });
    expect(calls.setEnabled).toEqual([['swing-trader', 'c4d022bcabc', true]]);
  });

  it('peers.remove calls through', async () => {
    const { context, calls } = makeContext();
    const res = await call(
      a2aRouter.peers.remove,
      { personalityId: 'swing-trader', fingerprint: 'c4d022bcabc' },
      { context },
    );
    expect(res).toEqual({ ok: true });
    expect(calls.removePeer).toEqual([['swing-trader', 'c4d022bcabc']]);
  });
});

describe('a2a RPC — NOT_AVAILABLE when A2A is not wired', () => {
  it('every procedure returns 503 NOT_AVAILABLE when the services are absent', async () => {
    const { context } = makeContext({ omitPeering: true, omitControl: true });
    const invocations: Array<Promise<unknown>> = [
      call(a2aRouter.settings.get, {}, { context }),
      call(a2aRouter.settings.set, { enabled: true }, { context }),
      call(a2aRouter.identity, { personalityId: 'x' }, { context }),
      call(a2aRouter.peers.list, { personalityId: 'x' }, { context }),
      call(a2aRouter.peers.preview, { url: 'http://x' }, { context }),
      call(
        a2aRouter.peers.add,
        { personalityId: 'x', url: 'http://x', expectedFingerprint: 'fp' },
        { context },
      ),
      call(
        a2aRouter.peers.setEnabled,
        { personalityId: 'x', fingerprint: 'fp', enabled: true },
        { context },
      ),
      call(a2aRouter.peers.remove, { personalityId: 'x', fingerprint: 'fp' }, { context }),
      call(a2aRouter.skills.listExposable, { personalityId: 'x' }, { context }),
    ];
    for (const p of invocations) {
      await expect(p).rejects.toSatisfy((err: unknown) => {
        return err instanceof ORPCError && err.code === 'NOT_AVAILABLE' && err.status === 503;
      });
    }
  });
});

describe('a2a RPC — auth enforced over HTTP', () => {
  let dir: string;
  let store: SQLiteSessionStore;
  let app: ReturnType<typeof createWebApi>['app'];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-webapi-a2a-'));
    store = new SQLiteSessionStore(':memory:');
    let enabled = true;
    const a2aControl: A2aControl = {
      isEnabled: () => enabled,
      setEnabled: async (v) => {
        enabled = v;
      },
    };
    app = createWebApi({
      dataDir: dir,
      sessionStore: store,
      memoryProvider: makeStubMemoryProvider(),
      agentLoop: makeStubAgentLoop(),
      personalities: makeStubPersonalityRegistry(),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
      a2aControl,
    }).app;
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function cookie(): Promise<string> {
    const tokens = new WebTokenRepository({ dataDir: dir, storage: new FsStorage() });
    const token = await tokens.getOrCreate();
    const exchange = await app.request(`/auth/exchange?t=${token}`, {
      headers: { origin: 'http://localhost:3000' },
    });
    return (exchange.headers.get('set-cookie') ?? '').split(/;\s*/)[0] ?? '';
  }

  it('POST /rpc/a2a/settings/get without cookie → 401', async () => {
    const res = await app.request('/rpc/a2a/settings/get', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
      body: JSON.stringify({ json: {} }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UNAUTHORIZED');
  });

  it('POST /rpc/a2a/settings/get with cookie → 200 + live state', async () => {
    const res = await app.request('/rpc/a2a/settings/get', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: await cookie(),
        origin: 'http://localhost:3000',
      },
      body: JSON.stringify({ json: {} }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { json: { enabled: boolean } };
    expect(body.json.enabled).toBe(true);
  });
});
