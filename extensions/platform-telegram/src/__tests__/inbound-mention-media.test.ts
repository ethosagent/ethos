// UBP-015 and UBP-016 — driven through the real `bot.on('message')` handler
// with a mocked grammy client (same harness shape as observe-inbound.test.ts).
//
// UBP-015: group mention detection read only `message.text`, case-sensitively,
// so a captioned photo `@bot …` in a `mention_only` group was dropped.
// UBP-016: a media message was handed back to grammY (update acked) before
// its download finished and before it reached the gateway, and a
// `cache.write` throw became an unhandled rejection that dropped it.

import { InMemoryAttachmentCache } from '@ethosagent/storage-fs';
import type { AttachmentCache, InboundMessage } from '@ethosagent/types';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const mockApi = {
  setMyName: vi.fn().mockResolvedValue(true),
  setMyShortDescription: vi.fn().mockResolvedValue(true),
  setMyDescription: vi.fn().mockResolvedValue(true),
  setMyCommands: vi.fn().mockResolvedValue(true),
  setMessageReaction: vi.fn().mockResolvedValue(true),
  getMe: vi
    .fn()
    .mockResolvedValue({ id: 1, is_bot: true, first_name: 'Bot', username: 'EthosBot' }),
  getFile: vi.fn().mockResolvedValue({ file_path: 'photos/f1.jpg', file_size: 4 }),
};

const registeredHandlers: Record<string, ((ctx: unknown) => unknown)[]> = {};

vi.mock('grammy', () => {
  class MockBot {
    token = '1:fake-token';
    api = mockApi;
    on(event: string, handler: (ctx: unknown) => unknown) {
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

afterEach(() => {
  vi.unstubAllGlobals();
});

async function mount(cache: AttachmentCache = new InMemoryAttachmentCache()) {
  for (const key of Object.keys(registeredHandlers)) delete registeredHandlers[key];
  const adapter = new TelegramAdapter({
    token: '1:fake-token',
    cache,
    botKey: 'test-bot',
    defaultChannelMode: 'mention_only',
  });
  await adapter.start();
  const captured: InboundMessage[] = [];
  adapter.onMessage((msg) => captured.push(msg));
  const handler = registeredHandlers.message?.[0];
  if (!handler) throw new Error('No message handler registered');
  return { captured, handler };
}

function groupCtx(message: Record<string, unknown>) {
  return {
    chat: { id: 100, type: 'supergroup' },
    from: { id: 200, username: 'alice' },
    message: { message_id: 7, date: 1_699_000_000, reply_to_message: null, ...message },
    me: { id: 1, username: 'EthosBot' },
  };
}

const photo = [{ file_id: 'p1', file_size: 4 }];

function stubDownload(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) })),
  );
}

describe('Telegram group mention detection (UBP-015)', () => {
  it('delivers a captioned photo that @mentions the bot in a mention_only group', async () => {
    stubDownload();
    const { captured, handler } = await mount();
    await handler(
      groupCtx({
        photo,
        caption: '@EthosBot what is this error?',
        caption_entities: [{ type: 'mention', offset: 0, length: 9 }],
      }),
    );
    expect(captured).toHaveLength(1);
    expect(captured[0].isGroupMention).toBe(true);
    expect(captured[0].text).toBe('@EthosBot what is this error?');
  });

  it('matches a lower-case mention of a mixed-case username', async () => {
    const { captured, handler } = await mount();
    await handler(
      groupCtx({
        text: 'hey @ethosbot ping',
        entities: [{ type: 'mention', offset: 4, length: 9 }],
      }),
    );
    expect(captured).toHaveLength(1);
    expect(captured[0].isGroupMention).toBe(true);
  });

  it('matches without entities (case-insensitive handle match)', async () => {
    const { captured, handler } = await mount();
    await handler(groupCtx({ text: 'hey @ETHOSBOT ping' }));
    expect(captured).toHaveLength(1);
  });

  it("does not match a different bot's handle that starts with ours", async () => {
    const { captured, handler } = await mount();
    await handler(
      groupCtx({
        text: 'hey @EthosBot2 ping',
        entities: [{ type: 'mention', offset: 4, length: 10 }],
      }),
    );
    await handler(groupCtx({ text: 'hey @EthosBot_old ping' }));
    expect(captured).toHaveLength(0);
  });
});

describe('Telegram media hand-off (UBP-016)', () => {
  it('the handler promise resolves only after the message reached the gateway', async () => {
    stubDownload();
    const { captured, handler } = await mount();
    const pending = handler(groupCtx({ photo, caption: '@EthosBot look' }));
    // grammY awaits this promise before it acks the update.
    expect(pending).toBeInstanceOf(Promise);
    await pending;
    expect(captured).toHaveLength(1);
    expect(captured[0].attachments).toHaveLength(1);
  });

  it('a cache.write throw still delivers the caption-only message', async () => {
    stubDownload();
    const throwing: AttachmentCache = {
      write: async () => {
        throw new Error('disk full');
      },
    } as unknown as AttachmentCache;
    const { captured, handler } = await mount(throwing);
    await expect(handler(groupCtx({ photo, caption: '@EthosBot look' }))).resolves.toBeUndefined();
    expect(captured).toHaveLength(1);
    expect(captured[0].text).toBe('@EthosBot look');
    expect(captured[0].attachments).toBeUndefined();
  });
});
