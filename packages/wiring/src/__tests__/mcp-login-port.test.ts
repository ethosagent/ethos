import {
  InMemorySecretsResolver,
  InMemoryStorage,
  PersonalityScopedSecrets,
} from '@ethosagent/storage-fs';
import { McpJsonStore, type McpManager, type McpServerConfig } from '@ethosagent/tools-mcp';
import type { Logger } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FAKE_SECRETS,
  FakeDeviceAuthServer,
} from '../../../../extensions/tools-mcp/src/__tests__/helpers/fake-device-server';
import { createMcpLoginPort, type McpLoginPortHandle } from '../mcp-login';

vi.mock('@ethosagent/safety-network', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ethosagent/safety-network')>();
  return {
    ...actual,
    safeFetch: (url: string, opts: Parameters<typeof actual.safeFetch>[1]) =>
      actual.safeFetch(url, {
        ...opts,
        fetchImpl: (input, init) => globalThis.fetch(input, init),
        resolveHost: async () => ['93.184.216.34'],
      }),
  };
});

const DIR = '/home/test/.ethos';
const REDIRECT = 'http://127.0.0.1:43210/oauth/callback';

class StubManager {
  readonly reconnects: { serverName: string; personalityId: string }[] = [];
  async reconnectPersonality(serverName: string, personalityId: string): Promise<void> {
    this.reconnects.push({ serverName, personalityId });
  }
  registerConfig(): void {}
}

describe('createMcpLoginPort', () => {
  let server: FakeDeviceAuthServer;
  let secrets: InMemorySecretsResolver;
  let manager: StubManager;
  let other: StubManager;
  let port: McpLoginPortHandle;

  beforeEach(async () => {
    vi.useFakeTimers();
    server = new FakeDeviceAuthServer();
    server.install();
    const storage = new InMemoryStorage();
    await storage.mkdir(DIR);
    const store = new McpJsonStore(storage, `${DIR}/mcp.json`);
    const config: McpServerConfig = {
      name: 'demo',
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
      } as McpServerConfig['auth'],
    };
    await store.upsert('demo', config);
    secrets = new InMemorySecretsResolver();
    manager = new StubManager();
    other = new StubManager();
    port = createMcpLoginPort({
      storage,
      mcpJsonPath: `${DIR}/mcp.json`,
      secrets,
      mcpManager: manager as unknown as McpManager,
      personalities: {
        get: (id) => (id === 'researcher' ? { mcp_servers: ['demo'] } : { mcp_servers: [] }),
      },
    });
  });

  afterEach(() => {
    port.dispose();
    server.restore();
    vi.useRealTimers();
  });

  it('the port scopes tokens to the given personality and reconnects that bot’s manager only', async () => {
    const res = await port.start({ serverName: 'demo', personalityId: 'researcher' });
    expect(res.kind).toBe('device');
    if (res.kind !== 'device') return;
    expect(res).not.toHaveProperty('verificationUriComplete');
    expect(res.userCode).toBe(FAKE_SECRETS.userCode);

    const settled: unknown[] = [];
    port.onSettled(res.flowId, (s) => settled.push(s));
    server.tokenScript = ['pending', 'tokens'];
    await vi.advanceTimersByTimeAsync(60_000);

    expect(settled).toEqual([{ status: 'connected' }]);
    const scoped = new PersonalityScopedSecrets(secrets, 'researcher');
    expect(await scoped.get('mcp/demo/access_token')).toBe(FAKE_SECRETS.accessToken);
    expect(await secrets.get('mcp/demo/access_token')).toBeNull();
    expect(manager.reconnects).toEqual([{ serverName: 'demo', personalityId: 'researcher' }]);
    expect(other.reconnects).toEqual([]);
  });

  it('records mcp.oauth.login started on the injected logger', async () => {
    const info = vi.fn();
    const logger: Logger = {
      debug: vi.fn(),
      info,
      warn: vi.fn(),
      error: vi.fn(),
      child: () => logger,
    };
    const storage = new InMemoryStorage();
    await storage.mkdir(DIR);
    const store = new McpJsonStore(storage, `${DIR}/mcp.json`);
    await store.upsert('demo', {
      name: 'demo',
      transport: 'streamable-http',
      url: server.mcpUrl,
      auth: {
        type: 'oauth2',
        authorization_endpoint: `${server.asOrigin}/authorize`,
        token_endpoint: server.tokenEndpoint,
        client_id: 'fake-client',
        issuer: server.asOrigin,
        device_authorization_endpoint: server.deviceEndpoint,
      } as McpServerConfig['auth'],
    });
    const logged = createMcpLoginPort({
      storage,
      mcpJsonPath: `${DIR}/mcp.json`,
      secrets,
      mcpManager: manager as unknown as McpManager,
      personalities: { get: () => ({ mcp_servers: ['demo'] }) },
      logger,
    });
    await logged.start({ serverName: 'demo', personalityId: 'researcher' });
    logged.dispose();
    expect(info).toHaveBeenCalledWith(
      'mcp.oauth.login',
      expect.objectContaining({ outcome: 'started', surface: 'gateway' }),
    );
  });

  it('a refused device request falls back to paste, and completePaste is single-use', async () => {
    server.deviceAuth = 'unauthorized_client';
    const res = await port.start({ serverName: 'demo', personalityId: 'researcher' });
    expect(res.kind).toBe('paste');
    if (res.kind !== 'paste') return;
    const state = new URL(res.authorizeUrl).searchParams.get('state') ?? '';
    server.tokenScript = ['tokens'];
    expect(await port.completePaste(res.flowId, `${REDIRECT}?code=c1&state=${state}`)).toEqual({
      ok: true,
    });
    expect(await port.completePaste(res.flowId, `${REDIRECT}?code=c1&state=${state}`)).toEqual({
      ok: false,
      code: 'not_pending',
    });
  });

  it('a device flow blocks a second flow for the same slot, paste included', async () => {
    const first = await port.start({ serverName: 'demo', personalityId: 'researcher' });
    expect(first.kind).toBe('device');
    expect(await port.start({ serverName: 'demo', personalityId: 'researcher' })).toMatchObject({
      kind: 'refused',
      code: 'already_pending',
    });
  });

  it('an unknown server is refused not_found and cancel settles a pending flow', async () => {
    expect(await port.start({ serverName: 'nope', personalityId: 'researcher' })).toMatchObject({
      kind: 'refused',
      code: 'not_found',
    });
    const res = await port.start({ serverName: 'demo', personalityId: 'researcher' });
    if (res.kind !== 'device') throw new Error('expected device');
    const settled: unknown[] = [];
    port.onSettled(res.flowId, (s) => settled.push(s));
    port.cancel(res.flowId);
    expect(settled).toEqual([{ status: 'cancelled' }]);
  });

  it('isAttached reads the personality’s mcp_servers', () => {
    expect(port.isAttached('demo', 'researcher')).toBe(true);
    expect(port.isAttached('demo', 'coach')).toBe(false);
  });
});
