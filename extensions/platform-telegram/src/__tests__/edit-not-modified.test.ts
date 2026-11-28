import { InMemoryAttachmentCache } from '@ethosagent/storage-fs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// plan telegram-live-cards D14 — Telegram answers an edit whose content and
// markup are identical to what is on screen with 400 "message is not modified".
// The content IS on screen, so `editMessage` reports success. Otherwise the
// gateway's DraftStreamer.finalize leaves its delivery obligation `pending` and
// the sweep re-sends the answer as a second message.
//
// grammy mock mirrors outbox-card.test.ts.
// ---------------------------------------------------------------------------

const mockApi = {
  setMyCommands: vi.fn().mockResolvedValue(true),
  sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
  editMessageText: vi.fn().mockResolvedValue(true),
  deleteMessage: vi.fn().mockResolvedValue(true),
  getMe: vi.fn().mockResolvedValue({ id: 1, is_bot: true, first_name: 'Bot', username: 'testbot' }),
};

vi.mock('grammy', () => {
  class MockBot {
    token = '1:fake-token';
    api = mockApi;
    on() {}
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

import { isNotModifiedTelegramError, TelegramAdapter } from '../index';
import { loadTelegramSdk } from '../sdk';

beforeAll(async () => {
  await loadTelegramSdk();
});

const NOT_MODIFIED =
  "Call to 'editMessageText' failed! (400: Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message)";

function resetMocks() {
  for (const key of Object.keys(mockApi) as (keyof typeof mockApi)[]) mockApi[key].mockReset();
  mockApi.setMyCommands.mockResolvedValue(true);
  mockApi.sendMessage.mockResolvedValue({ message_id: 42 });
  mockApi.editMessageText.mockResolvedValue(true);
  mockApi.deleteMessage.mockResolvedValue(true);
  mockApi.getMe.mockResolvedValue({ id: 1, is_bot: true, first_name: 'Bot', username: 'testbot' });
}

async function startAdapter(): Promise<TelegramAdapter> {
  const adapter = new TelegramAdapter({
    token: '1:fake-token',
    botKey: 'test-bot',
    cache: new InMemoryAttachmentCache(),
  });
  await adapter.start();
  return adapter;
}

describe('isNotModifiedTelegramError', () => {
  it('matches the 400 not-modified error, as an Error or a string', () => {
    expect(isNotModifiedTelegramError(new Error(NOT_MODIFIED))).toBe(true);
    expect(isNotModifiedTelegramError(NOT_MODIFIED)).toBe(true);
  });

  it('does not match other failures', () => {
    expect(
      isNotModifiedTelegramError(new Error('400: Bad Request: message to edit not found')),
    ).toBe(false);
    expect(isNotModifiedTelegramError(new Error('429: Too Many Requests: retry after 3'))).toBe(
      false,
    );
    expect(isNotModifiedTelegramError(undefined)).toBe(false);
  });
});

describe('TelegramAdapter.editMessage — message is not modified (D14)', () => {
  beforeEach(resetMocks);

  it('reports ok:true with the message id when Telegram says not modified', async () => {
    mockApi.editMessageText.mockRejectedValueOnce(new Error(NOT_MODIFIED));
    const adapter = await startAdapter();

    const res = await adapter.editMessage('77', '500', 'same on screen', { final: true });

    expect(res).toEqual({ ok: true, messageId: '500' });
  });

  it('still reports a real edit failure as ok:false', async () => {
    mockApi.editMessageText.mockRejectedValueOnce(
      new Error('400: Bad Request: message to edit not found'),
    );
    const adapter = await startAdapter();

    const res = await adapter.editMessage('77', '500', 'x', { final: true });

    expect(res.ok).toBe(false);
    expect(res.error).toContain('message to edit not found');
  });

  it('keeps flood-wait errors visible so the streamer can back off', async () => {
    mockApi.editMessageText.mockRejectedValueOnce(
      new Error('429: Too Many Requests: retry after 3'),
    );
    const adapter = await startAdapter();

    const res = await adapter.editMessage('77', '500', 'x');

    expect(res.ok).toBe(false);
    expect(res.error).toContain('retry after 3');
  });

  it('a not-modified chunk does not abort the re-flow of a multi-chunk edit', async () => {
    const adapter = await startAdapter();
    const longText = `${'a'.repeat(4000)}\n\n${'b'.repeat(4000)}`;
    // Seed a two-chunk message so both chunks are edited in place.
    mockApi.sendMessage.mockResolvedValueOnce({ message_id: 10 }).mockResolvedValueOnce({
      message_id: 11,
    });
    await adapter.send('77', { text: longText });
    mockApi.editMessageText
      .mockRejectedValueOnce(new Error(NOT_MODIFIED))
      .mockResolvedValueOnce(true);

    const res = await adapter.editMessage('77', '10', longText, { final: true });

    expect(res).toEqual({ ok: true, messageId: '10' });
    expect(mockApi.editMessageText).toHaveBeenCalledTimes(2);
  });
});

describe('TelegramAdapter.updateApprovalCard — message is not modified (D14)', () => {
  beforeEach(resetMocks);

  it('reports ok:true when the entity-linked decision edit is already on screen', async () => {
    mockApi.editMessageText.mockRejectedValueOnce(new Error(NOT_MODIFIED));
    const adapter = await startAdapter();

    const res = await adapter.updateApprovalCard({
      chatId: '77',
      messageTs: '500',
      toolName: 'terminal',
      decision: 'allow',
      decidedBy: '200',
    });

    expect(res).toEqual({ ok: true, messageId: '500' });
  });
});
