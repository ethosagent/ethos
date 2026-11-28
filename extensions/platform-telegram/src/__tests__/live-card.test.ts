import { InMemoryAttachmentCache, InMemoryStorage } from '@ethosagent/storage-fs';
import type { InboundMessage } from '@ethosagent/types';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// plan telegram-live-cards L4 — `TelegramAdapter.postCard` (CardCapableAdapter) and the `rca:`
// callback route. A tap is a user message: the adapter settles the card, edits it in place and
// emits an InboundMessage; admission, dedup and the spool are the gateway's (D10).
//
// grammy mock mirrors outbox-card.test.ts, with a keyboard that records its rows.
// ---------------------------------------------------------------------------

const mockApi = {
  setMyCommands: vi.fn().mockResolvedValue(true),
  sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
  editMessageText: vi.fn().mockResolvedValue(true),
  editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
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
    readonly rows: Array<Array<{ label: string; data: string }>> = [[]];
    text(label: string, data: string) {
      this.rows[this.rows.length - 1]?.push({ label, data });
      return this;
    }
    row() {
      this.rows.push([]);
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

const FILE = 'telegram/test-bot/card-actions.jsonl';
const TOAST_EXPIRED = 'This button has expired — type the request instead.';

function resetMocks() {
  for (const key of Object.keys(mockApi) as (keyof typeof mockApi)[]) mockApi[key].mockReset();
  mockApi.setMyCommands.mockResolvedValue(true);
  mockApi.sendMessage.mockResolvedValue({ message_id: 42 });
  mockApi.editMessageText.mockResolvedValue(true);
  mockApi.editMessageReplyMarkup.mockResolvedValue(true);
  mockApi.getMe.mockResolvedValue({ id: 1, is_bot: true, first_name: 'Bot', username: 'testbot' });
  for (const key of Object.keys(registeredHandlers)) delete registeredHandlers[key];
}

async function startAdapter(storage?: InMemoryStorage): Promise<{
  adapter: TelegramAdapter;
  inbound: InboundMessage[];
}> {
  const adapter = new TelegramAdapter({
    token: '1:fake-token',
    botKey: 'test-bot',
    cache: new InMemoryAttachmentCache(),
    ...(storage ? { storage } : {}),
  });
  const inbound: InboundMessage[] = [];
  adapter.onMessage((m) => inbound.push(m));
  await adapter.start();
  return { adapter, inbound };
}

const recommend = (over: Record<string, unknown> = {}) => ({
  kind: 'recommend_actions',
  specVersion: 1,
  payload: {
    question: 'Which sector?',
    actions: [
      { label: 'Tech', prompt: 'Break down the tech sector' },
      { label: 'Energy', prompt: 'Break down the energy sector' },
    ],
    ...over,
  },
});

type Keyboard = { rows: Array<Array<{ label: string; data: string }>> };

/** The buttons of the keyboard the last `sendMessage` carried. */
function sentButtons(): Array<{ label: string; data: string }> {
  const calls = mockApi.sendMessage.mock.calls;
  const opts = calls[calls.length - 1]?.[2] as { reply_markup?: Keyboard } | undefined;
  return (opts?.reply_markup?.rows ?? []).flat();
}

function tap(
  data: string,
  over: { queryId?: string; messageId?: number; chatType?: string; from?: { id: number } } = {},
) {
  const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
  registeredHandlers['callback_query:data']?.[0]({
    callbackQuery: {
      id: over.queryId ?? 'q1',
      data,
      message: {
        message_id: over.messageId ?? 42,
        chat: { id: 77, type: over.chatType ?? 'private' },
      },
      from: over.from ?? { id: 200, username: 'mitesh' },
    },
    answerCallbackQuery,
  });
  return answerCallbackQuery;
}

describe('TelegramAdapter.postCard', () => {
  beforeEach(resetMocks);

  it('posts a data card as HTML with no keyboard', async () => {
    const { adapter } = await startAdapter();

    const res = await adapter.postCard({
      chatId: '77',
      card: { kind: 'alert', specVersion: 1, payload: { severity: 'warning', message: 'a < b' } },
    });

    expect(res).toEqual({ ok: true, messageId: '42' });
    const [chatId, text, opts] = mockApi.sendMessage.mock.calls[0] ?? [];
    expect(chatId).toBe(77);
    expect(text).toBe('⚠️ a &lt; b');
    expect(opts).toMatchObject({ parse_mode: 'HTML' });
    expect(opts.reply_markup).toBeUndefined();
  });

  it('posts into the forum topic it was given', async () => {
    const { adapter } = await startAdapter();

    await adapter.postCard({
      chatId: '77',
      threadId: '9',
      card: { kind: 'alert', specVersion: 1, payload: { severity: 'info', message: 'hi' } },
    });

    expect(mockApi.sendMessage.mock.calls[0]?.[2]).toMatchObject({ message_thread_id: 9 });
  });

  it('posts recommend_actions with an rca: keyboard, one button per row', async () => {
    const { adapter } = await startAdapter();

    const res = await adapter.postCard({ chatId: '77', card: recommend() });

    expect(res.ok).toBe(true);
    const buttons = sentButtons();
    expect(buttons.map((b) => b.label)).toEqual(['Tech', 'Energy']);
    for (const [i, b] of buttons.entries()) {
      expect(b.data).toMatch(new RegExp(`^rca:[A-Z2-7]{10}:${i}$`));
      expect(Buffer.byteLength(b.data, 'utf-8')).toBeLessThanOrEqual(64);
    }
    const sendOpts = mockApi.sendMessage.mock.calls[0]?.[2] as
      | { reply_markup?: Keyboard }
      | undefined;
    const rows = sendOpts?.reply_markup?.rows ?? [];
    expect(rows.filter((r) => r.length > 0)).toHaveLength(2);
  });

  it('puts the keyboard on the last chunk only', async () => {
    mockApi.sendMessage
      .mockResolvedValueOnce({ message_id: 10 })
      .mockResolvedValueOnce({ message_id: 11 });
    const { adapter } = await startAdapter();
    const adapterWithSmallLimit = Object.assign(adapter, { maxMessageLength: 120 });

    const res = await adapterWithSmallLimit.postCard({
      chatId: '77',
      card: recommend({ question: 'word '.repeat(38).trim() }),
    });

    expect(mockApi.sendMessage).toHaveBeenCalledTimes(2);
    expect(mockApi.sendMessage.mock.calls[0]?.[2].reply_markup).toBeUndefined();
    expect(mockApi.sendMessage.mock.calls[1]?.[2].reply_markup).toBeDefined();
    // The id of the message that carries the keyboard is the edit-in-place key.
    expect(res).toEqual({ ok: true, messageId: '11' });
  });

  it('refuses an invalid envelope without sending', async () => {
    const { adapter } = await startAdapter();

    const res = await adapter.postCard({ chatId: '77', card: { kind: 'text', payload: {} } });

    expect(res.ok).toBe(false);
    expect(mockApi.sendMessage).not.toHaveBeenCalled();
  });

  it('D18: a rejected HTML parse re-sends the same chunk as plain text, keeping the keyboard', async () => {
    mockApi.sendMessage
      .mockRejectedValueOnce(new Error("400: Bad Request: can't parse entities: Unsupported tag"))
      .mockResolvedValueOnce({ message_id: 43 });
    const { adapter } = await startAdapter();

    const res = await adapter.postCard({ chatId: '77', card: recommend({ question: 'A & B?' }) });

    expect(res).toEqual({ ok: true, messageId: '43' });
    const [, text, opts] = mockApi.sendMessage.mock.calls[1] ?? [];
    expect(text).toBe('A & B?');
    expect(opts.parse_mode).toBeUndefined();
    expect(opts.reply_markup).toBeDefined();
  });

  it('reports a send failure as ok:false', async () => {
    mockApi.sendMessage.mockRejectedValueOnce(new Error('403: Forbidden: bot was blocked'));
    const { adapter } = await startAdapter();

    const res = await adapter.postCard({ chatId: '77', card: recommend() });

    expect(res.ok).toBe(false);
  });
});

describe('rca: callback route', () => {
  beforeEach(resetMocks);

  async function postedCard(storage = new InMemoryStorage()) {
    const started = await startAdapter(storage);
    await started.adapter.postCard({ chatId: '77', card: recommend() });
    return { ...started, storage, buttons: sentButtons() };
  }

  it('a valid tap settles the card, edits it in place and sends the prompt as a user message', async () => {
    const { inbound, buttons } = await postedCard();

    const answer = tap(buttons[1]?.data ?? '', { queryId: 'q-abc' });

    await vi.waitFor(() => expect(inbound).toHaveLength(1));
    expect(answer).toHaveBeenCalledTimes(1);
    expect(mockApi.editMessageText).toHaveBeenCalledTimes(1);
    const [chatId, messageId, text, opts] = mockApi.editMessageText.mock.calls[0] ?? [];
    expect([chatId, messageId]).toEqual([77, 42]);
    expect(text).toBe('Which sector?\n→ Energy');
    expect(opts).toMatchObject({ parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } });
    expect(inbound[0]).toMatchObject({
      platform: 'telegram',
      botKey: 'test-bot',
      chatId: '77',
      userId: '200',
      username: 'mitesh',
      text: 'Break down the energy sector',
      messageId: 'cbq:q-abc',
      replyToId: '42',
      replyToUserId: '1',
      isDm: true,
      isGroupMention: true,
    });
  });

  it('a tap in a group is a group mention from the tapper, not a DM', async () => {
    const { inbound, buttons } = await postedCard();

    tap(buttons[0]?.data ?? '', { chatType: 'supergroup', from: { id: 300 } });

    await vi.waitFor(() => expect(inbound).toHaveLength(1));
    expect(inbound[0]).toMatchObject({ isDm: false, isGroupMention: true, userId: '300' });
  });

  it('a second tap says "Already chosen." and sends nothing', async () => {
    const { inbound, buttons } = await postedCard();
    tap(buttons[0]?.data ?? '', { queryId: 'q1' });
    await vi.waitFor(() => expect(inbound).toHaveLength(1));
    mockApi.editMessageText.mockClear();

    const answer = tap(buttons[1]?.data ?? '', { queryId: 'q2' });

    await vi.waitFor(() => expect(answer).toHaveBeenCalledWith({ text: 'Already chosen.' }));
    expect(inbound).toHaveLength(1);
    expect(mockApi.editMessageText).not.toHaveBeenCalled();
  });

  it('after a restart a settled card still says "Already chosen." (fresh CardActionStore load, same Storage)', async () => {
    const first = await postedCard();
    tap(first.buttons[0]?.data ?? '');
    await vi.waitFor(() => expect(first.inbound).toHaveLength(1));
    // An untouched sibling card, to prove open cards also survive.
    mockApi.sendMessage.mockResolvedValueOnce({ message_id: 43 });
    await first.adapter.postCard({ chatId: '77', card: recommend() });
    const openButtons = sentButtons();

    resetMocks();
    const second = await startAdapter(first.storage);
    const settled = tap(first.buttons[1]?.data ?? '', { queryId: 'after-restart' });
    await vi.waitFor(() => expect(settled).toHaveBeenCalledWith({ text: 'Already chosen.' }));
    expect(second.inbound).toHaveLength(0);

    const open = tap(openButtons[0]?.data ?? '', { queryId: 'open-after-restart', messageId: 43 });
    await vi.waitFor(() => expect(second.inbound).toHaveLength(1));
    expect(open).toHaveBeenCalledTimes(1);
    expect(second.inbound[0]?.text).toBe('Break down the tech sector');
  });

  it('a card whose file was deleted reads as expired: toast, keyboard stripped, no turn', async () => {
    const { storage, buttons } = await postedCard();
    await storage.remove(FILE);

    resetMocks();
    const restarted = await startAdapter(storage);
    const answer = tap(buttons[0]?.data ?? '', { messageId: 42 });

    await vi.waitFor(() => expect(answer).toHaveBeenCalledWith({ text: TOAST_EXPIRED }));
    await vi.waitFor(() => expect(mockApi.editMessageReplyMarkup).toHaveBeenCalledTimes(1));
    expect(mockApi.editMessageReplyMarkup.mock.calls[0]).toEqual([
      77,
      42,
      { reply_markup: { inline_keyboard: [] } },
    ]);
    expect(restarted.inbound).toHaveLength(0);
  });

  it('an unknown token is expired, never a silent turn', async () => {
    const { inbound } = await postedCard();

    const answer = tap('rca:ZZZZZZZZZZ:0');

    await vi.waitFor(() => expect(answer).toHaveBeenCalledWith({ text: TOAST_EXPIRED }));
    expect(inbound).toHaveLength(0);
  });

  it('answers the spinner on every path, including malformed and out-of-range taps', async () => {
    const { buttons } = await postedCard();
    const token = buttons[0]?.data.split(':')[1] ?? '';

    const malformed = tap('rca:not-a-token');
    const outOfRange = tap(`rca:${token}:7`);

    await vi.waitFor(() => expect(malformed).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(outOfRange).toHaveBeenCalledTimes(1));
    expect(malformed).toHaveBeenCalledWith({ text: 'Unrecognised button.' });
  });

  it('a failing settle edit does not lose the turn', async () => {
    const { inbound, buttons } = await postedCard();
    mockApi.editMessageText.mockRejectedValueOnce(
      new Error('400: Bad Request: message to edit not found'),
    );

    const answer = tap(buttons[0]?.data ?? '');

    await vi.waitFor(() => expect(inbound).toHaveLength(1));
    expect(answer).toHaveBeenCalled();
  });

  it('a settle edit Telegram calls "not modified" counts as done', async () => {
    const { inbound, buttons } = await postedCard();
    mockApi.editMessageText.mockRejectedValueOnce(
      new Error('400: Bad Request: message is not modified'),
    );

    tap(buttons[0]?.data ?? '');

    await vi.waitFor(() => expect(inbound).toHaveLength(1));
  });

  it('leaves obx:, approve: and clr: routing unchanged', async () => {
    const { adapter } = await postedCard();
    const clarify: string[] = [];
    adapter.onCallbackQuery((e) => clarify.push(e.data));
    const outbox: string[] = [];
    adapter.onOutboxDecision((e) => {
      outbox.push(e.itemId);
    });

    tap('obx:a:obx_0123456789abcdef:2');
    tap('clr:xyz:1');

    await vi.waitFor(() => expect(outbox).toEqual(['obx_0123456789abcdef']));
    await vi.waitFor(() => expect(clarify).toEqual(['clr:xyz:1']));
  });
});
