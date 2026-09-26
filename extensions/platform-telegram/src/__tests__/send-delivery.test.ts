import { InMemoryAttachmentCache } from '@ethosagent/storage-fs';
import type { Attachment } from '@ethosagent/types';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// What `send()` reports is the gateway delivery ledger's only evidence. A
// `{ ok: false }` after text already reached the chat makes the ledger's sweep
// post that text again; a refusal no retry can fix must say so
// (`DeliveryResult.permanent`) so the sweep stops at once.

const mockApi = {
  setMessageReaction: vi.fn().mockResolvedValue(true),
  sendMessage: vi.fn(),
  sendPhoto: vi.fn(),
  sendDocument: vi.fn(),
  sendVoice: vi.fn(),
  sendChatAction: vi.fn().mockResolvedValue(true),
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
  class MockInputFile {
    constructor(
      public data: unknown,
      public filename?: string,
    ) {}
  }
  return { Bot: MockBot, InlineKeyboard: MockInlineKeyboard, InputFile: MockInputFile };
});

import { TelegramAdapter } from '../index';
import { loadTelegramSdk } from '../sdk';

beforeAll(async () => {
  await loadTelegramSdk();
});

const mk = () =>
  new TelegramAdapter({ token: '1:fake', cache: new InMemoryAttachmentCache(), botKey: 'b' });

/** The shape grammy's `GrammyError` carries (error_code + description). */
function apiError(code: number, description: string): Error {
  return Object.assign(new Error(`Call to 'sendMessage' failed! (${code}: ${description})`), {
    error_code: code,
    description,
  });
}

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
  mockApi.setMessageReaction.mockResolvedValue(true);
  mockApi.sendMessage.mockResolvedValue({ message_id: 1 });
});

const LONG = `${'a'.repeat(4090)} ${'b'.repeat(4090)} ${'c'.repeat(100)}`;

describe('TelegramAdapter.send — partial delivery', () => {
  it('a later chunk failing after the first landed is reported delivered, not retryable', async () => {
    mockApi.sendMessage
      .mockResolvedValueOnce({ message_id: 11 })
      .mockRejectedValueOnce(apiError(500, 'Internal Server Error'));
    const res = await mk().send('100', { text: LONG });
    expect(mockApi.sendMessage).toHaveBeenCalledTimes(2);
    expect(res.ok).toBe(true);
    expect(res.messageId).toBe('11');
    expect(res.error).toMatch(/partial: 1 of 3 chunks/);
  });

  it('a chunk whose plain-text parse fallback also fails is a missing chunk, not success', async () => {
    const parseErr = apiError(400, "Bad Request: can't parse entities: unclosed tag");
    // Only chunk: HTML refused, plain-text fallback refused → nothing landed.
    mockApi.sendMessage
      .mockRejectedValueOnce(parseErr)
      .mockRejectedValueOnce(apiError(502, 'Bad Gateway'));
    const none = await mk().send('100', { text: 'hi' });
    expect(none.ok).toBe(false);
    expect(none.permanent).toBeUndefined();
    expect(none.error).toContain('Bad Gateway');

    // Fallback refused permanently → the failure carries it.
    mockApi.sendMessage
      .mockRejectedValueOnce(parseErr)
      .mockRejectedValueOnce(apiError(403, 'Forbidden: bot was blocked by the user'));
    expect(await mk().send('100', { text: 'hi' })).toMatchObject({ ok: false, permanent: true });

    // First chunk landed, second's fallback refused → partial, never full success.
    mockApi.sendMessage
      .mockResolvedValueOnce({ message_id: 21 })
      .mockRejectedValueOnce(parseErr)
      .mockRejectedValueOnce(apiError(502, 'Bad Gateway'));
    const partial = await mk().send('100', { text: LONG });
    expect(partial.ok).toBe(true);
    expect(partial.messageId).toBe('21');
    expect(partial.error).toMatch(/partial: 1 of 3 chunks/);
  });

  it('the first chunk failing is still a plain, retryable failure', async () => {
    mockApi.sendMessage.mockRejectedValueOnce(apiError(429, 'Too Many Requests: retry after 5'));
    const res = await mk().send('100', { text: 'hi' });
    expect(res.ok).toBe(false);
    expect(res.permanent).toBeUndefined();
  });

  it('an attachment failing after the lead text landed is reported delivered', async () => {
    const att: Attachment = {
      type: 'image',
      ref: 'x.png',
      url: 'data:image/png;base64,AAAA',
      mimeType: 'image/png',
      filename: 'x.png',
    };
    mockApi.sendMessage.mockResolvedValueOnce({ message_id: 7 });
    mockApi.sendPhoto.mockRejectedValueOnce(apiError(500, 'Internal Server Error'));
    const res = await mk().send('100', { text: 'z'.repeat(2000), attachments: [att] });
    expect(res.ok).toBe(true);
    expect(res.messageId).toBe('7');
    expect(res.error).toMatch(/partial/);
  });
});

describe('TelegramAdapter.send — permanent refusals', () => {
  it.each([
    [403, 'Forbidden: bot was blocked by the user'],
    [403, 'Forbidden: bot was kicked from the supergroup chat'],
    [403, 'Forbidden: user is deactivated'],
    [403, "Forbidden: bot can't initiate conversation with a user"],
    [400, 'Bad Request: chat not found'],
    [400, 'Bad Request: not enough rights to send text messages to the chat'],
    [400, 'Bad Request: CHAT_WRITE_FORBIDDEN'],
  ])('%i %s is permanent', async (code, description) => {
    mockApi.sendMessage.mockRejectedValueOnce(apiError(code, description));
    const res = await mk().send('100', { text: 'hi' });
    expect(res).toMatchObject({ ok: false, permanent: true });
    expect(res.error).toContain(description);
  });

  it('other 400s, 429 and 5xx are not permanent', async () => {
    for (const [code, d] of [
      [400, 'Bad Request: message is too long'],
      [429, 'Too Many Requests: retry after 5'],
      [502, 'Bad Gateway'],
    ] as const) {
      mockApi.sendMessage.mockRejectedValueOnce(apiError(code, d));
      const res = await mk().send('100', { text: 'hi' });
      expect(res.ok).toBe(false);
      expect(res.permanent).toBeUndefined();
    }
  });

  it('a voice note to a blocked chat is permanent', async () => {
    mockApi.sendVoice.mockRejectedValueOnce(
      apiError(403, 'Forbidden: bot was blocked by the user'),
    );
    const res = await mk().sendVoiceNote('100', new Uint8Array([1]), {
      format: 'ogg',
      mimeType: 'audio/ogg',
      filename: 'v.ogg',
    });
    expect(res).toMatchObject({ ok: false, permanent: true });
  });
});
