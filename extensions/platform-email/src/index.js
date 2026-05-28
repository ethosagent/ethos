import { deriveBotKey } from '@ethosagent/core';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import * as nodemailer from 'nodemailer';
import { toNativeMarkdown } from './format';
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function slugify(text) {
    return text
        .toLowerCase()
        .replace(/^re:\s*/i, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 80);
}
// chatId encodes both sender and subject so each subject thread is a separate
// gateway lane (and therefore a separate agent session).
function makeChatId(from, subject) {
    return `${from}:${slugify(subject)}`;
}
// ---------------------------------------------------------------------------
// EmailAdapter
// ---------------------------------------------------------------------------
export class EmailAdapter {
    id = 'email';
    displayName = 'Email';
    canSendTyping = false;
    canEditMessage = false;
    canReact = false;
    canSendFiles = false;
    maxMessageLength = 100_000;
    get capabilities() {
        return {
            platform: 'email',
        };
    }
    config;
    pollIntervalMs;
    botKey;
    messageHandler;
    pollTimer;
    // chatId → thread state needed to reply correctly
    threads = new Map();
    // Injected in constructor — allows tests to provide mocks
    createImapClient;
    createTransporter;
    constructor(config, overrides) {
        this.config = config;
        this.pollIntervalMs = config.pollIntervalMs ?? 60_000;
        this.botKey = config.botKey ?? deriveBotKey(`${config.user}@${config.imapHost}`);
        this.createImapClient = overrides?.createImapClient ?? defaultImapClient;
        this.createTransporter = overrides?.createTransporter ?? defaultTransporter;
    }
    // ---------------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------------
    async start() {
        // First poll immediately, then schedule
        await this.poll();
        this.pollTimer = setInterval(() => void this.poll(), this.pollIntervalMs);
    }
    async stop() {
        if (this.pollTimer !== undefined) {
            clearInterval(this.pollTimer);
            this.pollTimer = undefined;
        }
    }
    // ---------------------------------------------------------------------------
    // Send — called by Gateway with chatId and response text
    // ---------------------------------------------------------------------------
    async send(chatId, message) {
        const thread = this.threads.get(chatId);
        if (!thread) {
            return { ok: false, error: `No thread state for chatId: ${chatId}` };
        }
        const transporter = this.createTransporter(this.config);
        try {
            const info = await transporter.sendMail({
                from: this.config.user,
                to: thread.to,
                subject: thread.replySubject,
                ...(thread.inReplyTo ? { inReplyTo: thread.inReplyTo, references: thread.inReplyTo } : {}),
                html: toNativeMarkdown(message.text),
            });
            return { ok: true, messageId: info.messageId };
        }
        catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    // ---------------------------------------------------------------------------
    // Message subscription
    // ---------------------------------------------------------------------------
    onMessage(handler) {
        this.messageHandler = handler;
    }
    // ---------------------------------------------------------------------------
    // Health check
    // ---------------------------------------------------------------------------
    async health() {
        const start = Date.now();
        const client = this.createImapClient(this.config);
        try {
            await client.connect();
            await client.logout();
            return { ok: true, latencyMs: Date.now() - start };
        }
        catch {
            return { ok: false };
        }
    }
    // ---------------------------------------------------------------------------
    // Poll — opens INBOX, fetches unseen messages, emits InboundMessage events
    // ---------------------------------------------------------------------------
    async poll() {
        if (!this.messageHandler)
            return;
        const client = this.createImapClient(this.config);
        try {
            await client.connect();
            const lock = await client.getMailboxLock('INBOX');
            try {
                const uidResult = await client.search({ seen: false }, { uid: true });
                const uids = Array.isArray(uidResult) ? uidResult : [];
                if (uids.length === 0)
                    return;
                for await (const msg of client.fetch(uids, { source: true, uid: true }, { uid: true })) {
                    if (!msg.source)
                        continue;
                    try {
                        await this.processMessage(msg.source, msg.uid, client);
                    }
                    catch {
                        // Skip malformed messages rather than crashing the poll loop
                    }
                }
            }
            finally {
                lock.release();
            }
        }
        catch {
            // IMAP errors are transient — log silently and retry next poll
        }
        finally {
            try {
                await client.logout();
            }
            catch {
                /* ignore */
            }
        }
    }
    async processMessage(source, uid, client) {
        const parsed = await simpleParser(source);
        const from = parsed.from?.value?.[0]?.address ?? '';
        const subject = parsed.subject ?? '(no subject)';
        const text = (parsed.text ?? '').trim();
        if (!from || !text)
            return;
        const chatId = makeChatId(from, subject);
        this.threads.set(chatId, {
            to: from,
            replySubject: subject.match(/^re:/i) ? subject : `Re: ${subject}`,
            inReplyTo: parsed.messageId ?? undefined,
        });
        this.messageHandler?.({
            platform: 'email',
            botKey: this.botKey,
            chatId,
            userId: from,
            username: parsed.from?.value?.[0]?.name ?? from,
            text,
            isDm: true,
            isGroupMention: false,
            messageId: parsed.messageId ?? `uid:${uid}:INBOX`,
            raw: parsed,
        });
        // Mark seen so we don't re-process on the next poll
        await client.messageFlagsAdd([uid], ['\\Seen'], { uid: true });
    }
}
// ---------------------------------------------------------------------------
// Default factory functions (replaced by mocks in tests)
// ---------------------------------------------------------------------------
function defaultImapClient(cfg) {
    return new ImapFlow({
        host: cfg.imapHost,
        port: cfg.imapPort,
        secure: true,
        auth: { user: cfg.user, pass: cfg.password },
        logger: false,
    });
}
function defaultTransporter(cfg) {
    return nodemailer.createTransport({
        host: cfg.smtpHost,
        port: cfg.smtpPort,
        secure: cfg.smtpSecure ?? cfg.smtpPort === 465,
        auth: { user: cfg.user, pass: cfg.password },
    });
}
