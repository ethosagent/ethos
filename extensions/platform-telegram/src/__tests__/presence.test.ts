// Plan personality-presence-and-initiative §3 — the bound personality shown on
// Telegram: the receipt reaction defaults to its `display.emoji` (falling back
// to `receiptReaction`, then 👀, and never dropped), and `mentionByName: true`
// lets a group message that names the personality count as a mention.
// Driven through the real `bot.on('message')` handler with a mocked grammy.

import type { ChannelPresence } from '@ethosagent/core';
import { InMemoryAttachmentCache } from '@ethosagent/storage-fs';
import type { InboundMessage } from '@ethosagent/types';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockApi = {
  setMyName: vi.fn().mockResolvedValue(true),
  setMyShortDescription: vi.fn().mockResolvedValue(true),
  setMyDescription: vi.fn().mockResolvedValue(true),
  setMyCommands: vi.fn().mockResolvedValue(true),
  setMessageReaction: vi.fn().mockResolvedValue(true),
  sendMessage: vi.fn().mockResolvedValue({ message_id: 900 }),
  getMe: vi.fn().mockResolvedValue({ id: 1, is_bot: true, first_name: 'Bot', username: 'testbot' }),
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

import { TelegramAdapter, telegramReceiptEmoji } from '../index';
import { loadTelegramSdk } from '../sdk';

beforeAll(async () => {
  await loadTelegramSdk();
});

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockClear();
  mockApi.setMessageReaction.mockResolvedValue(true);
  mockApi.sendMessage.mockResolvedValue({ message_id: 900 });
  for (const key of Object.keys(registeredHandlers)) delete registeredHandlers[key];
});

interface MountOptions {
  presence?: ChannelPresence;
  receiptReaction?: string;
  mentionByName?: boolean;
}

async function mount(opts: MountOptions): Promise<InboundMessage[]> {
  // One adapter per delivery: drop the previous mount's handlers.
  for (const key of Object.keys(registeredHandlers)) delete registeredHandlers[key];
  const adapter = new TelegramAdapter({
    token: '1:fake-token',
    cache: new InMemoryAttachmentCache(),
    botKey: 'test-bot',
    ...(opts.receiptReaction ? { receiptReaction: opts.receiptReaction } : {}),
    ...(opts.mentionByName !== undefined ? { mentionByName: opts.mentionByName } : {}),
  });
  if (opts.presence) {
    const presence = opts.presence;
    adapter.setPresenceResolver(() => presence);
  }
  await adapter.start();
  const captured: InboundMessage[] = [];
  adapter.onMessage((m) => captured.push(m));
  return captured;
}

async function deliver(
  opts: MountOptions & { text?: string; isDm?: boolean },
): Promise<InboundMessage[]> {
  const captured = await mount(opts);
  for (const h of registeredHandlers.message ?? []) {
    await h({
      chat: { id: 100, type: opts.isDm === false ? 'supergroup' : 'private' },
      from: { id: 200, username: 'someone' },
      message: {
        text: opts.text ?? 'hello',
        caption: undefined,
        message_id: 7,
        date: 1_699_000_000,
        reply_to_message: null,
      },
      me: { username: 'testbot' },
    });
  }
  return captured;
}

/** Let the reaction's `.catch` fallback chain settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

function reactionsSent(): string[] {
  return mockApi.setMessageReaction.mock.calls.map(
    (call) => (call[2] as Array<{ emoji: string }>)[0]?.emoji ?? '',
  );
}

describe('telegramReceiptEmoji', () => {
  it('uses the emoji when Telegram accepts it as a reaction', () => {
    expect(telegramReceiptEmoji('🔥', '👀')).toBe('🔥');
    expect(telegramReceiptEmoji('🦄', '👀')).toBe('🦄');
  });

  it('accepts the emoji-presentation spelling of a text-style reaction', () => {
    // ❤️ is U+2764 U+FE0F; Telegram's list spells it without the selector.
    expect(telegramReceiptEmoji('❤️', '👀')).toBe('❤');
  });

  it('falls back when the emoji is not in the Bot API reaction set', () => {
    expect(telegramReceiptEmoji('🦉', '👀')).toBe('👀');
    expect(telegramReceiptEmoji(undefined, '👀')).toBe('👀');
  });
});

describe('Telegram receipt reaction follows the bound personality', () => {
  it('with no presence, reacts 👀 exactly as before', async () => {
    await deliver({});
    expect(reactionsSent()).toEqual(['👀']);
  });

  it("reacts with the personality's emoji when Telegram allows it", async () => {
    await deliver({ presence: { name: 'Blaze', emoji: '🔥' } });
    expect(reactionsSent()).toEqual(['🔥']);
  });

  it('falls back to receiptReaction, then 👀, when the emoji is not a Telegram reaction', async () => {
    await deliver({ presence: { name: 'Owl', emoji: '🦉' } });
    expect(reactionsSent()).toEqual(['👀']);

    mockApi.setMessageReaction.mockClear();
    await deliver({ presence: { name: 'Owl', emoji: '🦉' }, receiptReaction: '👍' });
    expect(reactionsSent()).toEqual(['👍']);
  });

  it('an explicitly configured receiptReaction wins over the personality emoji', async () => {
    await deliver({ presence: { name: 'Blaze', emoji: '🔥' }, receiptReaction: '👍' });
    expect(reactionsSent()).toEqual(['👍']);
  });

  it('retries with the fallback when Telegram refuses the emoji in this chat — never drops it', async () => {
    mockApi.setMessageReaction.mockRejectedValueOnce(new Error('400: REACTION_INVALID'));
    await deliver({ presence: { name: 'Blaze', emoji: '🔥' } });
    await settle();
    expect(reactionsSent()).toEqual(['🔥', '👀']);
  });
});

describe('Telegram mentionByName', () => {
  const owl = { name: 'Owl', emoji: '🦉' };

  it('"hey Owl, …" in a group counts as a mention only with mentionByName on', async () => {
    const on = await deliver({
      presence: owl,
      mentionByName: true,
      isDm: false,
      text: 'hey Owl, when is the pour?',
    });
    expect(on).toHaveLength(1);
    expect(on[0]?.isGroupMention).toBe(true);

    const off = await deliver({ presence: owl, isDm: false, text: 'hey Owl, when is the pour?' });
    expect(off).toHaveLength(0);
  });

  it('"Owlish" does not match the name', async () => {
    const captured = await deliver({
      presence: owl,
      mentionByName: true,
      isDm: false,
      text: 'that sounds Owlish to me',
    });
    expect(captured).toHaveLength(0);
  });

  it('an @mention still counts without the name', async () => {
    const captured = await deliver({
      presence: owl,
      mentionByName: true,
      isDm: false,
      text: '@testbot status?',
    });
    expect(captured[0]?.isGroupMention).toBe(true);
  });
});

describe('Telegram receipt reaction is for messages addressed to the bot', () => {
  const owl = { name: 'Owl', emoji: '🦉' };

  it('does not react to a group message that only names the personality', async () => {
    // The channel filter may still drop it (a non-allowlisted member saying
    // "Owl"), and nothing would ever clear a reaction placed on it.
    const captured = await deliver({
      presence: owl,
      mentionByName: true,
      isDm: false,
      text: 'hey Owl, when is the pour?',
    });
    expect(captured).toHaveLength(1);
    expect(reactionsSent()).toEqual([]);
  });

  it('still reacts to an @mention, and to a DM, with mentionByName on', async () => {
    await deliver({ presence: owl, mentionByName: true, isDm: false, text: '@testbot hi Owl' });
    expect(reactionsSent()).toEqual(['👀']);

    mockApi.setMessageReaction.mockClear();
    await deliver({ presence: owl, mentionByName: true, isDm: true, text: 'hi Owl' });
    expect(reactionsSent()).toEqual(['👀']);
  });

  it('a second message in the chat does not orphan the first one’s reaction', async () => {
    for (const key of Object.keys(registeredHandlers)) delete registeredHandlers[key];
    const adapter = new TelegramAdapter({
      token: '1:fake-token',
      cache: new InMemoryAttachmentCache(),
      botKey: 'test-bot',
    });
    await adapter.start();
    adapter.onMessage(() => {});
    for (const messageId of [7, 8]) {
      for (const h of registeredHandlers.message ?? []) {
        await h({
          chat: { id: 100, type: 'supergroup' },
          from: { id: 200 + messageId, username: `user${messageId}` },
          message: {
            text: '@testbot question',
            caption: undefined,
            message_id: messageId,
            date: 1_699_000_000,
            reply_to_message: null,
          },
          me: { username: 'testbot' },
        });
      }
    }
    mockApi.setMessageReaction.mockClear();

    // The answer to message 7 clears 7's reaction, not 8's …
    await adapter.send('100', { text: 'answer one', replyToId: '7' });
    // … and the next answer (no replyToId) clears the one still pending.
    await adapter.send('100', { text: 'answer two' });
    const cleared = mockApi.setMessageReaction.mock.calls
      .filter((call) => (call[2] as unknown[]).length === 0)
      .map((call) => call[1]);
    expect(cleared).toEqual([7, 8]);
  });
});
