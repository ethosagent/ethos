import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APPROVE_ACTION_ID, DENY_ACTION_ID } from '../blocks/approval';
// Mock @slack/bolt so the adapter can be exercised without a socket
// connection. The mock App records `chat.postMessage` / `chat.update` calls
// and lets the test fire registered `action` handlers — that's the whole
// surface the approval flow touches.
const postMessage = vi.fn();
const update = vi.fn();
const authTest = vi.fn().mockResolvedValue({ user_id: 'UBOT' });
const actionHandlers = new Map();
vi.mock('@slack/bolt', () => {
    class App {
        client = {
            chat: { postMessage, update },
            auth: { test: authTest },
        };
        async start() { }
        async stop() { }
        command() { }
        event() { }
        message() { }
        view() { }
        action(id, handler) {
            actionHandlers.set(id, handler);
        }
    }
    return { default: { App } };
});
const { SlackAdapter } = await import('../adapter');
function makeAdapter() {
    return new SlackAdapter({
        botToken: 'xoxb-fake',
        appToken: 'xapp-fake',
        signingSecret: 'sig-fake',
        botKey: 'bot-1',
    });
}
beforeEach(() => {
    postMessage.mockReset().mockResolvedValue({ ts: '1700000000.9' });
    update.mockReset().mockResolvedValue({ ok: true });
    actionHandlers.clear();
});
describe('SlackAdapter.postApprovalCard', () => {
    it('posts the pending card and returns its message ts', async () => {
        const adapter = makeAdapter();
        const result = await adapter.postApprovalCard({
            chatId: 'C1',
            threadId: '1700000000.1',
            approvalId: 'a1',
            toolName: 'terminal',
            reason: 'danger',
            args: { command: 'rm -rf /' },
        });
        expect(result).toEqual({ messageTs: '1700000000.9' });
        expect(postMessage).toHaveBeenCalledTimes(1);
        const call = postMessage.mock.calls[0][0];
        expect(call.channel).toBe('C1');
        expect(call.thread_ts).toBe('1700000000.1');
        expect(Array.isArray(call.blocks)).toBe(true);
    });
    it('returns an error result when Slack rejects the post', async () => {
        postMessage.mockRejectedValueOnce(new Error('channel_not_found'));
        const adapter = makeAdapter();
        const result = await adapter.postApprovalCard({
            chatId: 'C1',
            approvalId: 'a1',
            toolName: 'terminal',
            reason: null,
            args: {},
        });
        expect(result).toEqual({ error: 'channel_not_found' });
    });
});
describe('SlackAdapter.updateApprovalCard', () => {
    it('updates the card in place with the resolved blocks', async () => {
        const adapter = makeAdapter();
        const result = await adapter.updateApprovalCard({
            chatId: 'C1',
            messageTs: '1700000000.9',
            toolName: 'terminal',
            decision: 'allow',
            decidedBy: 'U1',
        });
        expect(result).toEqual({ ok: true });
        expect(update).toHaveBeenCalledTimes(1);
        const call = update.mock.calls[0][0];
        expect(call.channel).toBe('C1');
        expect(call.ts).toBe('1700000000.9');
        expect(Array.isArray(call.blocks)).toBe(true);
    });
    it('returns an error result when Slack rejects the update', async () => {
        update.mockRejectedValueOnce(new Error('message_not_found'));
        const adapter = makeAdapter();
        const result = await adapter.updateApprovalCard({
            chatId: 'C1',
            messageTs: '1700000000.9',
            toolName: 'terminal',
            decision: 'deny',
            decidedBy: 'U1',
        });
        expect(result).toEqual({ ok: false, error: 'message_not_found' });
    });
});
describe('SlackAdapter approval button interactions', () => {
    it('forwards an Allow click to the registered decision handler', async () => {
        const adapter = makeAdapter();
        const events = [];
        adapter.onApprovalDecision((e) => events.push(e));
        await adapter.start();
        const handler = actionHandlers.get(APPROVE_ACTION_ID);
        expect(handler).toBeDefined();
        await handler?.({
            ack: vi.fn().mockResolvedValue(undefined),
            body: {
                user: { id: 'U1' },
                channel: { id: 'C1' },
                message: { ts: '1700000000.9' },
            },
            action: { action_id: APPROVE_ACTION_ID, value: 'a1' },
        });
        expect(events).toEqual([
            {
                approvalId: 'a1',
                decision: 'allow',
                decidedBy: 'U1',
                channelId: 'C1',
                messageTs: '1700000000.9',
            },
        ]);
    });
    it('does not throw on a malformed interaction payload', async () => {
        const adapter = makeAdapter();
        const events = [];
        adapter.onApprovalDecision((e) => events.push(e));
        await adapter.start();
        const handler = actionHandlers.get(APPROVE_ACTION_ID);
        // Bolt API drift / a bad payload: `body` and `action` missing entirely.
        await expect(handler?.({ ack: vi.fn().mockResolvedValue(undefined) })).resolves.toBeUndefined();
        expect(events).toHaveLength(0);
    });
    it('forwards a Deny click as a deny decision', async () => {
        const adapter = makeAdapter();
        const events = [];
        adapter.onApprovalDecision((e) => events.push(e));
        await adapter.start();
        const ack = vi.fn().mockResolvedValue(undefined);
        await actionHandlers.get(DENY_ACTION_ID)?.({
            ack,
            body: {
                user: { id: 'U2' },
                channel: { id: 'C1' },
                message: { ts: '1700000000.9' },
            },
            action: { action_id: DENY_ACTION_ID, value: 'a1' },
        });
        expect(ack).toHaveBeenCalled();
        expect(events[0]?.decision).toBe('deny');
        expect(events[0]?.decidedBy).toBe('U2');
    });
});
