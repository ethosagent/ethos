// UBP-018 — the socket was built with Baileys 7.0.0-rc13's bundled WA Web
// version, which WhatsApp retires over time and then refuses with a 405
// before any QR or pairing code; the close handler called that "likely
// rate-limiting". The adapter now resolves the current version at connect
// (falling back to the bundled one) and names a 405 as a version rejection.

import type { Logger } from '@ethosagent/types';
import type { fetchLatestWaWebVersion } from '@whiskeysockets/baileys';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const evHandlers = new Map<string, (payload: unknown) => unknown>();
const socketConfigs: Array<Record<string, unknown>> = [];
// Every resolved value below is checked against the installed Baileys'
// declared return type (7.0.0-rc13, lib/Utils/generics.d.ts), so a Baileys
// upgrade that changes the shape fails typecheck here.
type WaWebVersionResult = Awaited<ReturnType<typeof fetchLatestWaWebVersion>>;
const fetchLatest = vi.fn<(options?: RequestInit) => Promise<WaWebVersionResult>>();

vi.mock('@whiskeysockets/baileys', () => ({
  makeWASocket: (config: Record<string, unknown>) => {
    socketConfigs.push(config);
    return {
      ev: {
        on: (event: string, handler: (payload: unknown) => unknown) => {
          evHandlers.set(event, handler);
        },
      },
      user: { id: '15551234567:12@s.whatsapp.net' },
      authState: { creds: { registered: false } },
      sendMessage: async () => ({ key: { id: 'sent-1' } }),
      end: () => {},
    };
  },
  fetchLatestWaWebVersion: (options?: RequestInit) => fetchLatest(options),
  useMultiFileAuthState: async () => ({ state: {}, saveCreds: () => {} }),
  // 7.0.0-rc13 lib/Types/index.d.ts `DisconnectReason` (405 is not a member:
  // it arrives as the `reason` attribute of the server's `failure` node, which
  // lib/Socket/socket.js `CB:failure` turns into a Boom statusCode).
  DisconnectReason: {
    connectionClosed: 428,
    connectionLost: 408,
    connectionReplaced: 440,
    timedOut: 408,
    loggedOut: 401,
    badSession: 500,
    restartRequired: 515,
    multideviceMismatch: 411,
    forbidden: 403,
    unavailableService: 503,
  },
  downloadMediaMessage: vi.fn(async () => Buffer.from([])),
}));

const { WhatsAppAdapter } = await import('../index');

type Adapter = InstanceType<typeof WhatsAppAdapter>;
const live: Adapter[] = [];

function makeLogger() {
  const errors: string[] = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (message: string) => {
      errors.push(message);
    },
    child: () => logger,
  };
  return { logger, errors };
}

function makeAdapter() {
  const { logger, errors } = makeLogger();
  const adapter = new WhatsAppAdapter({
    sessionDir: '/tmp/ethos-wa-version-test',
    botKey: 'bot1',
    denyUnknown: false,
    logger,
  });
  live.push(adapter);
  return { adapter, errors };
}

async function startOpen(adapter: Adapter): Promise<void> {
  const started = adapter.start();
  await vi.waitFor(() => {
    if (!evHandlers.has('connection.update')) throw new Error('handlers not registered yet');
  });
  evHandlers.get('connection.update')?.({ connection: 'open' });
  await started;
}

beforeEach(() => {
  evHandlers.clear();
  socketConfigs.length = 0;
  fetchLatest.mockReset();
});

afterEach(async () => {
  for (const adapter of live.splice(0)) await adapter.stop();
});

describe('WhatsApp WA Web version (UBP-018)', () => {
  it('builds the socket with the freshly fetched version', async () => {
    fetchLatest.mockResolvedValue({ version: [2, 3000, 1099999999], isLatest: true });
    await startOpen(makeAdapter().adapter);
    expect(socketConfigs[0]?.version).toEqual([2, 3000, 1099999999]);
  });

  it('falls back to the bundled version when the fetch reports failure', async () => {
    fetchLatest.mockResolvedValue({
      version: [2, 3000, 1035194821],
      isLatest: false,
      error: new Error('offline'),
    });
    await startOpen(makeAdapter().adapter);
    expect(socketConfigs[0]).toBeDefined();
    expect('version' in (socketConfigs[0] ?? {})).toBe(false);
  });

  // Defensive only: the real fetchLatestWaWebVersion catches everything and
  // resolves `{ isLatest: false, error }` (wa-version-real.test.ts).
  it('falls back to the bundled version when the fetch throws', async () => {
    fetchLatest.mockRejectedValue(new Error('boom'));
    await startOpen(makeAdapter().adapter);
    expect('version' in (socketConfigs[0] ?? {})).toBe(false);
  });

  it('names a 405 close as a client-version rejection, not rate-limiting', async () => {
    fetchLatest.mockResolvedValue({ version: [2, 3000, 1], isLatest: true });
    const { adapter, errors } = makeAdapter();
    await startOpen(adapter);
    evHandlers.get('connection.update')?.({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 405 } } },
    });
    expect(errors.some((e) => e.includes('rejected the client version'))).toBe(true);
    expect(errors.some((e) => e.includes('2.3000.1'))).toBe(true);
    expect(errors.some((e) => e.includes('rate-limiting'))).toBe(false);
  });
});
