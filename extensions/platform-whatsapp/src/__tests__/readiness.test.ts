// R5 (plan/phases/openclaw-2026.9.6-gaps.md) — three readiness gaps in the
// WhatsApp adapter, each driven through the real `start()` and the real
// `messages.upsert` handler against a faked Baileys socket:
//   1. `start()` resolved before the socket opened, so the gateway's boot
//      sweep and spool replay sent into a socket that could not deliver.
//   2. every `append` upsert was dropped, and `append` is how Baileys hands
//      over the messages that arrived while the socket was reconnecting.
//   3. a LID-addressed sender never matched a phone-number `allowedJids` entry.

import type { InboundMessage } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawWhatsAppMessage } from '../message-parser';

const BOT_JID = '15551234567:12@s.whatsapp.net';
const PHONE = '15559999999';
const PHONE_JID = `${PHONE}@s.whatsapp.net`;
const LID_JID = '987654321012345@lid';
const GROUP = '120363000000000000@g.us';

/** Handlers the adapter registers on the CURRENT socket's `ev`. */
const evHandlers = new Map<string, (payload: unknown) => unknown>();
let socketsMade = 0;

vi.mock('@whiskeysockets/baileys', () => ({
  makeWASocket: () => {
    socketsMade += 1;
    return {
      ev: {
        on: (event: string, handler: (payload: unknown) => unknown) => {
          evHandlers.set(event, handler);
        },
      },
      user: { id: BOT_JID },
      authState: { creds: { registered: true } },
      sendMessage: async () => ({ key: { id: 'sent-1' } }),
      end: () => {},
    };
  },
  useMultiFileAuthState: async () => ({ state: {}, saveCreds: () => {} }),
  DisconnectReason: { loggedOut: 401 },
  downloadMediaMessage: vi.fn(async () => Buffer.from([])),
}));

const { WhatsAppAdapter } = await import('../index');

type Adapter = InstanceType<typeof WhatsAppAdapter>;
const live: Adapter[] = [];

function makeAdapter(opts: { allowedJids?: string[] } = {}) {
  const adapter = new WhatsAppAdapter({
    sessionDir: '/tmp/ethos-wa-readiness-test',
    botKey: 'bot1',
    ...(opts.allowedJids ? { allowedJids: opts.allowedJids } : { denyUnknown: false }),
  });
  live.push(adapter);
  const received: InboundMessage[] = [];
  adapter.onMessage((m) => received.push(m));
  return { adapter, received };
}

/** Emits a connection event on the current socket. */
function connection(update: Record<string, unknown>): void {
  const handler = evHandlers.get('connection.update');
  if (!handler) throw new Error('adapter registered no connection.update handler');
  handler(update);
}

async function waitForHandlers(): Promise<void> {
  await vi.waitFor(() => {
    if (!evHandlers.has('messages.upsert')) throw new Error('handlers not registered yet');
  });
}

/** Starts the adapter and opens its socket — the happy boot path. */
async function startOpen(adapter: Adapter): Promise<void> {
  const started = adapter.start();
  await waitForHandlers();
  connection({ connection: 'open' });
  await started;
}

async function upsert(type: 'notify' | 'append', msg: RawWhatsAppMessage): Promise<void> {
  const handler = evHandlers.get('messages.upsert');
  if (!handler) throw new Error('adapter registered no messages.upsert handler');
  await handler({ type, messages: [msg] });
}

function dm(from: string, text: string, extra: Partial<RawWhatsAppMessage['key']> = {}) {
  return {
    key: { remoteJid: from, fromMe: false, id: `wa-${text}`, ...extra },
    message: { conversation: text },
    messageTimestamp: Math.floor(Date.now() / 1000),
  } satisfies RawWhatsAppMessage;
}

beforeEach(() => {
  evHandlers.clear();
  socketsMade = 0;
});

afterEach(async () => {
  for (const adapter of live.splice(0)) await adapter.stop();
  vi.useRealTimers();
});

describe('WhatsAppAdapter.start readiness', () => {
  it('does not resolve until the socket reports connection open', async () => {
    const { adapter } = makeAdapter();
    let resolved = false;
    const started = adapter.start().then(() => {
      resolved = true;
    });
    await waitForHandlers();
    // Give every pending microtask and a macrotask a chance to settle.
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);
    expect((await adapter.health()).ok).toBe(false);

    connection({ connection: 'open' });
    await started;
    expect(resolved).toBe(true);
    expect((await adapter.health()).ok).toBe(true);
  });

  it('gives up waiting after the 30s bound and reports not ok', async () => {
    vi.useFakeTimers();
    const { adapter } = makeAdapter();
    let resolved = false;
    const started = adapter.start().then(() => {
      resolved = true;
    });
    await waitForHandlers();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await started;
    expect(resolved).toBe(true);
    expect((await adapter.health()).ok).toBe(false);
  });
});

describe('WhatsAppAdapter append upserts', () => {
  it('drops an append upsert when the socket never closed (history sync)', async () => {
    const { adapter, received } = makeAdapter();
    await startOpen(adapter);
    await upsert('append', dm(PHONE_JID, 'old history'));
    expect(received).toEqual([]);
  });

  it('admits an append upsert that arrives inside the reconnect window', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { adapter, received } = makeAdapter();
    const started = adapter.start();
    await waitForHandlers();
    connection({ connection: 'open' });
    await started;

    connection({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 500 } } } });
    // The reconnect timer fires, a fresh socket registers, then opens.
    evHandlers.clear();
    await vi.advanceTimersByTimeAsync(3_000);
    await waitForHandlers();
    expect(socketsMade).toBe(2);
    connection({ connection: 'open' });

    await upsert('append', dm(PHONE_JID, 'sent while reconnecting'));
    expect(received.map((m) => m.text)).toEqual(['sent while reconnecting']);
  });

  it('drops an append upsert once the window after the reopen has passed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { adapter, received } = makeAdapter();
    const started = adapter.start();
    await waitForHandlers();
    connection({ connection: 'open' });
    await started;

    connection({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 500 } } } });
    evHandlers.clear();
    await vi.advanceTimersByTimeAsync(3_000);
    await waitForHandlers();
    connection({ connection: 'open' });
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    await upsert('append', dm(PHONE_JID, 'far too late'));
    expect(received).toEqual([]);
  });

  it('drops an append upsert for a message sent long before the close', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { adapter, received } = makeAdapter();
    const started = adapter.start();
    await waitForHandlers();
    connection({ connection: 'open' });
    await started;

    connection({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 500 } } } });
    const stale = { ...dm(PHONE_JID, 'last week'), messageTimestamp: 1_700_000_000 };
    await upsert('append', stale);
    expect(received).toEqual([]);
  });
});

describe('WhatsAppAdapter LID senders', () => {
  it('matches a LID DM sender against a phone allowlist through remoteJidAlt', async () => {
    const { adapter, received } = makeAdapter({ allowedJids: [`+${PHONE}`] });
    await startOpen(adapter);
    await upsert('notify', dm(LID_JID, 'hello', { remoteJidAlt: PHONE_JID }));
    expect(received).toHaveLength(1);
    // Identity stays the jid as received (what it was before R5): the phone
    // form is an additional MATCH key only, so the identity map, owner config
    // and pairing rows keyed on the LID keep working.
    expect(received[0]?.userId).toBe(LID_JID);
    expect(received[0]?.alternateUserIds).toEqual([PHONE_JID]);
    // Replies still go to the chat the message arrived in.
    expect(received[0]?.chatId).toBe(LID_JID);
  });

  it('matches a LID group participant through participantAlt', async () => {
    const { adapter, received } = makeAdapter({ allowedJids: [PHONE] });
    await startOpen(adapter);
    await upsert('notify', {
      key: {
        remoteJid: GROUP,
        fromMe: false,
        id: 'wa-group',
        participant: LID_JID,
        participantAlt: PHONE_JID,
      },
      message: { conversation: 'hi all' },
      messageTimestamp: Math.floor(Date.now() / 1000),
    });
    expect(received).toHaveLength(1);
    expect(received[0]?.userId).toBe(LID_JID);
    expect(received[0]?.alternateUserIds).toEqual([PHONE_JID]);
  });

  it('still admits a LID sender against a LID allowlist when Baileys supplies a phone alt', async () => {
    const { adapter, received } = makeAdapter({ allowedJids: [LID_JID] });
    await startOpen(adapter);
    await upsert('notify', dm(LID_JID, 'hello', { remoteJidAlt: PHONE_JID }));
    expect(received).toHaveLength(1);
    expect(received[0]?.userId).toBe(LID_JID);
  });

  it('still admits a LID group participant against a LID allowlist with a phone alt', async () => {
    const { adapter, received } = makeAdapter({ allowedJids: [LID_JID] });
    await startOpen(adapter);
    await upsert('notify', {
      key: {
        remoteJid: GROUP,
        fromMe: false,
        id: 'wa-group-lid',
        participant: LID_JID,
        participantAlt: PHONE_JID,
      },
      message: { conversation: 'hi all' },
      messageTimestamp: Math.floor(Date.now() / 1000),
    });
    expect(received).toHaveLength(1);
    expect(received[0]?.userId).toBe(LID_JID);
  });

  it('carries no alternate for a phone-addressed sender', async () => {
    const { adapter, received } = makeAdapter({ allowedJids: [PHONE] });
    await startOpen(adapter);
    await upsert('notify', dm(PHONE_JID, 'plain'));
    expect(received).toHaveLength(1);
    expect(received[0]?.userId).toBe(PHONE_JID);
    expect(received[0]?.alternateUserIds).toBeUndefined();
  });

  it('still refuses a LID sender with no phone alternate', async () => {
    const { adapter, received } = makeAdapter({ allowedJids: [PHONE] });
    await startOpen(adapter);
    await upsert('notify', dm(LID_JID, 'who am i'));
    expect(received).toEqual([]);
  });
});
