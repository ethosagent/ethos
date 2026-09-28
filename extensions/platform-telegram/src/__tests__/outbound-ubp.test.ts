// Telegram adapter fixes from plan/phases/upstream-bug-parity.md, driven
// against a mocked grammy client:
//   UBP-017 — typing for a forum-topic turn carries message_thread_id.
//   UBP-050 — the approval card redacts credentials and fits the 4096 limit.

import { InMemoryAttachmentCache } from '@ethosagent/storage-fs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockApi = {
  setMyName: vi.fn().mockResolvedValue(true),
  setMyShortDescription: vi.fn().mockResolvedValue(true),
  setMyDescription: vi.fn().mockResolvedValue(true),
  setMyCommands: vi.fn().mockResolvedValue(true),
  setMessageReaction: vi.fn().mockResolvedValue(true),
  getMe: vi.fn().mockResolvedValue({ id: 1, is_bot: true, first_name: 'Bot', username: 'testbot' }),
  sendChatAction: vi.fn().mockResolvedValue(true),
  sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
  editMessageText: vi.fn().mockResolvedValue(true),
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

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockClear();
});

function makeAdapter() {
  return new TelegramAdapter({
    token: '1:fake-token',
    cache: new InMemoryAttachmentCache(),
    botKey: 'test-bot',
  });
}

describe('UBP-017 sendTyping into a forum topic', () => {
  it('passes message_thread_id when a threadId is given', async () => {
    await makeAdapter().sendTyping('100', { threadId: '55' });
    expect(mockApi.sendChatAction).toHaveBeenCalledWith(100, 'typing', {
      message_thread_id: 55,
    });
  });

  it('sends a plain chat action without one', async () => {
    await makeAdapter().sendTyping('100');
    expect(mockApi.sendChatAction).toHaveBeenCalledWith(100, 'typing', {});
  });

  it('an edit that re-flows into an extra chunk posts it into the same topic', async () => {
    const result = await makeAdapter().editMessage('100', '7', 'word '.repeat(1000), {
      threadId: '55',
    });
    expect(result.ok).toBe(true);
    expect(mockApi.editMessageText).toHaveBeenCalledTimes(1);
    expect(mockApi.sendMessage).toHaveBeenCalledWith(
      100,
      expect.any(String),
      expect.objectContaining({ message_thread_id: 55 }),
    );
  });
});

describe('UBP-050 approval card args', () => {
  const post = (args: unknown) =>
    makeAdapter().postApprovalCard({
      chatId: '100',
      approvalId: 'a1',
      toolName: 'terminal',
      reason: 'runs a shell command',
      args,
    });
  const postedText = () => String(mockApi.sendMessage.mock.calls[0]?.[1] ?? '');

  it('fits 10 KB of args under Telegram’s 4096-char limit with a truncation marker', async () => {
    const result = await post({ command: `cat <<'EOF'\n${'x'.repeat(10_000)}\nEOF` });
    expect(result).toEqual({ messageTs: '42' });
    const text = postedText();
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toContain('(truncated)');
    expect(text).toContain('Tool approval required: terminal');
  });

  it('redacts a credential in the args', async () => {
    const token = `sk-ant-api03-${'A'.repeat(95)}`;
    await post({ command: `curl -H 'x-api-key: ${token}' https://api.example.com` });
    const text = postedText();
    expect(text).not.toContain(token);
    expect(text).toContain('curl');
  });

  it('keeps a very long reason inside the limit too', async () => {
    await makeAdapter().postApprovalCard({
      chatId: '100',
      approvalId: 'a1',
      toolName: 'terminal',
      reason: 'r'.repeat(5000),
      args: { command: 'ls' },
    });
    expect(postedText().length).toBeLessThanOrEqual(4096);
  });
});
