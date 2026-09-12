import { beforeEach, describe, expect, it, vi } from 'vitest';

// Lifecycle audit G1 — `before-quit` used to fire the shutdown and return, so
// Electron tore the process down while the runtime's disposal (web api, agent
// loop, SQLite handles) was still in flight. The handler must preventDefault,
// await the shutdown, then re-quit, and it must not re-enter its own re-quit.

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

// `vi.mock` factories are hoisted above these declarations, and `index.ts`
// registers its handlers at import time, so the shared state has to be hoisted too.
const { handlers, quitCalls, events } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  quitCalls: [] as number[],
  events: [] as string[],
}));

vi.mock('electron', () => ({
  app: {
    whenReady: () => new Promise(() => {}),
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(event, handler);
    },
    quit: () => {
      quitCalls.push(Date.now());
      const handler = handlers.get('before-quit');
      // Electron re-runs `before-quit` on every quit attempt, including the one
      // the handler itself makes once shutdown finished. The re-entry guard is
      // only real if the test reproduces that.
      handler?.({ preventDefault: () => events.push('preventDefault') });
    },
    getPath: () => '/tmp/ethos-test',
  },
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false, on: () => {} },
  session: {
    defaultSession: {
      cookies: { set: async () => {} },
      webRequest: { onHeadersReceived: () => {}, onCompleted: () => {} },
    },
  },
  safeStorage: {
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}));

let releaseBackendStop: (() => void) | null = null;

vi.mock('@ethosagent/web-api', () => ({
  WebTokenRepository: class {
    async getOrCreate() {
      return 'test-token';
    }
  },
}));

vi.mock('../auto-update', () => ({ initAutoUpdater: () => {} }));
vi.mock('../backend', () => ({
  restartBackendAsync: async () => 3001,
  startBackend: () => {},
  startBackendAsync: async () => 3001,
  stopBackendAsync: async () => {
    events.push('stopBackendAsync:start');
    await new Promise<void>((resolve) => {
      releaseBackendStop = resolve;
    });
    events.push('stopBackendAsync:end');
  },
}));
vi.mock('../connection-window', () => ({ showConnectionWindow: async () => null }));
vi.mock('../error-window', () => ({ showErrorWindow: async () => 'quit' }));
vi.mock('../global-shortcut', () => ({
  registerGlobalShortcuts: () => {},
  unregisterGlobalShortcuts: () => {
    events.push('unregisterGlobalShortcuts');
  },
}));
vi.mock('../ipc', () => ({ registerIpcHandlers: () => {} }));
vi.mock('../keychain', () => ({
  getKeychainValue: async () => null,
  setKeychainValue: async () => {},
}));
vi.mock('../notifications', () => ({ showMinimizeNotification: () => {} }));
vi.mock('../protocol-handler', () => ({ registerProtocolHandler: () => {} }));
vi.mock('../quick-chat-window', () => ({
  registerQuickChatIpc: () => {},
  showQuickChat: () => {},
}));
vi.mock('../satellite', () => ({
  onSatelliteStatus: () => {},
  setWakeEnabled: async () => {},
  startSatellite: async () => {},
  stopSatellite: async () => {
    events.push('stopSatellite');
  },
}));
vi.mock('../startup-mode', () => ({
  isBackgroundMode: () => false,
  logBackgroundStartup: () => {},
}));
vi.mock('../tray', () => ({
  createTray: () => null,
  destroyTray: () => {
    events.push('destroyTray');
  },
  setTrayState: () => {},
  setWakeTray: () => {},
}));

import '../index';

const flush = async (times = 6) => {
  for (let i = 0; i < times; i++) await Promise.resolve();
};

describe('before-quit awaits the runtime shutdown (G1)', () => {
  beforeEach(() => {
    events.length = 0;
    quitCalls.length = 0;
    releaseBackendStop = null;
  });

  it('preventDefaults, awaits shutdown, then quits once', async () => {
    const handler = handlers.get('before-quit');
    expect(handler).toBeDefined();

    handler?.({ preventDefault: () => events.push('preventDefault') });
    await flush();

    // The quit is held open while the backend is still stopping.
    expect(events).toContain('preventDefault');
    expect(events).toContain('stopBackendAsync:start');
    expect(quitCalls).toHaveLength(0);

    releaseBackendStop?.();
    await flush(20);

    expect(events).toContain('stopBackendAsync:end');
    // Exactly one re-quit, and that re-quit's own before-quit pass must not
    // start a second shutdown.
    expect(quitCalls).toHaveLength(1);
    expect(events.filter((e) => e === 'stopBackendAsync:start')).toHaveLength(1);
    expect(events.filter((e) => e === 'preventDefault')).toHaveLength(1);
  }, 20_000);
});
