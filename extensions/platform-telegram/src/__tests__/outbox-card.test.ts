import { InMemoryAttachmentCache } from '@ethosagent/storage-fs';
import type { ApprovalDecisionEvent } from '@ethosagent/types';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// O-T8 — Telegram outbox card + `obx:` callback route.
//
// The adapter renders and routes. The owner check and the revision check are
// the outbox wiring's job (apps/ethos/src/lib/outbox-wiring.ts), so nothing
// here asserts them — these cases pin what the wiring is handed.
//
// grammy mock mirrors phase4.test.ts.
// ---------------------------------------------------------------------------

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

import {
  type OutboxCardBody,
  type OutboxCardInput,
  type OutboxDecisionEvent,
  TelegramAdapter,
  type TelegramAdapterConfig,
} from '../index';
import { loadTelegramSdk } from '../sdk';

// The adapter reads grammy through sdk.ts (loaded lazily in production).
beforeAll(async () => {
  await loadTelegramSdk();
});

const mk = (cfg: Omit<TelegramAdapterConfig, 'botKey'> & { botKey?: string }): TelegramAdapter =>
  new TelegramAdapter({ ...cfg, botKey: cfg.botKey ?? 'test-bot' });

let cache: InMemoryAttachmentCache;

function resetMocks() {
  cache = new InMemoryAttachmentCache();
  for (const key of Object.keys(mockApi) as (keyof typeof mockApi)[]) {
    mockApi[key].mockReset();
  }
  mockApi.setMyCommands.mockResolvedValue(true);
  mockApi.sendMessage.mockResolvedValue({ message_id: 42 });
  mockApi.editMessageText.mockResolvedValue(true);
  mockApi.getMe.mockResolvedValue({
    id: 1,
    is_bot: true,
    first_name: 'Bot',
    username: 'testbot',
  });
  for (const key of Object.keys(registeredHandlers)) {
    delete registeredHandlers[key];
  }
}

async function startAdapter(): Promise<TelegramAdapter> {
  const adapter = mk({ token: '1:fake-token', cache });
  await adapter.start();
  return adapter;
}

const card = (over: Partial<OutboxCardInput> = {}): OutboxCardInput => ({
  chatId: '77',
  itemId: 'obx_0123456789abcdef',
  revision: 2,
  personalityId: 'cmo',
  destination: { name: 'Ethos Announcements', platform: 'telegram', chatId: '-1001234567890' },
  sender: '@EthosMarketingBot',
  text: 'Ethos 0.9 ships today. Local models, one config file.',
  ...over,
});

// ---------------------------------------------------------------------------
// postOutboxCard
// ---------------------------------------------------------------------------

describe('O-T8 — postOutboxCard', () => {
  beforeEach(resetMocks);

  it('posts the header, the full text and obx: buttons', async () => {
    mockApi.sendMessage.mockResolvedValueOnce({ message_id: 100 });
    const adapter = await startAdapter();

    const result = await adapter.postOutboxCard(card());

    expect(result).toEqual({ messageId: '100', kind: 'card' });
    const [chatId, text, opts] = mockApi.sendMessage.mock.calls[0];
    expect(chatId).toBe(77);
    expect(text).toBe(
      'cmo wants to post to Ethos Announcements (telegram:-1001234567890) as @EthosMarketingBot — revision 2\n\nEthos 0.9 ships today. Local models, one config file.',
    );
    expect(opts.reply_markup.buttons).toEqual([
      { label: '✅ Approve & send', data: 'obx:a:obx_0123456789abcdef:2' },
      { label: '❌ Reject', data: 'obx:r:obx_0123456789abcdef:2' },
    ]);
    for (const btn of opts.reply_markup.buttons) {
      expect(Buffer.byteLength(btn.data, 'utf-8')).toBeLessThanOrEqual(64);
    }
  });

  it('renders the reviewer verdict when there is one', async () => {
    const adapter = await startAdapter();

    await adapter.postOutboxCard(
      card({
        review: {
          reviewer: 'brand-editor',
          verdict: 'FAIL',
          reasons: "'SOC2 certified' is not in truth-pack.md",
        },
      }),
    );

    const text = mockApi.sendMessage.mock.calls[0][1] as string;
    expect(text).toContain("brand-editor: FAIL — 'SOC2 certified' is not in truth-pack.md");
  });

  it('falls back to platform:chatId when the destination has no name', async () => {
    const adapter = await startAdapter();

    await adapter.postOutboxCard(
      card({ destination: { platform: 'telegram', chatId: '-1001234567890' } }),
    );

    const text = mockApi.sendMessage.mock.calls[0][1] as string;
    expect(
      text.startsWith('cmo wants to post to telegram:-1001234567890 as @EthosMarketingBot'),
    ).toBe(true);
  });

  it('posts the web-only notice instead of truncating when the card is over length', async () => {
    mockApi.sendMessage.mockResolvedValueOnce({ message_id: 101 });
    const adapter = await startAdapter();
    const long = 'A'.repeat(5000);

    const result = await adapter.postOutboxCard(card({ text: long }));

    expect(result).toEqual({ messageId: '101', kind: 'notice' });
    const [, text, opts] = mockApi.sendMessage.mock.calls[0];
    // Never truncated, never split: one message, and it does not carry the draft.
    expect(mockApi.sendMessage).toHaveBeenCalledTimes(1);
    expect(text).not.toContain('AAAA');
    expect(text).toBe(
      'cmo wants to post to Ethos Announcements (telegram:-1001234567890) as @EthosMarketingBot — revision 2\n\n5000 characters — too long to show in one Telegram message. Approve it in the web UI: Outbox → cmo. Ethos will not show you a partial draft to approve.',
    );
    // No buttons: an unseen draft cannot be approved from here.
    expect(opts.reply_markup).toBeUndefined();
  });

  it('includes threadId when provided', async () => {
    const adapter = await startAdapter();

    await adapter.postOutboxCard(card({ threadId: '99' }));

    const opts = mockApi.sendMessage.mock.calls[0][2] as Record<string, unknown>;
    expect(opts.message_thread_id).toBe(99);
  });

  it('returns an error when the send fails', async () => {
    mockApi.sendMessage.mockRejectedValueOnce(new Error('bot blocked'));
    const adapter = await startAdapter();

    const result = await adapter.postOutboxCard(card());

    expect(result).toEqual({ error: 'bot blocked' });
  });
});

// ---------------------------------------------------------------------------
// updateOutboxCard
// ---------------------------------------------------------------------------

describe('O-T8 — updateOutboxCard', () => {
  beforeEach(resetMocks);

  const settled = async (status: Parameters<TelegramAdapter['updateOutboxCard']>[0]['status']) => {
    const adapter = await startAdapter();
    const result = await adapter.updateOutboxCard({ chatId: '77', messageId: '100', status });
    expect(result.ok).toBe(true);
    return mockApi.editMessageText.mock.calls[0];
  };

  it('renders the approved text and drops the buttons', async () => {
    const [chatId, messageId, text, opts] = await settled({ kind: 'approved', by: 'mitesh' });
    expect(chatId).toBe(77);
    expect(messageId).toBe(100);
    expect(text).toBe('Approved by @mitesh — sending…');
    expect(opts).toEqual({ reply_markup: { inline_keyboard: [] } });
  });

  it('renders the sent text', async () => {
    const [, , text] = await settled({ kind: 'sent', at: '14:02' });
    expect(text).toBe('Sent 14:02');
  });

  it('renders the superseded text', async () => {
    const [, , text] = await settled({ kind: 'superseded', revision: 3 });
    expect(text).toBe('Superseded by revision 3');
  });

  it('renders the expired text', async () => {
    const [, , text] = await settled({ kind: 'expired' });
    expect(text).toBe('Expired');
  });

  it('renders the rejected text, with and without a reason', async () => {
    const [, , plain] = await settled({ kind: 'rejected', by: 'mitesh' });
    expect(plain).toBe('Rejected by @mitesh');

    mockApi.editMessageText.mockClear();
    const [, , withReason] = await settled({
      kind: 'rejected',
      by: 'mitesh',
      reason: 'wrong channel',
    });
    expect(withReason).toBe('Rejected by @mitesh — wrong channel');
  });

  it('prints a bare numeric user id without an @', async () => {
    const [, , text] = await settled({ kind: 'approved', by: '200' });
    expect(text).toBe('Approved by 200 — sending…');
  });

  // A delivery that fails has to reach the card. Without these two terms the
  // card sits on "Approved — sending…" forever, asserting an outcome that
  // never happened.
  it('renders a failure with the row’s own reason, verbatim', async () => {
    const [, , text] = await settled({
      kind: 'failed',
      reason: 'interrupted before the platform call; not sent — Retry',
    });
    expect(text).toBe('Failed — interrupted before the platform call; not sent — Retry');
  });

  it('says only that it failed when the row carries no reason', async () => {
    const [, , text] = await settled({ kind: 'failed' });
    expect(text).toBe('Failed — not sent.');
  });

  it('claims neither sent nor unsent when the platform did not confirm', async () => {
    const [, , text] = await settled({ kind: 'unconfirmed' });
    expect(text).toBe(
      'Unconfirmed — the platform did not confirm this send. The delivery ledger owns the ' +
        'retry from here; check the channel before sending it again.',
    );
    // The two claims it must not make.
    expect(text).not.toMatch(/\bSent\b/);
    expect(text).not.toMatch(/\bnot sent\b/);
    // And it names who owns the retry, so the operator does not press it too.
    expect(text).toContain('delivery ledger owns the retry');
  });
});

// ---------------------------------------------------------------------------
// A settled card is a RECORD, not a receipt
//
// The DM has to keep showing what was approved, not only that something was.
// The adapter stores nothing about a card it posted, so the body comes back in
// on the update call.
// ---------------------------------------------------------------------------

const HEADER =
  'cmo wants to post to Ethos Announcements (telegram:-1001234567890) as @EthosMarketingBot — revision 2';

const body = (over: Partial<OutboxCardBody> = {}): OutboxCardBody => ({
  revision: 2,
  personalityId: 'cmo',
  destination: { name: 'Ethos Announcements', platform: 'telegram', chatId: '-1001234567890' },
  sender: '@EthosMarketingBot',
  text: 'Ethos 0.9 ships today. Local models, one config file.',
  ...over,
});

describe('O-T8 — a settled card keeps the draft above the status line', () => {
  beforeEach(resetMocks);

  const edit = async (
    status: Parameters<TelegramAdapter['updateOutboxCard']>[0]['status'],
    card?: OutboxCardBody,
  ) => {
    const adapter = await startAdapter();
    const result = await adapter.updateOutboxCard({
      chatId: '77',
      messageId: '100',
      status,
      ...(card ? { card } : {}),
    });
    expect(result.ok).toBe(true);
    return mockApi.editMessageText.mock.calls[0][2] as string;
  };

  it('shows the header and the full draft above “Approved by … — sending…”', async () => {
    const text = await edit({ kind: 'approved', by: 'mitesh' }, body());
    expect(text).toBe(
      `${HEADER}\n\nEthos 0.9 ships today. Local models, one config file.\n\n` +
        'Approved by @mitesh — sending…',
    );
  });

  it('shows them again above “Sent 14:02”', async () => {
    const text = await edit({ kind: 'sent', at: '14:02' }, body());
    expect(text).toBe(
      `${HEADER}\n\nEthos 0.9 ships today. Local models, one config file.\n\nSent 14:02`,
    );
  });

  it('keeps the reviewer verdict the card was posted with', async () => {
    const text = await edit(
      { kind: 'rejected', by: 'mitesh', reason: 'wrong channel' },
      body({ review: { reviewer: 'brand-editor', verdict: 'FAIL', reasons: 'no SOC2 claim' } }),
    );
    expect(text).toContain('brand-editor: FAIL — no SOC2 claim');
    expect(text.endsWith('Rejected by @mitesh — wrong channel')).toBe(true);
  });

  it('drops the buttons, as it always did', async () => {
    const adapter = await startAdapter();
    await adapter.updateOutboxCard({
      chatId: '77',
      messageId: '100',
      status: { kind: 'sent', at: '14:02' },
      card: body(),
    });
    const opts = mockApi.editMessageText.mock.calls[0][3];
    expect(opts).toEqual({ reply_markup: { inline_keyboard: [] } });
  });

  it('is the status line alone when no body is supplied (an over-length notice)', async () => {
    expect(await edit({ kind: 'expired' })).toBe('Expired');
  });

  it('renders in full when header, draft and status land exactly on 4096', async () => {
    // 4 for the two blank-line separators.
    const draft = 'B'.repeat(4096 - HEADER.length - 4 - 'Expired'.length);
    const text = await edit({ kind: 'expired' }, body({ text: draft }));
    expect(text.length).toBe(4096);
    expect(text).toContain(draft);
  });

  it('falls back to the status line alone rather than failing the edit at 4097', async () => {
    const draft = 'B'.repeat(4096 - HEADER.length - 4 - 'Expired'.length + 1);
    const adapter = await startAdapter();

    const result = await adapter.updateOutboxCard({
      chatId: '77',
      messageId: '100',
      status: { kind: 'expired' },
      card: body({ text: draft }),
    });

    // The edit lands — a card stuck on "Approved — sending…" is worse than a
    // terse one — and the draft is never truncated to make it fit.
    expect(result.ok).toBe(true);
    const text = mockApi.editMessageText.mock.calls[0][2] as string;
    expect(text).toBe('Expired');
    expect(text).not.toContain('BBBB');
  });
});

// ---------------------------------------------------------------------------
// The sending bot's own handle
// ---------------------------------------------------------------------------

describe('O-T8 — senderHandle', () => {
  beforeEach(resetMocks);

  it('resolves the @handle from getMe at start and caches it for the adapter’s life', async () => {
    const adapter = await startAdapter();

    expect(adapter.senderHandle).toBe('@testbot');
    const calls = mockApi.getMe.mock.calls.length;
    expect(adapter.senderHandle).toBe('@testbot');
    expect(adapter.senderHandle).toBe('@testbot');
    expect(mockApi.getMe.mock.calls.length).toBe(calls);
  });

  it('starts normally when getMe fails, leaving the handle unresolved', async () => {
    mockApi.getMe.mockRejectedValue(new Error('401: Unauthorized'));
    const adapter = mk({ token: '1:fake-token', cache });

    await expect(adapter.start()).resolves.toBeUndefined();

    expect(adapter.senderHandle).toBeUndefined();
    // And a card still posts, under whatever name the wiring fell back to.
    const result = await adapter.postOutboxCard(card({ sender: 'marketing-bot' }));
    expect(result).toEqual({ messageId: '42', kind: 'card' });
    expect(mockApi.sendMessage.mock.calls[0][1]).toContain('as marketing-bot');
  });

  it('leaves the handle unset when getMe answers without a username', async () => {
    mockApi.getMe.mockResolvedValue({ id: 1, is_bot: true, first_name: 'Bot' });
    const adapter = await startAdapter();
    expect(adapter.senderHandle).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// obx: callback routing
// ---------------------------------------------------------------------------

function tap(data: string, from: { id: number; username?: string } = { id: 200 }) {
  const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
  registeredHandlers['callback_query:data']?.[0]({
    callbackQuery: {
      id: 'q1',
      data,
      message: { message_id: 55, chat: { id: 77 } },
      from,
    },
    answerCallbackQuery,
  });
  return answerCallbackQuery;
}

describe('O-T8 — obx: callback routing', () => {
  beforeEach(resetMocks);

  it('routes obx:a to the outbox handler with id, revision and the tapping user', async () => {
    const adapter = await startAdapter();
    const taps: OutboxDecisionEvent[] = [];
    adapter.onOutboxDecision((evt) => {
      taps.push(evt);
    });

    const answer = tap('obx:a:obx_0123456789abcdef:2', { id: 200, username: 'mitesh' });

    await vi.waitFor(() => expect(taps).toHaveLength(1));
    expect(taps[0]).toMatchObject({
      itemId: 'obx_0123456789abcdef',
      revision: 2,
      decision: 'approve',
      userId: '200',
      username: 'mitesh',
      chatId: '77',
      messageId: '55',
    });
    // The spinner stops even though the handler never answered.
    await vi.waitFor(() => expect(answer).toHaveBeenCalled());
  });

  it('routes obx:r to the outbox handler as a rejection', async () => {
    const adapter = await startAdapter();
    const taps: OutboxDecisionEvent[] = [];
    adapter.onOutboxDecision((evt) => {
      taps.push(evt);
    });

    tap('obx:r:obx_abc:7', { id: 201 });

    await vi.waitFor(() => expect(taps).toHaveLength(1));
    expect(taps[0].decision).toBe('reject');
    expect(taps[0].revision).toBe(7);
    expect(taps[0].userId).toBe('201');
    expect(taps[0].username).toBeUndefined();
  });

  it("lets the handler answer with its own text (e.g. the wiring's 'superseded')", async () => {
    const adapter = await startAdapter();
    adapter.onOutboxDecision(async (evt) => {
      await evt.answer('Superseded by revision 3.');
    });

    const answer = tap('obx:a:obx_abc:2');

    await vi.waitFor(() =>
      expect(answer).toHaveBeenCalledWith({ text: 'Superseded by revision 3.' }),
    );
    expect(answer).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed obx: payload without throwing and without calling the handler', async () => {
    const adapter = await startAdapter();
    const taps: OutboxDecisionEvent[] = [];
    adapter.onOutboxDecision((evt) => {
      taps.push(evt);
    });

    const malformed = [
      'obx:',
      'obx:a',
      'obx:a:obx_abc',
      'obx:x:obx_abc:2',
      'obx:a::2',
      'obx:a:obx_abc:',
      'obx:a:obx_abc:two',
      'obx:a:obx_abc:0',
      'obx:a:obx_abc:-1',
      'obx:a:obx_abc:2:extra',
    ];
    const answers = malformed.map((data) => tap(data));

    await new Promise((r) => setTimeout(r, 20));
    expect(taps).toHaveLength(0);
    for (const answer of answers) {
      expect(answer).toHaveBeenCalledWith({ text: 'Unrecognised button.' });
    }
  });

  it('answers when no outbox handler is registered', async () => {
    await startAdapter();

    const answer = tap('obx:a:obx_abc:2');

    await vi.waitFor(() =>
      expect(answer).toHaveBeenCalledWith({ text: 'No outbox handler registered.' }),
    );
  });

  it('still answers when the handler throws', async () => {
    const adapter = await startAdapter();
    adapter.onOutboxDecision(() => {
      throw new Error('store unavailable');
    });

    const answer = tap('obx:a:obx_abc:2');

    await vi.waitFor(() => expect(answer).toHaveBeenCalled());
  });

  it('leaves the approve:/deny: tool-approval route untouched (regression)', async () => {
    const adapter = await startAdapter();
    const decisions: ApprovalDecisionEvent[] = [];
    adapter.onApprovalDecision((evt) => decisions.push(evt));
    const taps: OutboxDecisionEvent[] = [];
    adapter.onOutboxDecision((evt) => {
      taps.push(evt);
    });

    tap('approve:app1', { id: 200, username: 'alice' });
    tap('deny:app2', { id: 201, username: 'bob' });

    await vi.waitFor(() => expect(decisions).toHaveLength(2));
    expect(decisions[0]).toMatchObject({
      approvalId: 'app1',
      decision: 'allow',
      decidedBy: 'alice',
      channelId: '77',
      messageTs: '55',
    });
    expect(decisions[1]).toMatchObject({ approvalId: 'app2', decision: 'deny', decidedBy: 'bob' });
    expect(taps).toHaveLength(0);
  });

  it('leaves the clr: clarify route untouched (regression)', async () => {
    const adapter = await startAdapter();
    type CbEvent = import('../index').CallbackQueryEvent;
    const clarifyEvents: CbEvent[] = [];
    adapter.onCallbackQuery((evt) => clarifyEvents.push(evt));
    const taps: OutboxDecisionEvent[] = [];
    adapter.onOutboxDecision((evt) => {
      taps.push(evt);
    });

    tap('clr:req1:0');

    await new Promise((r) => setTimeout(r, 20));
    expect(clarifyEvents).toHaveLength(1);
    expect(clarifyEvents[0].data).toBe('clr:req1:0');
    expect(taps).toHaveLength(0);
  });
});
