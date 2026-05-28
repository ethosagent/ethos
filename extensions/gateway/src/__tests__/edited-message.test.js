import { describe, expect, it, vi } from 'vitest';
import { Gateway } from '../index';
// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------
function stubAdapter(overrides = {}) {
    return {
        id: 'test',
        displayName: 'Test',
        capabilities: { platform: 'test' },
        canSendTyping: false,
        canEditMessage: false,
        canReact: false,
        canSendFiles: false,
        maxMessageLength: 4096,
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue({ ok: true, messageId: '1' }),
        onMessage: vi.fn(),
        health: vi.fn().mockResolvedValue({ ok: true }),
        ...overrides,
    };
}
function stubLoop(overrides = {}) {
    return {
        run: vi.fn(async function* () {
            yield { type: 'text_delta', text: 'reply' };
            yield { type: 'done', text: 'reply', turnCount: 1 };
        }),
        hooks: {
            registerVoid: vi.fn().mockReturnValue(() => { }),
        },
        ...overrides,
    };
}
function makeMessage(overrides = {}) {
    return {
        platform: 'telegram',
        chatId: '100',
        userId: '200',
        text: 'hello',
        isDm: true,
        isGroupMention: false,
        messageId: '1',
        botKey: 'test-bot',
        raw: {},
        ...overrides,
    };
}
// ---------------------------------------------------------------------------
// 3.3 — edited_message gateway handling
// ---------------------------------------------------------------------------
describe('Gateway — edited_message (isEdit) handling', () => {
    it('processes isEdit message through the lane like a normal message', async () => {
        const loop = stubLoop();
        const gw = new Gateway({
            bots: [
                {
                    botKey: 'test-bot',
                    loop: loop,
                    binding: { type: 'personality', name: 'default' },
                },
            ],
            clarifySweepIntervalMs: 0,
        });
        const adapter = stubAdapter();
        const msg = makeMessage({ text: 'corrected', isEdit: true, messageId: '5' });
        await gw.handleMessage(msg, adapter);
        // The loop should have been called with the edited text (wrapped as untrusted)
        expect(loop.run).toHaveBeenCalledTimes(1);
        expect(loop.run).toHaveBeenCalledWith(expect.stringContaining('<untrusted'), expect.objectContaining({ sessionKey: expect.any(String) }));
        expect(loop.run).toHaveBeenCalledWith(expect.stringContaining('corrected'), expect.anything());
    });
    it('does not deduplicate an isEdit message sharing the same messageId as a prior message', async () => {
        const loop = stubLoop();
        const gw = new Gateway({
            bots: [
                {
                    botKey: 'test-bot',
                    loop: loop,
                    binding: { type: 'personality', name: 'default' },
                },
            ],
            clarifySweepIntervalMs: 0,
        });
        const adapter = stubAdapter();
        // First: original message
        await gw.handleMessage(makeMessage({ text: 'original', messageId: '5' }), adapter);
        // Second: edited version with same messageId but isEdit: true
        await gw.handleMessage(makeMessage({ text: 'corrected', messageId: '5', isEdit: true }), adapter);
        // Both should have been processed
        expect(loop.run).toHaveBeenCalledTimes(2);
    });
});
