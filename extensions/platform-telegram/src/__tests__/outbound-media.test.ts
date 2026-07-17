import { InMemoryAttachmentCache } from '@ethosagent/storage-fs';
import type { Attachment } from '@ethosagent/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// grammy mock — includes sendPhoto / sendDocument and a capturing InputFile.
// ---------------------------------------------------------------------------

const mockApi = {
  setMyName: vi.fn().mockResolvedValue(true),
  setMyShortDescription: vi.fn().mockResolvedValue(true),
  setMyDescription: vi.fn().mockResolvedValue(true),
  setMyCommands: vi.fn().mockResolvedValue(true),
  setMessageReaction: vi.fn().mockResolvedValue(true),
  sendMessage: vi.fn().mockResolvedValue({ message_id: 10 }),
  sendPhoto: vi.fn().mockResolvedValue({ message_id: 20 }),
  sendDocument: vi.fn().mockResolvedValue({ message_id: 21 }),
  sendChatAction: vi.fn().mockResolvedValue(true),
};

/** Shape of the captured InputFile instances the mock produces. */
interface InputFileLike {
  data: unknown;
  filename?: string;
}

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

let cache: InMemoryAttachmentCache;
const mk = () => new TelegramAdapter({ token: '1:fake', cache, botKey: 'test-bot' });

beforeEach(() => {
  cache = new InMemoryAttachmentCache();
  for (const fn of Object.values(mockApi)) fn.mockClear();
});

const imageAtt = (url: string, filename = 'chart.png'): Attachment => ({
  type: 'image',
  ref: filename,
  url,
  mimeType: 'image/png',
  filename,
});
const fileAtt = (url: string, filename = 'notes.txt'): Attachment => ({
  type: 'file',
  ref: filename,
  url,
  mimeType: 'text/plain',
  filename,
});

describe('TelegramAdapter outbound media (W3.2)', () => {
  it('advertises file-sending capability', () => {
    const a = mk();
    expect(a.canSendFiles).toBe(true);
    expect(a.capabilities.outboundFiles).toBe(true);
  });

  it('sends an image via sendPhoto with the text as caption', async () => {
    const a = mk();
    const res = await a.send('123', { text: 'your chart', attachments: [imageAtt('/tmp/c.png')] });
    expect(res.ok).toBe(true);
    expect(mockApi.sendPhoto).toHaveBeenCalledTimes(1);
    const [chatId, input, opts] = mockApi.sendPhoto.mock.calls[0] as [
      number,
      InputFileLike,
      { caption?: string },
    ];
    expect(chatId).toBe(123);
    expect((input as InputFileLike).data).toBe('/tmp/c.png');
    expect(opts.caption).toBe('your chart');
  });

  it('sends a non-image via sendDocument', async () => {
    const a = mk();
    await a.send('123', { text: '', attachments: [fileAtt('/tmp/n.txt')] });
    expect(mockApi.sendDocument).toHaveBeenCalledTimes(1);
    expect(mockApi.sendPhoto).not.toHaveBeenCalled();
  });

  it('decodes a data: URI to bytes', async () => {
    const a = mk();
    const b64 = Buffer.from('PNGDATA').toString('base64');
    await a.send('123', { text: '', attachments: [imageAtt(`data:image/png;base64,${b64}`)] });
    const [, input] = mockApi.sendPhoto.mock.calls[0] as [number, InputFileLike];
    expect(Buffer.isBuffer((input as InputFileLike).data)).toBe(true);
    expect(Buffer.from((input as InputFileLike).data as Buffer).toString()).toBe('PNGDATA');
  });

  it('posts long text as a leading message before the attachment', async () => {
    const a = mk();
    const longText = 'x'.repeat(1100); // > 1024 caption limit
    await a.send('123', { text: longText, attachments: [imageAtt('/tmp/c.png')] });
    expect(mockApi.sendMessage).toHaveBeenCalledTimes(1); // the leading text
    expect(mockApi.sendPhoto).toHaveBeenCalledTimes(1);
    const [, , opts] = mockApi.sendPhoto.mock.calls[0] as [
      number,
      InputFileLike,
      { caption?: string },
    ];
    expect(opts.caption).toBeUndefined();
  });

  it('text-only sends still go through sendMessage (no media path)', async () => {
    const a = mk();
    await a.send('123', { text: 'plain reply' });
    expect(mockApi.sendMessage).toHaveBeenCalledTimes(1);
    expect(mockApi.sendPhoto).not.toHaveBeenCalled();
    expect(mockApi.sendDocument).not.toHaveBeenCalled();
  });
});
