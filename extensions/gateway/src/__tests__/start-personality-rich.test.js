import { DefaultHookRegistry } from '@ethosagent/core';
import { describe, expect, it, vi } from 'vitest';
import { Gateway } from '../index';
// Minimal fake loop — yields done immediately.
function makeFakeLoop() {
    const hooks = new DefaultHookRegistry();
    return {
        hooks,
        async *run() {
            yield { type: 'done', text: '', turnCount: 1 };
        },
    };
}
function makeFakeAdapter(id = 'telegram:bot-1') {
    const sentMessages = [];
    return {
        id,
        displayName: 'Telegram',
        capabilities: { platform: 'test' },
        canSendTyping: false,
        canEditMessage: true,
        canReact: true,
        canSendFiles: false,
        maxMessageLength: 4096,
        async start() { },
        async stop() { },
        async send(_chatId, msg) {
            sentMessages.push(msg.text);
            return { ok: true, messageId: 'm1' };
        },
        onMessage() { },
        async health() {
            return { ok: true };
        },
        sentMessages,
    };
}
function inbound(text, overrides = {}) {
    return {
        platform: 'telegram',
        botKey: 'bot-1',
        chatId: 'C123',
        userId: 'U1',
        text,
        isDm: true,
        isGroupMention: false,
        messageId: `msg-${Date.now()}`,
        raw: null,
        ...overrides,
    };
}
// ---------------------------------------------------------------------------
// /start greeting
// ---------------------------------------------------------------------------
describe('/start greeting', () => {
    it('returns personality-aware greeting when greetingProvider is set', async () => {
        const loop = makeFakeLoop();
        const adapter = makeFakeAdapter();
        const gateway = new Gateway({
            bots: [{ botKey: 'bot-1', loop, binding: { type: 'personality', name: 'researcher' } }],
            greetingProvider: {
                async greet(personalityId) {
                    return `Hello from ${personalityId}! Use /help for commands.`;
                },
            },
        });
        await gateway.handleMessage(inbound('/start'), adapter);
        expect(adapter.sentMessages).toHaveLength(1);
        expect(adapter.sentMessages[0]).toContain('Hello from researcher');
        expect(adapter.sentMessages[0]).toContain('/help');
    });
    it('returns generic greeting when no greetingProvider is set', async () => {
        const loop = makeFakeLoop();
        const adapter = makeFakeAdapter();
        const gateway = new Gateway({
            bots: [{ botKey: 'bot-1', loop, binding: { type: 'personality', name: 'researcher' } }],
        });
        await gateway.handleMessage(inbound('/start'), adapter);
        expect(adapter.sentMessages).toHaveLength(1);
        expect(adapter.sentMessages[0]).toContain('researcher');
        expect(adapter.sentMessages[0]).toContain('/help');
    });
});
// ---------------------------------------------------------------------------
// /personality rich
// ---------------------------------------------------------------------------
describe('/personality rich', () => {
    it('renders the character sheet when personalityCardReader is set', async () => {
        const loop = makeFakeLoop();
        const adapter = makeFakeAdapter();
        const gateway = new Gateway({
            bots: [{ botKey: 'bot-1', loop, binding: { type: 'personality', name: 'researcher' } }],
            personalityCardReader: {
                async read(personalityId) {
                    return { text: `*${personalityId}* character sheet` };
                },
            },
        });
        await gateway.handleMessage(inbound('/personality rich'), adapter);
        expect(adapter.sentMessages).toHaveLength(1);
        expect(adapter.sentMessages[0]).toContain('*researcher* character sheet');
    });
    it('falls through when no personalityCardReader is set', async () => {
        const loop = makeFakeLoop();
        const adapter = makeFakeAdapter();
        const gateway = new Gateway({
            bots: [
                {
                    botKey: 'bot-1',
                    loop,
                    binding: { type: 'personality', name: 'researcher', allowSlashSwitch: true },
                },
            ],
        });
        await gateway.handleMessage(inbound('/personality rich'), adapter);
        // Without a card reader, 'rich' is treated as a personality switch
        expect(adapter.sentMessages).toHaveLength(1);
        expect(adapter.sentMessages[0]).toContain('Switched to rich');
    });
    it('does not render card for team bindings', async () => {
        const loop = makeFakeLoop();
        const adapter = makeFakeAdapter();
        const reader = vi.fn().mockResolvedValue({ text: 'card text' });
        const gateway = new Gateway({
            bots: [{ botKey: 'bot-1', loop, binding: { type: 'team', name: 'my-team' } }],
            personalityCardReader: { read: reader },
        });
        await gateway.handleMessage(inbound('/personality rich'), adapter);
        // Team binding doesn't call card reader; returns the identity-bound rejection
        expect(reader).not.toHaveBeenCalled();
        expect(adapter.sentMessages).toHaveLength(1);
        expect(adapter.sentMessages[0]).toContain('bound to team');
    });
});
