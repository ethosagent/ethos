import { InMemoryAttachmentCache } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// ---------------------------------------------------------------------------
// Mock grammy — we need to intercept all Bot API calls without making
// network requests. The real Bot constructor validates tokens and fires
// getMe on start(); the mock lets us exercise start()/send() paths.
// ---------------------------------------------------------------------------
const mockApi = {
    setMyName: vi.fn().mockResolvedValue(true),
    setMyShortDescription: vi.fn().mockResolvedValue(true),
    setMyDescription: vi.fn().mockResolvedValue(true),
    setMyCommands: vi.fn().mockResolvedValue(true),
    setMessageReaction: vi.fn().mockResolvedValue(true),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
    sendChatAction: vi.fn().mockResolvedValue(true),
    getMe: vi.fn().mockResolvedValue({ id: 1, is_bot: true, first_name: 'Bot', username: 'testbot' }),
};
// Capture registered handlers so tests can simulate inbound messages.
const registeredHandlers = {};
vi.mock('grammy', () => {
    class MockBot {
        api = mockApi;
        on(event, handler) {
            if (!registeredHandlers[event])
                registeredHandlers[event] = [];
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
let cache;
function resetMocks() {
    cache = new InMemoryAttachmentCache();
    for (const key of Object.keys(mockApi)) {
        mockApi[key].mockClear();
    }
    for (const key of Object.keys(registeredHandlers)) {
        delete registeredHandlers[key];
    }
}
// ---------------------------------------------------------------------------
// 1.1 — Bot identity from the personality
// ---------------------------------------------------------------------------
describe('Bot identity (setMyName / setMyShortDescription / setMyDescription)', () => {
    beforeEach(resetMocks);
    it('calls setMyName, setMyShortDescription, setMyDescription at start() when identity is set', async () => {
        const adapter = new TelegramAdapter({
            token: '1:fake',
            cache,
            identity: {
                name: 'Researcher',
                shortDescription: 'A helpful research assistant',
                description: 'I help you find and synthesize information from the web.',
            },
        });
        await adapter.start();
        expect(mockApi.setMyName).toHaveBeenCalledWith('Researcher');
        expect(mockApi.setMyShortDescription).toHaveBeenCalledWith('A helpful research assistant');
        expect(mockApi.setMyDescription).toHaveBeenCalledWith('I help you find and synthesize information from the web.');
    });
    it('truncates name to 64 chars with ellipsis', async () => {
        const longName = 'A'.repeat(100);
        const adapter = new TelegramAdapter({
            token: '1:fake',
            cache,
            identity: {
                name: longName,
                shortDescription: 'short',
                description: 'desc',
            },
        });
        await adapter.start();
        const calledWith = mockApi.setMyName.mock.calls[0][0];
        expect(calledWith.length).toBe(64);
        expect(calledWith.endsWith('…')).toBe(true);
    });
    it('truncates shortDescription to 120 chars with ellipsis', async () => {
        const longDesc = 'B'.repeat(200);
        const adapter = new TelegramAdapter({
            token: '1:fake',
            cache,
            identity: {
                name: 'Bot',
                shortDescription: longDesc,
                description: 'desc',
            },
        });
        await adapter.start();
        const calledWith = mockApi.setMyShortDescription.mock.calls[0][0];
        expect(calledWith.length).toBe(120);
        expect(calledWith.endsWith('…')).toBe(true);
    });
    it('truncates description to 512 chars with ellipsis', async () => {
        const longDesc = 'C'.repeat(600);
        const adapter = new TelegramAdapter({
            token: '1:fake',
            cache,
            identity: {
                name: 'Bot',
                shortDescription: 'short',
                description: longDesc,
            },
        });
        await adapter.start();
        const calledWith = mockApi.setMyDescription.mock.calls[0][0];
        expect(calledWith.length).toBe(512);
        expect(calledWith.endsWith('…')).toBe(true);
    });
    it('does not call identity APIs when identity is not set', async () => {
        const adapter = new TelegramAdapter({ token: '1:fake', cache });
        await adapter.start();
        expect(mockApi.setMyName).not.toHaveBeenCalled();
        expect(mockApi.setMyShortDescription).not.toHaveBeenCalled();
        expect(mockApi.setMyDescription).not.toHaveBeenCalled();
    });
    it('swallows failures from identity API calls (best-effort)', async () => {
        mockApi.setMyName.mockRejectedValueOnce(new Error('forbidden'));
        mockApi.setMyShortDescription.mockRejectedValueOnce(new Error('forbidden'));
        mockApi.setMyDescription.mockRejectedValueOnce(new Error('forbidden'));
        const adapter = new TelegramAdapter({
            token: '1:fake',
            cache,
            identity: {
                name: 'Bot',
                shortDescription: 'short',
                description: 'desc',
            },
        });
        // Should not throw
        await expect(adapter.start()).resolves.toBeUndefined();
    });
});
// ---------------------------------------------------------------------------
// 1.2 — Commands menu (setMyCommands)
// ---------------------------------------------------------------------------
describe('Commands menu (setMyCommands)', () => {
    beforeEach(resetMocks);
    it('registers 6 slash commands at start()', async () => {
        const adapter = new TelegramAdapter({ token: '1:fake', cache });
        await adapter.start();
        expect(mockApi.setMyCommands).toHaveBeenCalledTimes(1);
        const commands = mockApi.setMyCommands.mock.calls[0][0];
        expect(commands).toHaveLength(6);
        const names = commands.map((c) => c.command);
        expect(names).toContain('start');
        expect(names).toContain('new');
        expect(names).toContain('help');
        expect(names).toContain('personality');
        expect(names).toContain('usage');
        expect(names).toContain('stop');
    });
    it('swallows setMyCommands failures (best-effort)', async () => {
        mockApi.setMyCommands.mockRejectedValueOnce(new Error('forbidden'));
        const adapter = new TelegramAdapter({ token: '1:fake', cache });
        await expect(adapter.start()).resolves.toBeUndefined();
    });
});
// ---------------------------------------------------------------------------
// 1.3 — Reaction on receipt
// ---------------------------------------------------------------------------
describe('Reaction on receipt', () => {
    beforeEach(resetMocks);
    it('sets canReact = true', () => {
        const adapter = new TelegramAdapter({ token: '1:fake', cache });
        expect(adapter.canReact).toBe(true);
    });
    it('reacts with eyes emoji on inbound message', async () => {
        const adapter = new TelegramAdapter({ token: '1:fake', cache });
        await adapter.start();
        // Simulate an inbound message
        let capturedMessage = null;
        adapter.onMessage((msg) => {
            capturedMessage = msg;
        });
        const messageHandler = registeredHandlers.message?.[0];
        expect(messageHandler).toBeDefined();
        messageHandler?.({
            chat: { id: 123, type: 'private' },
            from: { id: 456, username: 'user1' },
            message: { text: 'hello', message_id: 789, reply_to_message: null },
            me: { username: 'testbot' },
        });
        expect(mockApi.setMessageReaction).toHaveBeenCalledWith(123, 789, [
            { type: 'emoji', emoji: '👀' },
        ]);
        expect(capturedMessage).not.toBeNull();
    });
    it('clears the reaction on send() for the tracked chatId', async () => {
        const adapter = new TelegramAdapter({ token: '1:fake', cache });
        await adapter.start();
        adapter.onMessage(() => { });
        // Simulate inbound
        const messageHandler = registeredHandlers.message?.[0];
        messageHandler?.({
            chat: { id: 123, type: 'private' },
            from: { id: 456 },
            message: { text: 'hello', message_id: 789, reply_to_message: null },
            me: { username: 'testbot' },
        });
        mockApi.setMessageReaction.mockClear();
        // Send a reply — should clear the reaction
        await adapter.send('123', { text: 'response' });
        expect(mockApi.setMessageReaction).toHaveBeenCalledWith(123, 789, []);
    });
    it('uses custom receiptReaction when configured', async () => {
        const adapter = new TelegramAdapter({
            token: '1:fake',
            cache,
            receiptReaction: '✅',
        });
        await adapter.start();
        adapter.onMessage(() => { });
        const messageHandler = registeredHandlers.message?.[0];
        messageHandler?.({
            chat: { id: 123, type: 'private' },
            from: { id: 456 },
            message: { text: 'hello', message_id: 789, reply_to_message: null },
            me: { username: 'testbot' },
        });
        expect(mockApi.setMessageReaction).toHaveBeenCalledWith(123, 789, [
            { type: 'emoji', emoji: '✅' },
        ]);
    });
    it('swallows reaction failures', async () => {
        mockApi.setMessageReaction.mockRejectedValue(new Error('no rights'));
        const adapter = new TelegramAdapter({ token: '1:fake', cache });
        await adapter.start();
        adapter.onMessage(() => { });
        const messageHandler = registeredHandlers.message?.[0];
        // Should not throw
        messageHandler?.({
            chat: { id: 123, type: 'private' },
            from: { id: 456 },
            message: { text: 'hello', message_id: 789, reply_to_message: null },
            me: { username: 'testbot' },
        });
    });
});
// ---------------------------------------------------------------------------
// 1.5 — personalityRichMessage (Telegram character sheet card)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// README — no stale source-line references
// ---------------------------------------------------------------------------
describe('README', () => {
    it('does not contain stale src/index.ts:NNN line references', async () => {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const readmePath = path.join(import.meta.dirname, '..', '..', 'README.md');
        const content = await fs.readFile(readmePath, 'utf-8');
        // Match patterns like `src/index.ts:42` or `src/index.ts:78`
        const matches = content.match(/src\/index\.ts:\d+/g);
        expect(matches).toBeNull();
    });
});
// ---------------------------------------------------------------------------
// 1.5 — personalityRichMessage (Telegram character sheet card)
// ---------------------------------------------------------------------------
describe('personalityRichMessage', () => {
    it('renders a character sheet with bold section headers', async () => {
        // This test imports a module that doesn't exist yet — will fail at RED phase
        const { personalityRichMessage } = await import('../blocks/personality');
        const card = {
            id: 'researcher',
            name: 'Researcher',
            description: 'A research personality',
            prose: 'I am a meticulous researcher who dives deep into topics.',
            model: 'claude-sonnet-4-20250514',
            provider: 'anthropic',
            toolset: ['read_file', 'web_search', 'bash'],
            skills: [
                { id: 'code-review', source: 'personality' },
                { id: 'debugging', source: 'global' },
            ],
        };
        const result = personalityRichMessage(card);
        expect(typeof result).toBe('string');
        // Section headers should be bold (Markdown *...*)
        expect(result).toContain('*Researcher*');
        expect(result).toContain('*What it can do*');
        expect(result).toContain('*What it knows*');
        // Tools rendered
        expect(result).toContain('read_file');
        expect(result).toContain('web_search');
        expect(result).toContain('bash');
        // Skills rendered
        expect(result).toContain('code-review');
        expect(result).toContain('debugging');
        // Description
        expect(result).toContain('A research personality');
    });
    it('stays under 4096 chars', async () => {
        const { personalityRichMessage } = await import('../blocks/personality');
        const card = {
            id: 'big',
            name: 'Big Bot',
            description: 'D'.repeat(500),
            prose: 'P'.repeat(500),
            model: 'claude-sonnet-4-20250514',
            provider: 'anthropic',
            toolset: Array.from({ length: 200 }, (_, i) => `tool_${i}`),
            skills: Array.from({ length: 100 }, (_, i) => ({
                id: `skill_${i}`,
                source: 'global',
            })),
        };
        const result = personalityRichMessage(card);
        expect(result.length).toBeLessThanOrEqual(4096);
    });
    it('omits fs_reach, MCP servers, and plugins (same redactions as Slack)', async () => {
        const { personalityRichMessage } = await import('../blocks/personality');
        const card = {
            id: 'test',
            name: 'Test',
            description: 'desc',
            prose: '',
            model: 'model',
            provider: 'prov',
            toolset: ['read_file'],
            skills: [],
        };
        const result = personalityRichMessage(card);
        expect(result).not.toContain('fs_reach');
        expect(result).not.toContain('MCP');
        expect(result).not.toContain('plugin');
    });
});
