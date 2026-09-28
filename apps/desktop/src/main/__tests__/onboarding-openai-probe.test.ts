import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const backing = new Map<string, unknown>();

vi.mock('electron-store', () => ({
  default: class MockStore {
    get(key: string, fallback?: unknown) {
      return backing.has(key) ? backing.get(key) : fallback;
    }
    set(key: string, value: unknown) {
      backing.set(key, value);
    }
  },
}));

const handlers = new Map<string, (event: unknown, req: unknown) => unknown>();

// Hoisted: `vi.mock` factories run before module-scope initialisers, so these
// spies have to exist before the `electron` / `../keychain` factories close
// over them.
const { appEmit, setResizable, setKeychainValue } = vi.hoisted(() => ({
  appEmit: vi.fn(),
  setResizable: vi.fn(),
  setKeychainValue: vi.fn(async () => {}),
}));

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), emit: appEmit, on: () => {} },
  BrowserWindow: {
    fromWebContents: () => ({ setResizable, setSize: () => {}, center: () => {} }),
  },
  dialog: {},
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, req: unknown) => unknown) => {
      handlers.set(channel, handler);
    },
  },
  nativeTheme: { shouldUseDarkColors: false, on: () => {} },
  session: { defaultSession: { cookies: { set: async () => {} } } },
  shell: {},
  safeStorage: {
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}));

vi.mock('../keychain', () => ({
  getKeychainValue: async () => null,
  setKeychainValue,
}));
vi.mock('../backend', () => ({ restartBackend: () => {}, startBackend: () => {} }));
vi.mock('../gateway-control', () => ({
  getGatewayLogPath: () => '',
  getGatewayStatus: () => ({ state: 'stopped' }),
  startGateway: async () => {},
  stopGateway: async () => {},
}));
vi.mock('../login-item', () => ({ getLoginItem: () => false, setLoginItem: () => {} }));
vi.mock('../platform-validator', () => ({
  testDiscord: async () => ({ ok: true }),
  testImap: async () => ({ ok: true }),
  testSmtp: async () => ({ ok: true }),
  testTelegram: async () => ({ ok: true }),
}));
vi.mock('../satellite', () => ({
  getSatelliteStatus: () => ({ state: 'stopped' }),
  probeSatellite: async () => ({}),
  setWakeEnabled: async () => {},
  startSatellite: async () => {},
  stopSatellite: async () => {},
}));

import { registerIpcHandlers } from '../ipc';

// UBP-038 — the OpenAI onboarding probe runs against the catalog's first
// OpenAI model, a gpt-5.x reasoning model that refuses `max_tokens` on Chat
// Completions. The probe must send `max_completion_tokens` instead.
describe('onboarding:validateProvider OpenAI probe', () => {
  beforeEach(() => {
    handlers.clear();
    backing.clear();
    registerIpcHandlers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends max_completion_tokens and no max_tokens', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/chat/completions')) {
          bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return new Response(JSON.stringify({ choices: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }),
    );
    const handler = handlers.get('onboarding:validateProvider');
    if (!handler) throw new Error('onboarding:validateProvider handler was not registered');
    const result = (await handler({ sender: {} }, { provider: 'openai', apiKey: 'sk-test' })) as {
      completionTested: boolean;
    };
    expect(result.completionTested).toBe(true);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.max_completion_tokens).toBe(16);
    expect(bodies[0] && 'max_tokens' in bodies[0]).toBe(false);
  });
});
