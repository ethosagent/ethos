// V-CC-4 follow-up — the adapter classifies its own start failures. A token
// the Bot API refuses (401 Unauthorized, or 404 for a malformed one) is thrown
// from `start()` with `permanent: true`, so the gateway's adapter-start retry
// (`isPermanentAdapterStartError`, apps/ethos/src/commands/gateway.ts) stops
// instead of retrying a dead token for ever. A network failure on `getMe`
// stays non-fatal, and one on `setWebhook` is thrown unchanged (retryable).

import { InMemoryAttachmentCache } from '@ethosagent/storage-fs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockApi = {
  setMyName: vi.fn().mockResolvedValue(true),
  setMyShortDescription: vi.fn().mockResolvedValue(true),
  setMyDescription: vi.fn().mockResolvedValue(true),
  setMyCommands: vi.fn().mockResolvedValue(true),
  setWebhook: vi.fn().mockResolvedValue(true),
  getMe: vi.fn(),
};
const startCalls: unknown[] = [];
const onCalls: string[] = [];

vi.mock('grammy', () => {
  class MockBot {
    token = '1:fake-token';
    api = mockApi;
    on(filter: string) {
      onCalls.push(filter);
    }
    start(opts: unknown) {
      startCalls.push(opts);
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
  return { Bot: MockBot, InlineKeyboard: MockInlineKeyboard, webhookCallback: () => () => {} };
});

import { TelegramAdapter } from '../index';
import { loadTelegramSdk } from '../sdk';

beforeAll(async () => {
  await loadTelegramSdk();
});

/** grammy's `GrammyError` shape: `error_code` + `description`. */
function botApiError(code: number, description: string): Error {
  return Object.assign(new Error(`Call to 'getMe' failed! (${code}: ${description})`), {
    error_code: code,
    description,
  });
}

const BOT_INFO = { id: 1, is_bot: true, first_name: 'Bot', username: 'b' };

function adapter(webhook = false) {
  return new TelegramAdapter({
    token: '1:fake-token',
    cache: new InMemoryAttachmentCache(),
    botKey: 'test-bot',
    ...(webhook
      ? {
          useWebhook: true,
          webhookUrl: 'https://example.test/telegram/webhook/test-bot',
          webhookSecretToken: 'secret-token-value',
        }
      : {}),
  });
}

describe('TelegramAdapter.start — permanent start errors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    startCalls.length = 0;
    onCalls.length = 0;
    mockApi.setWebhook.mockResolvedValue(true);
  });

  for (const [code, description] of [
    [401, 'Unauthorized'],
    [404, 'Not Found'],
  ] as const) {
    it(`a getMe ${code} fails start with a permanent error and never polls`, async () => {
      const cause = botApiError(code, description);
      mockApi.getMe.mockRejectedValue(cause);
      const thrown = await adapter()
        .start()
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(thrown).toMatchObject({ permanent: true });
      expect((thrown as Error).cause).toBe(cause);
      expect(startCalls).toEqual([]);
    });
  }

  it('a getMe network failure is still not fatal', async () => {
    mockApi.getMe.mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.telegram.org'));
    await expect(adapter().start()).resolves.toBeUndefined();
    expect(startCalls).toHaveLength(1);
  });

  it('a setWebhook 401 fails start with a permanent error', async () => {
    mockApi.getMe.mockResolvedValue(BOT_INFO);
    mockApi.setWebhook.mockRejectedValue(botApiError(401, 'Unauthorized'));
    await expect(adapter(true).start()).rejects.toMatchObject({ permanent: true });
  });

  it('a setWebhook network failure is rethrown unchanged', async () => {
    mockApi.getMe.mockResolvedValue(BOT_INFO);
    const cause = new Error('socket hang up');
    mockApi.setWebhook.mockRejectedValue(cause);
    const thrown = await adapter(true)
      .start()
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(thrown).toBe(cause);
  });

  // V2-RT-1 — the gateway retries a transient start failure on the SAME
  // instance; the retried start must not stack a second copy of every handler.
  it('registers each update handler once across a retried start', async () => {
    mockApi.getMe.mockResolvedValue(BOT_INFO);
    mockApi.setWebhook.mockRejectedValueOnce(new Error('socket hang up')).mockResolvedValue(true);
    const a = adapter(true);
    await expect(a.start()).rejects.toThrow('socket hang up');
    await expect(a.start()).resolves.toBeUndefined();
    expect(mockApi.setWebhook).toHaveBeenCalledTimes(2);
    expect(onCalls.length).toBeGreaterThan(0);
    expect(new Set(onCalls).size).toBe(onCalls.length);
  });
});
