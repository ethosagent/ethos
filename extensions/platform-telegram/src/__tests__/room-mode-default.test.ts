// Plan channel-prompts L12: Telegram's room-config default reply mode, driven
// through the real `bot.on('message')` handler with a mocked grammy client.

import { InMemoryAttachmentCache, InMemoryStorage } from '@ethosagent/storage-fs';
import type { InboundMessage, Storage } from '@ethosagent/types';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const mockApi = {
  setMyName: vi.fn().mockResolvedValue(true),
  setMyShortDescription: vi.fn().mockResolvedValue(true),
  setMyDescription: vi.fn().mockResolvedValue(true),
  setMyCommands: vi.fn().mockResolvedValue(true),
  setMessageReaction: vi.fn().mockResolvedValue(true),
  getMe: vi.fn().mockResolvedValue({ id: 1, is_bot: true, first_name: 'Bot', username: 'testbot' }),
  getFile: vi.fn().mockResolvedValue({ file_path: 'photos/f1.jpg', file_size: 4 }),
};

const registeredHandlers: Record<string, ((ctx: unknown) => void)[]> = {};

vi.mock('grammy', () => {
  class MockBot {
    token = '1:fake-token';
    api = mockApi;
    on(event: string, handler: (ctx: unknown) => void) {
      if (!registeredHandlers[event]) registeredHandlers[event] = [];
      registeredHandlers[event].push(handler);
    }
    start() {
      return Promise.resolve();
    }
    stop() {
      return Promise.resolve();
    }
  }
  class MockInlineKeyboard {
    text() {
      return this;
    }
    row() {
      return this;
    }
  }
  return { Bot: MockBot, InlineKeyboard: MockInlineKeyboard };
});

import { TelegramAdapter } from '../index';
import { loadTelegramSdk } from '../sdk';

beforeAll(async () => {
  await loadTelegramSdk();
});

const BOT_KEY = 'test-bot';
const OVERRIDES_FILE = `telegram/${BOT_KEY}/channel-overrides.jsonl`;

interface Opts {
  roomMode?: string | undefined;
  withRoomFn?: boolean;
  defaultChannelMode?: 'mention_only' | 'all' | 'observe';
  storedMode?: string;
  isDm?: boolean;
  threadId?: number;
}

async function deliver(
  opts: Opts,
): Promise<{ got: InboundMessage[]; asked: Array<Record<string, unknown>> }> {
  for (const fn of Object.values(mockApi)) fn.mockClear();
  for (const key of Object.keys(registeredHandlers)) delete registeredHandlers[key];
  let storage: Storage | undefined;
  if (opts.storedMode !== undefined) {
    storage = new InMemoryStorage();
    await storage.mkdir(`telegram/${BOT_KEY}`);
    await storage.write(
      OVERRIDES_FILE,
      `${JSON.stringify({ channel: '100', mode: opts.storedMode, updatedAt: 1 })}\n`,
    );
  }
  const asked: Array<Record<string, unknown>> = [];
  const adapter = new TelegramAdapter({
    token: '1:fake-token',
    cache: new InMemoryAttachmentCache(),
    botKey: BOT_KEY,
    ...(opts.defaultChannelMode ? { defaultChannelMode: opts.defaultChannelMode } : {}),
    ...(opts.withRoomFn === false
      ? {}
      : {
          roomModeDefault: (input: Record<string, unknown>) => {
            asked.push(input);
            return opts.roomMode;
          },
        }),
    ...(storage ? { storage } : {}),
  });
  await adapter.start();
  const got: InboundMessage[] = [];
  adapter.onMessage((m) => got.push(m));
  for (const h of registeredHandlers.message ?? []) {
    h({
      chat: { id: 100, type: opts.isDm ? 'private' : 'supergroup' },
      from: { id: 200, username: 'sitemanager' },
      message: {
        text: 'concrete pour slipped to thursday',
        message_id: 7,
        date: 1_699_000_000,
        reply_to_message: null,
        ...(opts.threadId ? { message_thread_id: opts.threadId } : {}),
      },
      me: { username: 'testbot' },
    });
  }
  return { got, asked };
}

describe('telegram room mode default (L12)', () => {
  it('uses the room mode when there is no runtime override', async () => {
    const { got, asked } = await deliver({ roomMode: 'all', threadId: 5 });
    expect(got).toHaveLength(1);
    expect(got[0]?.recordOnly).toBe(false);
    expect(got[0]?.channelMode).toBe('all');
    expect(got[0]?.channelModeSource).toBe('room');
    expect(asked[0]).toEqual({ chatId: '100', threadId: '5', isDm: false });
  });

  it('a runtime override beats the room mode', async () => {
    const { got } = await deliver({ roomMode: 'all', storedMode: 'observe' });
    expect(got[0]?.recordOnly).toBe(true);
    expect(got[0]?.channelMode).toBe('observe');
    expect(got[0]?.channelModeSource).toBe('runtime');
  });

  it('falls to the platform default, then the built-in, when the room has no mode', async () => {
    const platform = await deliver({ roomMode: undefined, defaultChannelMode: 'observe' });
    expect(platform.got[0]?.channelModeSource).toBe('platform');
    expect(platform.got[0]?.recordOnly).toBe(true);
    const builtin = await deliver({ roomMode: undefined });
    expect(builtin.got).toHaveLength(0); // mention_only, no mention: dropped
    // the built-in default is reported when something is recorded
    const dm = await deliver({ roomMode: undefined, isDm: true });
    expect(dm.got[0]?.channelModeSource).toBe('default');
  });

  it('an invalid room mode string never answers (fails closed, nothing recorded)', async () => {
    const { got } = await deliver({ roomMode: 'definitely_not_a_mode', defaultChannelMode: 'all' });
    expect(got).toHaveLength(0);
  });

  it('stamps nothing without a room policy hook', async () => {
    const { got } = await deliver({ withRoomFn: false, defaultChannelMode: 'all' });
    expect(got[0]?.channelMode).toBeUndefined();
    expect(got[0]?.channelModeSource).toBeUndefined();
  });
});
