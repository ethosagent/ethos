import { InMemoryAttachmentCache } from '@ethosagent/storage-fs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Telegram `init:` callback routing for the initiative digest and brief buttons. Parsing is the
// adapter's whole job; the owner check lives in apps/ethos/src/lib/initiative-wiring.ts.

const mockApi = {
  setMyCommands: vi.fn().mockResolvedValue(true),
  sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
  editMessageText: vi.fn().mockResolvedValue(true),
  getMe: vi.fn().mockResolvedValue({ id: 1, is_bot: true, first_name: 'Bot', username: 'testbot' }),
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
    readonly buttons: Array<{ label: string; data: string }> = [];
    text(label: string, data: string) {
      this.buttons.push({ label, data });
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

// The adapter reads grammy through sdk.ts (loaded lazily in production).
beforeAll(async () => {
  await loadTelegramSdk();
});

function startAdapter() {
  const adapter = new TelegramAdapter({
    token: '1:fake-token',
    botKey: 'test-bot',
    cache: new InMemoryAttachmentCache(),
  });
  return adapter.start().then(() => adapter);
}

function tap(data: string, from = { id: 200 }) {
  const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
  registeredHandlers['callback_query:data']?.[0]({
    callbackQuery: { id: 'q1', data, message: { message_id: 55, chat: { id: 77 } }, from },
    answerCallbackQuery,
  });
  return answerCallbackQuery;
}

beforeEach(() => {
  for (const key of Object.keys(registeredHandlers)) delete registeredHandlers[key];
  mockApi.getMe.mockResolvedValue({ id: 1, is_bot: true, first_name: 'Bot', username: 'testbot' });
});

describe('init: callback routing', () => {
  it('routes a well-formed init: tap to the initiative handler and drops a malformed one', async () => {
    const adapter = await startAdapter();
    const taps: Array<{
      verb: string;
      target: string;
      userId: string | undefined;
      chatId: string;
    }> = [];
    adapter.onInitiativeAction((evt) => {
      taps.push(evt);
    });

    tap('init:adopt:EXP-0003');
    await vi.waitFor(() => expect(taps).toHaveLength(1));
    expect(taps[0]).toMatchObject({
      verb: 'adopt',
      target: 'EXP-0003',
      userId: '200',
      chatId: '77',
    });

    const bad = tap('init:adopt:EXP 3 free text');
    await vi.waitFor(() => expect(bad).toHaveBeenCalledWith({ text: 'Unrecognised button.' }));
    expect(taps).toHaveLength(1);
  });

  it('reply resolves true on a sent message and false when Telegram refuses it', async () => {
    const adapter = await startAdapter();
    const results: boolean[] = [];
    adapter.onInitiativeAction(async (evt) => {
      results.push(await evt.reply('one'));
      results.push(await evt.reply('two'));
    });
    mockApi.sendMessage.mockResolvedValueOnce({ message_id: 1 });
    mockApi.sendMessage.mockRejectedValueOnce(new Error('message is too long'));
    tap('init:copy_md:EXP-0003');
    await vi.waitFor(() => expect(results).toEqual([true, false]));
  });
});
