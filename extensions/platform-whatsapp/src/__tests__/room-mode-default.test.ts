// Plan channel-prompts L12: WhatsApp's room-config default reply mode, driven
// through the real `messages.upsert` handler (mocked Baileys socket).

import type { InboundMessage, Storage } from '@ethosagent/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelMode } from '../config';
import type { RawWhatsAppMessage } from '../message-parser';

const BOT_JID = '15551234567:12@s.whatsapp.net';
const GROUP = '120363000000000000@g.us';
const DM = '15559999999@s.whatsapp.net';
const evHandlers = new Map<string, (payload: unknown) => unknown>();

vi.mock('@whiskeysockets/baileys', () => ({
  makeWASocket: () => ({
    ev: {
      on: (event: string, handler: (payload: unknown) => unknown) => {
        evHandlers.set(event, handler);
      },
    },
    user: { id: BOT_JID },
    authState: { creds: { registered: true } },
    sendMessage: async () => ({ key: { id: 'sent-1' } }),
  }),
  useMultiFileAuthState: async () => ({ state: {}, saveCreds: () => {} }),
  DisconnectReason: { loggedOut: 401 },
  downloadMediaMessage: async () => Buffer.from([1]),
}));

const { WhatsAppAdapter } = await import('../index');

function fakeStorage(files: Record<string, string>): Storage {
  return {
    read: async (path: string) => files[path] ?? null,
    mkdir: async () => {},
    append: async (path: string, data: string) => {
      files[path] = (files[path] ?? '') + data;
    },
  } as unknown as Storage;
}

async function deliver(opts: {
  roomMode?: string;
  withRoomFn?: boolean;
  defaultMode?: ChannelMode;
  defaultModeConfigured?: boolean;
  storedMode?: string;
  jid?: string;
}): Promise<{ got: InboundMessage[]; asked: Array<Record<string, unknown>> }> {
  evHandlers.clear();
  const jid = opts.jid ?? GROUP;
  const asked: Array<Record<string, unknown>> = [];
  const files: Record<string, string> = {};
  if (opts.storedMode !== undefined) {
    files['whatsapp/bot1/channel-overrides.jsonl'] =
      `${JSON.stringify({ channel: jid, mode: opts.storedMode, updatedAt: 1 })}\n`;
  }
  const adapter = new WhatsAppAdapter({
    sessionDir: '/tmp/ethos-wa-room-mode-test',
    botKey: 'bot1',
    denyUnknown: false,
    ...(opts.defaultMode ? { defaultMode: opts.defaultMode } : {}),
    ...(opts.defaultModeConfigured !== undefined
      ? { defaultModeConfigured: opts.defaultModeConfigured }
      : {}),
    ...(opts.withRoomFn === false
      ? {}
      : {
          roomModeDefault: (i: Record<string, unknown>) => {
            asked.push(i);
            return opts.roomMode;
          },
        }),
    ...(opts.storedMode !== undefined
      ? { storage: fakeStorage(files), whatsappDir: 'whatsapp' }
      : {}),
  });
  const got: InboundMessage[] = [];
  adapter.onMessage((m) => got.push(m));
  const started = adapter.start();
  await vi.waitFor(() => {
    if (!evHandlers.has('connection.update')) throw new Error('not registered yet');
  });
  evHandlers.get('connection.update')?.({ connection: 'open' });
  await started;
  const msg: RawWhatsAppMessage = {
    key: { remoteJid: jid, fromMe: false, id: 'wa-1', participant: DM },
    message: { conversation: 'pour slipped to thursday' },
    messageTimestamp: 1700000000,
  };
  await evHandlers.get('messages.upsert')?.({ type: 'notify', messages: [msg] });
  return { got, asked };
}

beforeEach(() => {
  evHandlers.clear();
});

describe('whatsapp room mode default (L12)', () => {
  it('uses the room mode when there is no runtime override', async () => {
    const { got, asked } = await deliver({ roomMode: 'observe', defaultMode: 'all' });
    expect(got).toHaveLength(1);
    expect(got[0]?.recordOnly).toBe(true);
    expect(got[0]?.channelMode).toBe('observe');
    expect(got[0]?.channelModeSource).toBe('room');
    expect(asked[0]).toEqual({ chatId: GROUP, isDm: false });
  });

  it('a runtime override beats the room mode', async () => {
    const { got } = await deliver({ roomMode: 'observe', storedMode: 'all' });
    expect(got[0]?.recordOnly).toBe(false);
    expect(got[0]?.channelMode).toBe('all');
    expect(got[0]?.channelModeSource).toBe('runtime');
  });

  it('falls to the platform default, then the built-in, when the room has no mode', async () => {
    const platform = await deliver({ defaultMode: 'observe' });
    expect(platform.got[0]?.channelModeSource).toBe('platform');
    expect(platform.got[0]?.recordOnly).toBe(true);
    const builtin = await deliver({});
    expect(builtin.got[0]?.channelModeSource).toBe('default');
    expect(builtin.got[0]?.recordOnly).toBe(false); // built-in default is `all`
  });

  it('a host-filled default reads as source default, a configured one as platform', async () => {
    const filled = await deliver({ defaultMode: 'all', defaultModeConfigured: false });
    expect(filled.got[0]?.channelModeSource).toBe('default');
    const configured = await deliver({ defaultMode: 'all', defaultModeConfigured: true });
    expect(configured.got[0]?.channelModeSource).toBe('platform');
  });

  it('an invalid room mode string never answers (fails closed, nothing recorded)', async () => {
    const { got } = await deliver({ roomMode: 'thread_follow', defaultMode: 'all' });
    expect(got).toHaveLength(0);
  });

  it('a DM is asked with isDm and is answered whatever the room mode says', async () => {
    const { got, asked } = await deliver({ roomMode: 'observe', jid: DM });
    expect(asked[0]).toEqual({ chatId: DM, isDm: true });
    expect(got[0]?.recordOnly).toBe(false);
  });

  it('stamps nothing without a room policy hook', async () => {
    const { got } = await deliver({ withRoomFn: false });
    expect(got[0]?.channelMode).toBeUndefined();
    expect(got[0]?.channelModeSource).toBeUndefined();
  });
});
