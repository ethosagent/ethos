// Plan channel-prompts §3.8, D10 — `selfIdentity()` is the one `getMe` the
// adapter already makes at `start()`; undefined until it resolves.

import { InMemoryAttachmentCache } from '@ethosagent/storage-fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const mockApi = {
  setMyName: vi.fn().mockResolvedValue(true),
  setMyShortDescription: vi.fn().mockResolvedValue(true),
  setMyDescription: vi.fn().mockResolvedValue(true),
  setMyCommands: vi.fn().mockResolvedValue(true),
  getMe: vi
    .fn()
    .mockResolvedValue({ id: 4242, is_bot: true, first_name: 'Bot', username: 'testbot' }),
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

import { TelegramAdapter } from '../index';
import { loadTelegramSdk } from '../sdk';

beforeAll(async () => {
  await loadTelegramSdk();
});

describe('TelegramAdapter.selfIdentity', () => {
  it('is undefined before start and the getMe username and id after', async () => {
    const adapter = new TelegramAdapter({
      token: '1:fake-token',
      cache: new InMemoryAttachmentCache(),
      botKey: 'test-bot',
    });
    expect(adapter.selfIdentity()).toBeUndefined();
    await adapter.start();
    expect(adapter.selfIdentity()).toEqual({ handle: 'testbot', platformUserId: '4242' });
  });

  it('stays undefined when getMe failed', async () => {
    mockApi.getMe.mockRejectedValueOnce(new Error('network'));
    const adapter = new TelegramAdapter({
      token: '1:fake-token',
      cache: new InMemoryAttachmentCache(),
      botKey: 'test-bot',
    });
    await adapter.start();
    expect(adapter.selfIdentity()).toBeUndefined();
  });
});
