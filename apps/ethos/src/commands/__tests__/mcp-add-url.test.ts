// `ethos mcp add <name> --url <u> --device` (plan mcp-device-code-login §6.2
// item 5, D15): discovery + DCR only, then the entry is saved with
// `device_authorization_endpoint` and the registered loopback `dcr.redirect_uri`,
// and the chosen sign-in runs exactly once, scoped to the resolved personality.

import type { McpServerConfig } from '@ethosagent/tools-mcp';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const files = new Map<string, string>();
const REDIRECT = 'http://127.0.0.1:48123/oauth/callback';

const h = vi.hoisted(() => ({
  starts: [] as Array<Record<string, unknown>>,
  registered: [] as Array<Record<string, unknown>>,
  runPkceLogin: vi.fn(),
  runDcrAuthorization: vi.fn(),
}));

vi.mock('../../wiring', () => ({
  createAgentLoop: vi.fn(),
  createLLM: vi.fn(),
  getEthosObservability: () => ({ recordEthosEvent: () => {} }),
  getSecretsResolver: async () => ({ get: async () => undefined }),
  getStorage: () => ({
    read: async (p: string) => files.get(p) ?? null,
    mkdir: async () => {},
    writeAtomic: async (p: string, data: string) => void files.set(p, data),
  }),
  closeObservabilityStore: () => {},
}));

vi.mock('@ethosagent/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ethosagent/config')>();
  return { ...actual, readRawConfig: vi.fn(async () => ({ personality: 'researcher' })) };
});

vi.mock('@ethosagent/tools-mcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ethosagent/tools-mcp')>();
  class FakeDeviceLogin {
    async start(input: Record<string, unknown>) {
      h.starts.push(input);
      return {
        ok: true,
        flowId: 'f1',
        userCode: 'ABCD-EFGHJ',
        verificationUri: 'https://mcp-auth.granola.ai/device',
        expiresAt: Date.now() + 299_000,
        serverName: 'granola',
        serverHost: 'mcp.granola.ai',
        authHost: 'mcp-auth.granola.ai',
        personalityId: input.personalityId,
      };
    }
    onSettled(_id: string, cb: (s: { status: string }) => void) {
      queueMicrotask(() => cb({ status: 'connected' }));
    }
    cancel() {}
  }
  return {
    ...actual,
    McpDeviceLogin: FakeDeviceLogin,
    runPkceLogin: h.runPkceLogin,
    runDcrAuthorization: h.runDcrAuthorization,
    discoverOAuthMetadata: vi.fn(async () => ({
      authorization_endpoint: 'https://mcp-auth.granola.ai/authorize',
      token_endpoint: 'https://mcp-auth.granola.ai/token',
      registration_endpoint: 'https://mcp-auth.granola.ai/register',
      device_authorization_endpoint: 'https://mcp-auth.granola.ai/device_authorization',
      issuer: 'https://mcp-auth.granola.ai',
    })),
    registerOAuthClient: vi.fn(async (_endpoint: string, req: Record<string, unknown>) => {
      h.registered.push(req);
      return { client_id: 'cid-1' };
    }),
    startCallbackServer: vi.fn(async () => ({
      port: 48123,
      redirectUri: REDIRECT,
      resultPromise: new Promise(() => {}),
      close: () => {},
    })),
  };
});

type Mcp = typeof import('../mcp');
let mcp: Mcp;
beforeAll(async () => {
  mcp = await import('../mcp');
}, 120_000);

let prevExit: typeof process.exitCode;
beforeEach(() => {
  files.clear();
  h.starts.length = 0;
  h.registered.length = 0;
  h.runPkceLogin.mockReset();
  h.runDcrAuthorization.mockReset();
  prevExit = process.exitCode;
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = prevExit;
});

function savedEntries(): McpServerConfig[] {
  const raw = [...files.values()][0];
  return raw ? (JSON.parse(raw) as McpServerConfig[]) : [];
}

describe('ethos mcp add --url --device', () => {
  it('add --url --device persists device_authorization_endpoint and dcr.redirect_uri and logs in once', async () => {
    await mcp.runMcp([
      'add',
      'granola',
      '--url',
      'https://mcp.granola.ai/mcp',
      '--device',
      '--no-qr',
    ]);

    // discovery + DCR only: no browser authorization ran
    expect(h.runDcrAuthorization).not.toHaveBeenCalled();
    expect(h.runPkceLogin).not.toHaveBeenCalled();

    // the device grant was requested because discovery advertised the endpoint
    expect(h.registered).toHaveLength(1);
    expect(h.registered[0]?.grant_types).toContain('urn:ietf:params:oauth:grant-type:device_code');
    expect(h.registered[0]?.redirect_uris).toEqual([REDIRECT]);

    const [entry] = savedEntries();
    expect(entry?.name).toBe('granola');
    expect(entry?.auth).toMatchObject({
      type: 'oauth2',
      client_id: 'cid-1',
      device_authorization_endpoint: 'https://mcp-auth.granola.ai/device_authorization',
      dcr: { redirect_uri: REDIRECT },
    });

    // one sign-in, scoped to the resolved (active) personality
    expect(h.starts).toEqual([
      { serverName: 'granola', personalityId: 'researcher', surface: 'cli' },
    ]);
    expect(process.exitCode).toBeUndefined();
  });

  it('refuses --device with --paste before writing anything', async () => {
    await expect(
      mcp.runMcp(['add', 'granola', '--url', 'https://mcp.granola.ai/mcp', '--device', '--paste']),
    ).rejects.toThrow(/at most one/);
    expect(files.size).toBe(0);
    expect(h.registered).toHaveLength(0);
  });
});
