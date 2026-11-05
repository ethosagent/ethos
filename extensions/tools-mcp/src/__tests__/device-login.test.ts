import {
  InMemorySecretsResolver,
  InMemoryStorage,
  PersonalityScopedSecrets,
} from '@ethosagent/storage-fs';
import type { Logger } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type LoginAuditEvent,
  type LoginSettlement,
  LoginSlots,
  McpDeviceLogin,
  McpPasteLogin,
} from '../device-login';
import type { McpManager, McpServerConfig } from '../index';
import { McpJsonStore } from '../mcp-json-store';
import { FAKE_SECRETS, FakeDeviceAuthServer, type TokenStep } from './helpers/fake-device-server';

vi.mock('@ethosagent/safety-network', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ethosagent/safety-network')>();
  return {
    ...actual,
    safeFetch: (url: string, opts: Parameters<typeof actual.safeFetch>[1]) =>
      actual.safeFetch(url, {
        ...opts,
        fetchImpl: (input, init) => globalThis.fetch(input, init),
        // No real DNS: fake timers cannot advance past a pending socket lookup.
        resolveHost: async () => ['93.184.216.34'],
      }),
  };
});

const MCP_JSON_DIR = '/home/test/.ethos';
const MCP_JSON_PATH = `${MCP_JSON_DIR}/mcp.json`;
const REDIRECT = 'http://127.0.0.1:43210/oauth/callback';

class StubManager {
  readonly registered: McpServerConfig[] = [];
  readonly reconnects: { serverName: string; personalityId: string }[] = [];
  async reconnectPersonality(serverName: string, personalityId: string): Promise<void> {
    this.reconnects.push({ serverName, personalityId });
  }
  registerConfig(config: McpServerConfig): void {
    this.registered.push(config);
  }
}

function spyLogger() {
  const calls: unknown[][] = [];
  const logger: Logger = {
    debug: (...a) => void calls.push(a),
    info: (...a) => void calls.push(a),
    warn: (...a) => void calls.push(a),
    error: (...a) => void calls.push(a),
    child: () => logger,
  };
  return { logger, dump: () => JSON.stringify(calls) };
}

describe('McpDeviceLogin / McpPasteLogin', () => {
  let server: FakeDeviceAuthServer;
  let store: McpJsonStore;
  let secrets: InMemorySecretsResolver;
  let manager: StubManager;
  let events: LoginAuditEvent[];
  let log: ReturnType<typeof spyLogger>;

  function entry(name: string, authExtra: Record<string, unknown> = {}): McpServerConfig {
    return {
      name,
      transport: 'streamable-http',
      url: server.mcpUrl,
      auth: {
        type: 'oauth2',
        authorization_endpoint: `${server.asOrigin}/authorize`,
        token_endpoint: server.tokenEndpoint,
        client_id: 'fake-client',
        issuer: server.asOrigin,
        device_authorization_endpoint: server.deviceEndpoint,
        dcr: { registration_endpoint: `${server.asOrigin}/register`, redirect_uri: REDIRECT },
        ...authExtra,
      } as McpServerConfig['auth'],
    };
  }

  function device(slots?: LoginSlots): McpDeviceLogin {
    return new McpDeviceLogin({
      mcpJsonStore: store,
      secrets,
      mcpManager: manager as unknown as McpManager,
      logger: log.logger,
      recordEvent: (e) => events.push(e),
      ...(slots ? { slots } : {}),
    });
  }

  function paste(slots?: LoginSlots): McpPasteLogin {
    return new McpPasteLogin({
      mcpJsonStore: store,
      secrets,
      mcpManager: manager as unknown as McpManager,
      logger: log.logger,
      recordEvent: (e) => events.push(e),
      ...(slots ? { slots } : {}),
    });
  }

  async function settle(script: TokenStep[], ms = 60_000): Promise<void> {
    server.tokenScript = script;
    await vi.advanceTimersByTimeAsync(ms);
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    server = new FakeDeviceAuthServer();
    server.install();
    const storage = new InMemoryStorage();
    await storage.mkdir(MCP_JSON_DIR);
    store = new McpJsonStore(storage, MCP_JSON_PATH);
    secrets = new InMemorySecretsResolver();
    manager = new StubManager();
    events = [];
    log = spyLogger();
    await store.upsert('demo', entry('demo'));
  });

  afterEach(() => {
    server.restore();
    vi.useRealTimers();
  });

  it('success stores tokens with a binding through storeTokens, scoped to the personality', async () => {
    const login = device();
    const res = await login.start({ serverName: 'demo', personalityId: 'p1', surface: 'cli' });
    expect(res).toMatchObject({
      ok: true,
      userCode: FAKE_SECRETS.userCode,
      verificationUri: `${server.asOrigin}/device`,
      serverHost: 'mcp.device.example.com',
      authHost: 'auth.device.example.com',
      personalityId: 'p1',
    });
    if (!res.ok) return;
    expect(login.status(res.flowId)).toMatchObject({ status: 'pending', serverName: 'demo' });
    await settle(['pending', 'tokens']);

    expect(login.status(res.flowId).status).toBe('connected');
    const scoped = new PersonalityScopedSecrets(secrets, 'p1');
    expect(await scoped.get('mcp/demo/access_token')).toBe(FAKE_SECRETS.accessToken);
    expect(await scoped.get('mcp/demo/refresh_token')).toBe(FAKE_SECRETS.refreshToken);
    expect(JSON.parse((await scoped.get('mcp/demo/token_binding')) ?? '{}')).toEqual({
      v: 1,
      token_endpoint: server.tokenEndpoint,
      issuer: server.asOrigin,
    });
    expect(await secrets.get('mcp/demo/access_token')).toBeNull();
  });

  it('two personalities device grants for one server are independent', async () => {
    const login = device();
    const a = await login.start({ serverName: 'demo', personalityId: 'pa', surface: 'cli' });
    const b = await login.start({ serverName: 'demo', personalityId: 'pb', surface: 'cli' });
    expect(a.ok && b.ok).toBe(true);
    await settle(['tokens']);
    for (const id of ['pa', 'pb']) {
      expect(await new PersonalityScopedSecrets(secrets, id).get('mcp/demo/access_token')).toBe(
        FAKE_SECRETS.accessToken,
      );
    }
  });

  it('a second start for the same grant slot is refused already_pending', async () => {
    const login = device();
    expect((await login.start({ serverName: 'demo', personalityId: 'p', surface: 'cli' })).ok).toBe(
      true,
    );
    const again = await login.start({ serverName: 'demo', personalityId: 'p', surface: 'web' });
    expect(again).toMatchObject({ ok: false, code: 'already_pending' });
    login.dispose();
  });

  it('the eleventh concurrent flow is refused too_many_pending', async () => {
    server.tokenScript = ['pending'];
    const login = device();
    for (let i = 0; i < 10; i++) {
      await store.upsert(`s${i}`, entry(`s${i}`));
      expect((await login.start({ serverName: `s${i}`, surface: 'cli' })).ok).toBe(true);
    }
    await store.upsert('s10', entry('s10'));
    expect(await login.start({ serverName: 's10', surface: 'cli' })).toMatchObject({
      ok: false,
      code: 'too_many_pending',
    });
    login.dispose();
  });

  it('unauthorized_client from the device endpoint returns device_refused', async () => {
    server.deviceAuth = 'unauthorized_client';
    const login = device();
    const res = await login.start({ serverName: 'demo', surface: 'web' });
    expect(res).toEqual({ ok: false, code: 'device_refused', detail: 'unauthorized_client' });
    // the slot was released: a retry is not already_pending
    server.deviceAuth = 'ok';
    expect((await login.start({ serverName: 'demo', surface: 'web' })).ok).toBe(true);
    login.dispose();
  });

  it('an entry without device_authorization_endpoint is rediscovered and used when token_endpoint matches', async () => {
    await store.upsert('old', entry('old', { device_authorization_endpoint: undefined }));
    const login = device();
    const res = await login.start({ serverName: 'old', surface: 'cli' });
    expect(res.ok).toBe(true);
    // mcp.json is never rewritten
    const saved = await store.get('old');
    expect(saved?.auth).not.toHaveProperty('device_authorization_endpoint', server.deviceEndpoint);
    await settle(['tokens']);
    expect(await secrets.get('mcp/old/access_token')).toBe(FAKE_SECRETS.accessToken);
  });

  it('rediscovery whose token_endpoint differs returns device_unavailable and does not touch mcp.json', async () => {
    await store.upsert(
      'old',
      entry('old', {
        device_authorization_endpoint: undefined,
        token_endpoint: `${server.asOrigin}/old-token`,
      }),
    );
    const before = JSON.stringify(await store.get('old'));
    const res = await device().start({ serverName: 'old', surface: 'cli' });
    expect(res).toMatchObject({ ok: false, code: 'device_unavailable' });
    expect(JSON.stringify(await store.get('old'))).toBe(before);
    expect(server.deviceRequests).toHaveLength(0);
  });

  it('a stored device endpoint on another origin than the token endpoint is device_unavailable', async () => {
    await store.upsert(
      'evil',
      entry('evil', { device_authorization_endpoint: 'https://evil.example.com/device' }),
    );
    const res = await device().start({ serverName: 'evil', surface: 'cli' });
    expect(res).toEqual({ ok: false, code: 'device_unavailable', detail: 'origin_mismatch' });
  });

  it('dispose aborts every poller', async () => {
    server.tokenScript = ['pending'];
    const login = device();
    const res = await login.start({ serverName: 'demo', surface: 'cli' });
    if (!res.ok) throw new Error('start failed');
    login.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(login.status(res.flowId).status).toBe('cancelled');
    expect(server.tokenRequests).toHaveLength(0);
  });

  it('a successful flow calls registerConfig and reconnectPersonality', async () => {
    const login = device();
    await login.start({ serverName: 'demo', personalityId: 'p1', surface: 'cli' });
    await settle(['tokens']);
    expect(manager.registered.map((c) => c.name)).toEqual(['demo']);
    expect(manager.reconnects).toEqual([{ serverName: 'demo', personalityId: 'p1' }]);
  });

  it('onSettled fires once with the terminal status, and at once when already settled', async () => {
    const login = device();
    const res = await login.start({ serverName: 'demo', surface: 'gateway' });
    if (!res.ok) throw new Error('start failed');
    const seen: LoginSettlement[] = [];
    login.onSettled(res.flowId, (s) => seen.push(s));
    await settle(['denied']);
    expect(seen).toEqual([{ status: 'denied' }]);
    login.onSettled(res.flowId, (s) => seen.push(s));
    expect(seen).toHaveLength(2);
  });

  it('cancel settles cancelled', async () => {
    const login = device();
    const res = await login.start({ serverName: 'demo', surface: 'cli' });
    if (!res.ok) throw new Error('start failed');
    login.cancel(res.flowId);
    expect(login.status(res.flowId).status).toBe('cancelled');
  });

  it('records started and one terminal audit event per attempt, and a refused one', async () => {
    const login = device();
    await login.start({ serverName: 'demo', personalityId: 'p1', surface: 'web' });
    await settle(['pending', 'tokens']);
    expect(events.map((e) => e.outcome)).toEqual(['started', 'connected']);
    expect(events[1]).toMatchObject({
      server: 'demo',
      personalityId: 'p1',
      flow: 'device',
      surface: 'web',
      authHost: 'auth.device.example.com',
      polls: 2,
    });
    await login.start({ serverName: 'missing', surface: 'web' });
    server.deviceAuth = 'unauthorized_client';
    await login.start({ serverName: 'demo', surface: 'web' });
    expect(events.at(-1)).toMatchObject({
      outcome: 'refused',
      code: 'device_refused:unauthorized_client',
    });
  });

  it('no secret reaches the logger', async () => {
    const secretsSeen = [
      FAKE_SECRETS.userCode,
      FAKE_SECRETS.deviceCode,
      FAKE_SECRETS.accessToken,
      FAKE_SECRETS.refreshToken,
    ];
    for (const script of [
      ['tokens'],
      ['denied'],
      ['expired'],
      ['unknown_error'],
      ['bad_body'],
    ] as TokenStep[][]) {
      const login = device(
        new LoginSlots({ logger: log.logger, recordEvent: (e) => events.push(e) }),
      );
      await login.start({ serverName: 'demo', surface: 'cli' });
      await settle(script);
    }
    server.deviceAuth = 'unauthorized_client';
    await device().start({ serverName: 'demo', surface: 'cli' });

    // paste: success + a bad state
    const p = paste();
    const res = await p.start({ serverName: 'demo', surface: 'cli' });
    if (!res.ok) throw new Error('paste start failed');
    const state = new URL(res.authorizeUrl).searchParams.get('state') ?? '';
    await p.complete(res.flowId, `${REDIRECT}?code=AUTH-CODE-XYZ&state=WRONG-STATE`);
    server.tokenScript = ['tokens'];
    await p.complete(res.flowId, `${REDIRECT}?code=AUTH-CODE-XYZ&state=${state}`);

    const dump = log.dump() + JSON.stringify(events);
    for (const s of [...secretsSeen, 'AUTH-CODE-XYZ', 'WRONG-STATE', state]) {
      expect(dump).not.toContain(s);
    }
    expect(dump).toContain('mcp.oauth.login');
  });

  // ------------------------------- paste -------------------------------

  async function startPaste(p: McpPasteLogin, personalityId?: string) {
    const res = await p.start({ serverName: 'demo', personalityId, surface: 'gateway' });
    if (!res.ok) throw new Error(`paste start failed: ${res.code}`);
    const state = new URL(res.authorizeUrl).searchParams.get('state') ?? '';
    return { res, state };
  }

  it('McpPasteLogin complete stores a bound grant', async () => {
    const p = paste();
    const { res, state } = await startPaste(p, 'p1');
    const url = new URL(res.authorizeUrl);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(res.authHost).toBe('auth.device.example.com');

    server.tokenScript = ['tokens'];
    const out = await p.complete(res.flowId, `${REDIRECT}?code=c1&state=${state}`);
    expect(out).toEqual({ ok: true });
    expect(p.status(res.flowId).status).toBe('connected');
    const scoped = new PersonalityScopedSecrets(secrets, 'p1');
    expect(await scoped.get('mcp/demo/access_token')).toBe(FAKE_SECRETS.accessToken);
    expect(JSON.parse((await scoped.get('mcp/demo/token_binding')) ?? '{}')).toMatchObject({
      token_endpoint: server.tokenEndpoint,
    });
    const body = server.tokenRequests[0]?.body;
    expect(body?.get('grant_type')).toBe('authorization_code');
    expect(body?.get('redirect_uri')).toBe(REDIRECT);
    expect(body?.get('code_verifier')).toBeTruthy();
    // single use
    expect(await p.complete(res.flowId, `${REDIRECT}?code=c1&state=${state}`)).toEqual({
      ok: false,
      code: 'not_pending',
    });
  });

  it('a pasted state mismatch or an iss mismatch makes no token request', async () => {
    const p = paste();
    const { res, state } = await startPaste(p);
    expect(await p.complete(res.flowId, `${REDIRECT}?code=c1&state=nope`)).toEqual({
      ok: false,
      code: 'state_mismatch',
    });
    expect(await p.complete(res.flowId, 'https://evil.example.com/?code=c&state=x')).toEqual({
      ok: false,
      code: 'invalid_paste',
    });
    expect(p.status(res.flowId).status).toBe('pending');
    expect(
      await p.complete(
        res.flowId,
        `${REDIRECT}?code=c1&state=${state}&iss=${encodeURIComponent('https://evil.example.com')}`,
      ),
    ).toEqual({ ok: false, code: 'issuer_mismatch' });
    expect(server.tokenRequests).toHaveLength(0);
    expect(p.status(res.flowId).status).toBe('error');
  });

  it('a pasted error=access_denied settles denied', async () => {
    const p = paste();
    const { res } = await startPaste(p);
    expect(await p.complete(res.flowId, `${REDIRECT}?error=access_denied`)).toEqual({
      ok: false,
      code: 'denied',
    });
    expect(p.status(res.flowId).status).toBe('denied');
  });

  it('an entry without a loopback dcr.redirect_uri returns paste_unavailable', async () => {
    await store.upsert('nodcr', entry('nodcr', { dcr: undefined }));
    await store.upsert(
      'web',
      entry('web', {
        dcr: {
          registration_endpoint: 'https://x/r',
          redirect_uri: 'https://ethos.local/oauth/callback',
        },
      }),
    );
    for (const name of ['nodcr', 'web']) {
      expect(await paste().start({ serverName: name, surface: 'cli' })).toMatchObject({
        ok: false,
        code: 'paste_unavailable',
      });
    }
  });

  it('a paste flow and a device flow share the one-pending-per-slot rule', async () => {
    const slots = new LoginSlots({ logger: log.logger });
    const d = device(slots);
    const p = paste(slots);
    expect((await p.start({ serverName: 'demo', personalityId: 'p', surface: 'cli' })).ok).toBe(
      true,
    );
    expect(await d.start({ serverName: 'demo', personalityId: 'p', surface: 'cli' })).toMatchObject(
      {
        ok: false,
        code: 'already_pending',
      },
    );
    // a different personality is a different slot
    expect((await d.start({ serverName: 'demo', personalityId: 'other', surface: 'cli' })).ok).toBe(
      true,
    );
    d.dispose();
  });

  it('a paste flow expires after its TTL', async () => {
    const p = paste();
    const { res } = await startPaste(p);
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(p.status(res.flowId).status).toBe('expired');
  });

  it('a paste flow with no further calls settles expired once via its own timer, and dispose clears it', async () => {
    const p = paste();
    const { res } = await startPaste(p);
    const seen: LoginSettlement[] = [];
    p.onSettled(res.flowId, (s) => seen.push(s));
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(seen).toEqual([{ status: 'expired' }]);
    expect(events.filter((e) => e.outcome === 'expired')).toHaveLength(1);

    const p2 = paste();
    await startPaste(p2);
    p2.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
