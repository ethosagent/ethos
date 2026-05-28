import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { EmailAdapter } from '../index';
const BASE_CONFIG = {
    imapHost: 'imap.example.com',
    imapPort: 993,
    user: 'agent@example.com',
    password: 'secret',
    smtpHost: 'smtp.example.com',
    smtpPort: 587,
};
// ---------------------------------------------------------------------------
// Helpers — IMAP + SMTP mocks
// ---------------------------------------------------------------------------
function makeImapMock(messages = []) {
    return {
        connect: vi.fn().mockResolvedValue(undefined),
        logout: vi.fn().mockResolvedValue(undefined),
        search: vi.fn().mockResolvedValue(messages.map((m) => m.uid)),
        getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
        fetch: vi.fn().mockImplementation(async function* () {
            for (const m of messages)
                yield { uid: m.uid, source: m.raw };
        }),
        messageFlagsAdd: vi.fn().mockResolvedValue(undefined),
    };
}
function makeTransportMock(messageId = '<reply-001@example.com>') {
    return {
        sendMail: vi.fn().mockResolvedValue({ messageId }),
    };
}
// Build a minimal raw RFC 2822 email
function buildRawEmail(opts) {
    const lines = [
        `From: ${opts.fromName ? `"${opts.fromName}" <${opts.from}>` : opts.from}`,
        `To: agent@example.com`,
        `Subject: ${opts.subject}`,
        ...(opts.messageId ? [`Message-ID: ${opts.messageId}`] : []),
        `MIME-Version: 1.0`,
        `Content-Type: text/plain; charset=utf-8`,
        ``,
        opts.text,
    ];
    return Buffer.from(lines.join('\r\n'), 'utf-8');
}
// ---------------------------------------------------------------------------
// ChatId / slugification
// ---------------------------------------------------------------------------
describe('EmailAdapter chatId', () => {
    it('generates chatId from sender and subject', async () => {
        const received = [];
        const raw = buildRawEmail({
            from: 'alice@example.com',
            subject: 'Fix the auth bug',
            text: 'Please fix it',
        });
        const imap = makeImapMock([{ uid: 1, raw }]);
        const adapter = new EmailAdapter(BASE_CONFIG, {
            createImapClient: () => imap,
            createTransporter: () => makeTransportMock(),
        });
        adapter.onMessage((msg) => received.push(msg.chatId));
        await adapter.poll();
        expect(received[0]).toBe('alice@example.com:fix-the-auth-bug');
    });
    it('strips Re: prefix from subject slug', async () => {
        const received = [];
        const raw = buildRawEmail({
            from: 'bob@example.com',
            subject: 'Re: Fix the auth bug',
            text: 'Done!',
        });
        const imap = makeImapMock([{ uid: 1, raw }]);
        const adapter = new EmailAdapter(BASE_CONFIG, {
            createImapClient: () => imap,
            createTransporter: () => makeTransportMock(),
        });
        adapter.onMessage((msg) => received.push(msg.chatId));
        await adapter.poll();
        expect(received[0]).toBe('bob@example.com:fix-the-auth-bug');
    });
});
// ---------------------------------------------------------------------------
// Poll — inbound message
// ---------------------------------------------------------------------------
describe('EmailAdapter.poll', () => {
    it('emits InboundMessage for each unseen email', async () => {
        const messages = [
            {
                uid: 1,
                raw: buildRawEmail({
                    from: 'alice@example.com',
                    subject: 'Task A',
                    text: 'Do task A',
                    messageId: '<a@mail>',
                }),
            },
            {
                uid: 2,
                raw: buildRawEmail({ from: 'bob@example.com', subject: 'Task B', text: 'Do task B' }),
            },
        ];
        const imap = makeImapMock(messages);
        const adapter = new EmailAdapter(BASE_CONFIG, {
            createImapClient: () => imap,
            createTransporter: () => makeTransportMock(),
        });
        const received = [];
        adapter.onMessage((msg) => received.push(msg.text));
        await adapter.poll();
        expect(received).toHaveLength(2);
        expect(received).toContain('Do task A');
        expect(received).toContain('Do task B');
    });
    it('marks each fetched message as seen', async () => {
        const raw = buildRawEmail({ from: 'a@b.com', subject: 'Hi', text: 'Hello' });
        const imap = makeImapMock([{ uid: 5, raw }]);
        const adapter = new EmailAdapter(BASE_CONFIG, {
            createImapClient: () => imap,
            createTransporter: () => makeTransportMock(),
        });
        adapter.onMessage(() => { });
        await adapter.poll();
        expect(imap.messageFlagsAdd).toHaveBeenCalledWith([5], ['\\Seen'], { uid: true });
    });
    it('skips messages with no body text', async () => {
        const raw = buildRawEmail({ from: 'a@b.com', subject: 'Empty', text: '' });
        const imap = makeImapMock([{ uid: 1, raw }]);
        const adapter = new EmailAdapter(BASE_CONFIG, {
            createImapClient: () => imap,
            createTransporter: () => makeTransportMock(),
        });
        const received = [];
        adapter.onMessage((msg) => received.push(msg.chatId));
        await adapter.poll();
        expect(received).toHaveLength(0);
    });
    it('does nothing when no messageHandler is registered', async () => {
        const imap = makeImapMock();
        const adapter = new EmailAdapter(BASE_CONFIG, {
            createImapClient: () => imap,
            createTransporter: () => makeTransportMock(),
        });
        await adapter.poll(); // should not throw
        expect(imap.connect).not.toHaveBeenCalled();
    });
});
// ---------------------------------------------------------------------------
// Send — SMTP reply
// ---------------------------------------------------------------------------
describe('EmailAdapter.send', () => {
    async function preparedAdapter() {
        const raw = buildRawEmail({
            from: 'alice@example.com',
            fromName: 'Alice',
            subject: 'Do the thing',
            text: 'Please do it',
            messageId: '<orig-001@mail>',
        });
        const imap = makeImapMock([{ uid: 1, raw }]);
        const transport = makeTransportMock();
        const adapter = new EmailAdapter(BASE_CONFIG, {
            createImapClient: () => imap,
            createTransporter: () => transport,
        });
        adapter.onMessage(() => { });
        await adapter.poll();
        return { adapter, transport, chatId: 'alice@example.com:do-the-thing' };
    }
    it('sends reply to original sender', async () => {
        const { adapter, transport, chatId } = await preparedAdapter();
        const result = await adapter.send(chatId, { text: 'Done!' });
        expect(result.ok).toBe(true);
        expect(transport.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'alice@example.com', html: '<p>Done!</p>' }));
    });
    it('sets In-Reply-To header for email threading', async () => {
        const { adapter, transport, chatId } = await preparedAdapter();
        await adapter.send(chatId, { text: 'Done!' });
        expect(transport.sendMail).toHaveBeenCalledWith(expect.objectContaining({ inReplyTo: '<orig-001@mail>' }));
    });
    it('prefixes subject with Re:', async () => {
        const { adapter, transport, chatId } = await preparedAdapter();
        await adapter.send(chatId, { text: 'Done!' });
        expect(transport.sendMail).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Re: Do the thing' }));
    });
    it('returns error if no thread state exists', async () => {
        const adapter = new EmailAdapter(BASE_CONFIG, {
            createImapClient: () => makeImapMock(),
            createTransporter: () => makeTransportMock(),
        });
        const result = await adapter.send('unknown@example.com:slug', { text: 'hi' });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/No thread state/);
    });
});
// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
describe('EmailAdapter lifecycle', () => {
    it('stop() clears the poll timer', async () => {
        const imap = makeImapMock();
        const adapter = new EmailAdapter({ ...BASE_CONFIG, pollIntervalMs: 999_999 }, {
            createImapClient: () => imap,
            createTransporter: () => makeTransportMock(),
        });
        adapter.onMessage(() => { });
        await adapter.start();
        await adapter.stop();
        // If timer was cleared, no further polls should fire after stop
        // (tested implicitly — the test completes without hanging)
        expect(imap.connect).toHaveBeenCalledTimes(1); // only the initial poll
    });
});
// ---------------------------------------------------------------------------
// botKey — multi-bot routing identity
// ---------------------------------------------------------------------------
describe('EmailAdapter botKey', () => {
    it('derives botKey from IMAP credentials when not configured', () => {
        const adapter = new EmailAdapter(BASE_CONFIG, {
            createImapClient: () => makeImapMock(),
            createTransporter: () => makeTransportMock(),
        });
        const expected = createHash('sha256')
            .update(`${BASE_CONFIG.user}@${BASE_CONFIG.imapHost}`)
            .digest('hex')
            .slice(0, 24);
        expect(adapter.botKey).toBe(expected);
    });
    it('uses explicit botKey from config when provided', () => {
        const adapter = new EmailAdapter({ ...BASE_CONFIG, botKey: 'my-email-bot' }, {
            createImapClient: () => makeImapMock(),
            createTransporter: () => makeTransportMock(),
        });
        expect(adapter.botKey).toBe('my-email-bot');
    });
    it('derivation is stable — same credentials produce same botKey', () => {
        const a = new EmailAdapter(BASE_CONFIG, {
            createImapClient: () => makeImapMock(),
            createTransporter: () => makeTransportMock(),
        });
        const b = new EmailAdapter(BASE_CONFIG, {
            createImapClient: () => makeImapMock(),
            createTransporter: () => makeTransportMock(),
        });
        expect(a.botKey).toBe(b.botKey);
    });
    it('sets botKey on every emitted InboundMessage', async () => {
        const raw = buildRawEmail({
            from: 'alice@example.com',
            subject: 'Test',
            text: 'Hello',
            messageId: '<msg-001@mail>',
        });
        const imap = makeImapMock([{ uid: 1, raw }]);
        const adapter = new EmailAdapter(BASE_CONFIG, {
            createImapClient: () => imap,
            createTransporter: () => makeTransportMock(),
        });
        const received = [];
        adapter.onMessage((msg) => received.push(msg));
        await adapter.poll();
        expect(received).toHaveLength(1);
        expect(received[0].botKey).toBe(adapter.botKey);
    });
});
// ---------------------------------------------------------------------------
// messageId — inbound dedup identity
// ---------------------------------------------------------------------------
describe('EmailAdapter messageId', () => {
    it('uses Message-ID header as messageId', async () => {
        const raw = buildRawEmail({
            from: 'alice@example.com',
            subject: 'Dedup test',
            text: 'Content',
            messageId: '<unique-123@example.com>',
        });
        const imap = makeImapMock([{ uid: 7, raw }]);
        const adapter = new EmailAdapter(BASE_CONFIG, {
            createImapClient: () => imap,
            createTransporter: () => makeTransportMock(),
        });
        const received = [];
        adapter.onMessage((msg) => received.push(msg));
        await adapter.poll();
        expect(received).toHaveLength(1);
        expect(received[0].messageId).toBe('<unique-123@example.com>');
    });
    it('falls back to uid:INBOX when Message-ID header is absent', async () => {
        const raw = buildRawEmail({
            from: 'bob@example.com',
            subject: 'No MID',
            text: 'No message id header',
        });
        const imap = makeImapMock([{ uid: 42, raw }]);
        const adapter = new EmailAdapter(BASE_CONFIG, {
            createImapClient: () => imap,
            createTransporter: () => makeTransportMock(),
        });
        const received = [];
        adapter.onMessage((msg) => received.push(msg));
        await adapter.poll();
        expect(received).toHaveLength(1);
        expect(received[0].messageId).toBe('uid:42:INBOX');
    });
    it('sets messageId on every emitted InboundMessage', async () => {
        const messages = [
            {
                uid: 1,
                raw: buildRawEmail({
                    from: 'a@example.com',
                    subject: 'A',
                    text: 'First',
                    messageId: '<a@mail>',
                }),
            },
            {
                uid: 2,
                raw: buildRawEmail({ from: 'b@example.com', subject: 'B', text: 'Second' }),
            },
        ];
        const imap = makeImapMock(messages);
        const adapter = new EmailAdapter(BASE_CONFIG, {
            createImapClient: () => imap,
            createTransporter: () => makeTransportMock(),
        });
        const received = [];
        adapter.onMessage((msg) => received.push(msg));
        await adapter.poll();
        expect(received).toHaveLength(2);
        expect(received[0].messageId).toBe('<a@mail>');
        expect(received[1].messageId).toBe('uid:2:INBOX');
    });
});
