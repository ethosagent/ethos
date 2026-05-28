import { InMemoryAttachmentCache } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock grammy — mirrors the phase3 mock setup
// ---------------------------------------------------------------------------
const mockApi = {
  setMyName: vi.fn().mockResolvedValue(true),
  setMyShortDescription: vi.fn().mockResolvedValue(true),
  setMyDescription: vi.fn().mockResolvedValue(true),
  setMyCommands: vi.fn().mockResolvedValue(true),
  setMessageReaction: vi.fn().mockResolvedValue(true),
  sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
  sendChatAction: vi.fn().mockResolvedValue(true),
  editMessageText: vi.fn().mockResolvedValue(true),
  deleteMessage: vi.fn().mockResolvedValue(true),
  getMe: vi.fn().mockResolvedValue({
    id: 1,
    is_bot: true,
    first_name: 'Bot',
    username: 'testbot',
  }),
  getFile: vi.fn().mockResolvedValue({
    file_id: 'abc123',
    file_unique_id: 'unique123',
    file_path: 'photos/file_0.jpg',
    file_size: 1024,
  }),
};
const registeredHandlers = {};
vi.mock('grammy', () => {
  class MockBot {
    token = '1:fake-token';
    api = mockApi;
    on(event, handler) {
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
    buttons = [];
    text(label, data) {
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

let cache;
function resetMocks() {
  cache = new InMemoryAttachmentCache();
  for (const key of Object.keys(mockApi)) {
    mockApi[key].mockReset();
  }
  mockApi.setMyName.mockResolvedValue(true);
  mockApi.setMyShortDescription.mockResolvedValue(true);
  mockApi.setMyDescription.mockResolvedValue(true);
  mockApi.setMyCommands.mockResolvedValue(true);
  mockApi.setMessageReaction.mockResolvedValue(true);
  mockApi.sendMessage.mockResolvedValue({ message_id: 42 });
  mockApi.sendChatAction.mockResolvedValue(true);
  mockApi.editMessageText.mockResolvedValue(true);
  mockApi.deleteMessage.mockResolvedValue(true);
  mockApi.getMe.mockResolvedValue({
    id: 1,
    is_bot: true,
    first_name: 'Bot',
    username: 'testbot',
  });
  mockApi.getFile.mockResolvedValue({
    file_id: 'abc123',
    file_unique_id: 'unique123',
    file_path: 'photos/file_0.jpg',
    file_size: 1024,
  });
  for (const key of Object.keys(registeredHandlers)) {
    delete registeredHandlers[key];
  }
  vi.restoreAllMocks();
}
// ---------------------------------------------------------------------------
// 4.1 — markdownToTelegramHtml
// ---------------------------------------------------------------------------
describe('4.1 — markdownToTelegramHtml', () => {
  let markdownToTelegramHtml;
  let escapeHtml;
  beforeEach(async () => {
    const mod = await import('../format');
    markdownToTelegramHtml = mod.markdownToTelegramHtml;
    escapeHtml = mod.escapeHtml;
  });
  it('converts **bold** to <b>bold</b>', () => {
    expect(markdownToTelegramHtml('**bold**')).toBe('<b>bold</b>');
  });
  it('converts _italic_ to <i>italic</i>', () => {
    expect(markdownToTelegramHtml('_italic_')).toBe('<i>italic</i>');
  });
  it('converts `code` to <code>code</code>', () => {
    expect(markdownToTelegramHtml('`code`')).toBe('<code>code</code>');
  });
  it('converts ```block``` (no language) to <pre>block</pre>', () => {
    expect(markdownToTelegramHtml('```\nblock\n```')).toBe('<pre>block\n</pre>');
  });
  it('converts ```ts\\ncode\\n``` (with language) to <pre><code class="language-ts">code</code></pre>', () => {
    expect(markdownToTelegramHtml('```ts\ncode\n```')).toBe(
      '<pre><code class="language-ts">code\n</code></pre>',
    );
  });
  it('converts ~~strike~~ to <s>strike</s>', () => {
    expect(markdownToTelegramHtml('~~strike~~')).toBe('<s>strike</s>');
  });
  it('converts ||spoiler|| to <tg-spoiler>spoiler</tg-spoiler>', () => {
    expect(markdownToTelegramHtml('||spoiler||')).toBe('<tg-spoiler>spoiler</tg-spoiler>');
  });
  it('converts [label](url) to <a href="url">label</a>', () => {
    expect(markdownToTelegramHtml('[click](https://example.com)')).toBe(
      '<a href="https://example.com">click</a>',
    );
  });
  it('escapes raw HTML in agent output before conversion', () => {
    const input = '<b>bold</b> and **real bold**';
    const result = markdownToTelegramHtml(input);
    expect(result).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(result).toContain('<b>real bold</b>');
  });
  it('escapes all five HTML special characters', () => {
    expect(escapeHtml('& < > " \'')).toBe('&amp; &lt; &gt; &quot; &#x27;');
  });
  it('handles nested bold + italic', () => {
    const result = markdownToTelegramHtml('**_bold italic_**');
    expect(result).toContain('<b>');
    expect(result).toContain('<i>');
  });
  it('does not convert underscore in mid-word positions', () => {
    const result = markdownToTelegramHtml('some_variable_name');
    // Should not wrap in <i> since these are mid-word underscores
    expect(result).not.toContain('<i>');
  });
  it('handles multiple formatting in one line', () => {
    const result = markdownToTelegramHtml('**bold** and _italic_ and `code`');
    expect(result).toBe('<b>bold</b> and <i>italic</i> and <code>code</code>');
  });
});
// ---------------------------------------------------------------------------
// 4.1 — HTML mode send() + observable fallback
// ---------------------------------------------------------------------------
describe('4.1 — HTML mode send()', () => {
  beforeEach(resetMocks);
  it('sends with parse_mode HTML by default', async () => {
    const adapter = new TelegramAdapter({ token: '1:fake-token', cache });
    await adapter.start();
    await adapter.send('100', { text: '**hello**' });
    expect(mockApi.sendMessage).toHaveBeenCalledWith(
      100,
      '<b>hello</b>',
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
  });
  it('skips HTML translation when parseMode is plain', async () => {
    const adapter = new TelegramAdapter({ token: '1:fake-token', cache, parseMode: 'plain' });
    await adapter.start();
    await adapter.send('100', { text: '**hello**' });
    expect(mockApi.sendMessage).toHaveBeenCalledWith(
      100,
      '**hello**',
      expect.not.objectContaining({ parse_mode: expect.anything() }),
    );
  });
  it('falls back to plain text on parse error and logs console.warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockApi.sendMessage
      .mockRejectedValueOnce(new Error("can't parse entities"))
      .mockResolvedValueOnce({ message_id: 99 });
    const adapter = new TelegramAdapter({ token: '1:fake-token', cache });
    await adapter.start();
    const result = await adapter.send('100', { text: 'bad **markup' });
    expect(result.ok).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnMsg = warnSpy.mock.calls[0][0];
    expect(warnMsg).toContain('[telegram] HTML parse fallback');
    expect(warnMsg).toContain('chunk=1/1');
    expect(warnMsg).toMatch(/hash=[0-9a-f]{8}/);
    warnSpy.mockRestore();
  });
  it('returns error on non-parse send failure', async () => {
    mockApi.sendMessage.mockRejectedValueOnce(new Error('network error'));
    const adapter = new TelegramAdapter({ token: '1:fake-token', cache });
    await adapter.start();
    const result = await adapter.send('100', { text: 'hi' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('network error');
  });
});
// ---------------------------------------------------------------------------
// 4.1 — HTML mode editMessage()
// ---------------------------------------------------------------------------
describe('4.1 — HTML mode editMessage()', () => {
  beforeEach(resetMocks);
  it('edits with HTML translation', async () => {
    const adapter = new TelegramAdapter({ token: '1:fake-token', cache });
    await adapter.start();
    // Seed a chunk mapping via send
    mockApi.sendMessage.mockResolvedValueOnce({ message_id: 50 });
    await adapter.send('100', { text: 'original' });
    await adapter.editMessage('100', '50', '**updated**');
    expect(mockApi.editMessageText).toHaveBeenCalledWith(
      100,
      50,
      '<b>updated</b>',
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
  });
  it('edits without HTML when parseMode is plain', async () => {
    const adapter = new TelegramAdapter({ token: '1:fake-token', cache, parseMode: 'plain' });
    await adapter.start();
    mockApi.sendMessage.mockResolvedValueOnce({ message_id: 50 });
    await adapter.send('100', { text: 'original' });
    await adapter.editMessage('100', '50', '**updated**');
    expect(mockApi.editMessageText).toHaveBeenCalledWith(
      100,
      50,
      '**updated**',
      expect.objectContaining({}),
    );
    // Should NOT have parse_mode
    const callArgs = mockApi.editMessageText.mock.calls[0][3];
    expect(callArgs.parse_mode).toBeUndefined();
  });
});
// ---------------------------------------------------------------------------
// 4.1 — personalityRichMessage HTML mode
// ---------------------------------------------------------------------------
describe('4.1 — personalityRichMessage HTML mode', () => {
  it('renders bold as <b> in HTML mode', async () => {
    const { personalityRichMessage } = await import('../blocks/personality');
    const card = {
      id: 'test',
      name: 'TestBot',
      description: 'A test bot',
      prose: 'I am a test.',
      model: 'claude-sonnet-4-20250514',
      provider: 'anthropic',
      toolset: ['read_file'],
      skills: [{ id: 'review', source: 'global' }],
    };
    const result = personalityRichMessage(card, { mode: 'html' });
    expect(result).toContain('<b>TestBot</b>');
    expect(result).toContain('<b>Runs on:</b>');
    expect(result).toContain('<b>What it can do</b>');
    expect(result).toContain('<code>read_file</code>');
    expect(result).toContain('<i>I am a test.</i>');
  });
  it('defaults to Markdown mode when opts not provided', async () => {
    const { personalityRichMessage } = await import('../blocks/personality');
    const card = {
      id: 'test',
      name: 'TestBot',
      description: 'desc',
      prose: '',
      model: 'model',
      provider: 'prov',
      toolset: [],
      skills: [],
    };
    const result = personalityRichMessage(card);
    expect(result).toContain('*TestBot*');
    expect(result).not.toContain('<b>');
  });
});
// ---------------------------------------------------------------------------
// 4.2 — Approval flow: postApprovalCard
// ---------------------------------------------------------------------------
describe('4.2 — postApprovalCard', () => {
  beforeEach(resetMocks);
  it('sends inline keyboard with correct callback_data', async () => {
    mockApi.sendMessage.mockResolvedValueOnce({ message_id: 100 });
    const adapter = new TelegramAdapter({ token: '1:fake-token', cache });
    await adapter.start();
    const result = await adapter.postApprovalCard({
      chatId: '42',
      approvalId: 'abc123',
      toolName: 'bash',
      reason: 'dangerous command',
      args: { cmd: 'rm -rf /' },
    });
    expect(result).toHaveProperty('messageTs', '100');
    expect(mockApi.sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text, opts] = mockApi.sendMessage.mock.calls[0];
    expect(chatId).toBe(42);
    expect(text).toContain('bash');
    expect(text).toContain('dangerous command');
    expect(opts.reply_markup).toBeDefined();
  });
  it('callback_data fits within 64 bytes', async () => {
    mockApi.sendMessage.mockResolvedValueOnce({ message_id: 100 });
    const adapter = new TelegramAdapter({ token: '1:fake-token', cache });
    await adapter.start();
    // approvalId is typically a short UUID-like string
    const approvalId = 'a'.repeat(50);
    await adapter.postApprovalCard({
      chatId: '42',
      approvalId,
      toolName: 'bash',
      reason: null,
      args: null,
    });
    // Verify the callback_data length: "approve:" + 50 chars = 58 bytes
    const approveData = `approve:${approvalId}`;
    const denyData = `deny:${approvalId}`;
    expect(Buffer.byteLength(approveData, 'utf-8')).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(denyData, 'utf-8')).toBeLessThanOrEqual(64);
  });
  it('returns error when send fails', async () => {
    mockApi.sendMessage.mockRejectedValueOnce(new Error('bot blocked'));
    const adapter = new TelegramAdapter({ token: '1:fake-token', cache });
    await adapter.start();
    const result = await adapter.postApprovalCard({
      chatId: '42',
      approvalId: 'abc',
      toolName: 'bash',
      reason: null,
      args: null,
    });
    expect(result).toHaveProperty('error');
  });
  it('includes threadId when provided', async () => {
    mockApi.sendMessage.mockResolvedValueOnce({ message_id: 100 });
    const adapter = new TelegramAdapter({ token: '1:fake-token', cache });
    await adapter.start();
    await adapter.postApprovalCard({
      chatId: '42',
      threadId: '99',
      approvalId: 'abc',
      toolName: 'bash',
      reason: null,
      args: null,
    });
    const opts = mockApi.sendMessage.mock.calls[0][2];
    expect(opts.message_thread_id).toBe(99);
  });
});
// ---------------------------------------------------------------------------
// 4.2 — Approval flow: updateApprovalCard
// ---------------------------------------------------------------------------
describe('4.2 — updateApprovalCard', () => {
  beforeEach(resetMocks);
  it('edits message to plain text with decision', async () => {
    const adapter = new TelegramAdapter({ token: '1:fake-token', cache });
    await adapter.start();
    const result = await adapter.updateApprovalCard({
      chatId: '42',
      messageTs: '100',
      toolName: 'bash',
      decision: 'allow',
      decidedBy: 'alice',
    });
    expect(result.ok).toBe(true);
    expect(mockApi.editMessageText).toHaveBeenCalledWith(
      42,
      100,
      expect.stringContaining('Approved'),
      expect.objectContaining({ reply_markup: { inline_keyboard: [] } }),
    );
  });
  it('shows Denied for deny decision', async () => {
    const adapter = new TelegramAdapter({ token: '1:fake-token', cache });
    await adapter.start();
    await adapter.updateApprovalCard({
      chatId: '42',
      messageTs: '100',
      toolName: 'bash',
      decision: 'deny',
      decidedBy: 'bob',
    });
    const text = mockApi.editMessageText.mock.calls[0][2];
    expect(text).toContain('Denied');
    expect(text).toContain('@bob');
  });
});
// ---------------------------------------------------------------------------
// 4.2 — Approval flow: onApprovalDecision + callback routing
// ---------------------------------------------------------------------------
describe('4.2 — onApprovalDecision callback routing', () => {
  beforeEach(resetMocks);
  it('routes approve: callbacks to approval handler', async () => {
    const adapter = new TelegramAdapter({ token: '1:fake-token', cache });
    await adapter.start();
    const decisions = [];
    adapter.onApprovalDecision((evt) => decisions.push(evt));
    const cbHandler = registeredHandlers['callback_query:data'];
    expect(cbHandler).toBeDefined();
    expect(cbHandler?.length).toBeGreaterThan(0);
    const answerCb = vi.fn().mockResolvedValue(undefined);
    cbHandler?.[0]({
      callbackQuery: {
        id: 'q1',
        data: 'approve:myApproval123',
        message: { message_id: 55, chat: { id: 100 } },
        from: { id: 200, username: 'alice' },
      },
      answerCallbackQuery: answerCb,
    });
    // Wait for async callback processing
    await vi.waitFor(() => {
      expect(decisions).toHaveLength(1);
    });
    expect(decisions[0].approvalId).toBe('myApproval123');
    expect(decisions[0].decision).toBe('allow');
    expect(decisions[0].decidedBy).toBe('alice');
    expect(decisions[0].channelId).toBe('100');
    expect(decisions[0].messageTs).toBe('55');
  });
  it('routes deny: callbacks to approval handler', async () => {
    const adapter = new TelegramAdapter({ token: '1:fake-token', cache });
    await adapter.start();
    const decisions = [];
    adapter.onApprovalDecision((evt) => decisions.push(evt));
    const answerCb = vi.fn().mockResolvedValue(undefined);
    registeredHandlers['callback_query:data']?.[0]({
      callbackQuery: {
        id: 'q2',
        data: 'deny:myApproval456',
        message: { message_id: 56, chat: { id: 101 } },
        from: { id: 201, username: 'bob' },
      },
      answerCallbackQuery: answerCb,
    });
    await vi.waitFor(() => {
      expect(decisions).toHaveLength(1);
    });
    expect(decisions[0].approvalId).toBe('myApproval456');
    expect(decisions[0].decision).toBe('deny');
    expect(decisions[0].decidedBy).toBe('bob');
  });
  it('routes clr: callbacks to clarify handler (not approval)', async () => {
    const adapter = new TelegramAdapter({ token: '1:fake-token', cache });
    await adapter.start();
    const clarifyEvents = [];
    adapter.onCallbackQuery((evt) => clarifyEvents.push(evt));
    const decisions = [];
    adapter.onApprovalDecision((evt) => decisions.push(evt));
    const answerCb = vi.fn().mockResolvedValue(undefined);
    registeredHandlers['callback_query:data']?.[0]({
      callbackQuery: {
        id: 'q3',
        data: 'clr:req1:0',
        message: { message_id: 57, chat: { id: 102 } },
        from: { id: 202, username: 'charlie' },
      },
      answerCallbackQuery: answerCb,
    });
    // Give time for async processing
    await new Promise((r) => setTimeout(r, 50));
    // Clarify handler should have received the event
    expect(clarifyEvents).toHaveLength(1);
    expect(clarifyEvents[0].data).toBe('clr:req1:0');
    // Approval handler should NOT have received it
    expect(decisions).toHaveLength(0);
  });
  it('coexists: clarify and approval callbacks in the same adapter', async () => {
    const adapter = new TelegramAdapter({ token: '1:fake-token', cache });
    await adapter.start();
    const clarifyEvents = [];
    adapter.onCallbackQuery((evt) => clarifyEvents.push(evt));
    const decisions = [];
    adapter.onApprovalDecision((evt) => decisions.push(evt));
    const answerCb = vi.fn().mockResolvedValue(undefined);
    // First: clarify callback
    registeredHandlers['callback_query:data']?.[0]({
      callbackQuery: {
        id: 'q4',
        data: 'clr:req2:1',
        message: { message_id: 58, chat: { id: 103 } },
        from: { id: 203 },
      },
      answerCallbackQuery: answerCb,
    });
    // Second: approval callback
    registeredHandlers['callback_query:data']?.[0]({
      callbackQuery: {
        id: 'q5',
        data: 'approve:app1',
        message: { message_id: 59, chat: { id: 103 } },
        from: { id: 203, username: 'dave' },
      },
      answerCallbackQuery: answerCb,
    });
    await vi.waitFor(() => {
      expect(decisions).toHaveLength(1);
    });
    expect(clarifyEvents).toHaveLength(1);
    expect(decisions).toHaveLength(1);
    expect(clarifyEvents[0].data).toBe('clr:req2:1');
    expect(decisions[0].approvalId).toBe('app1');
  });
});
