import { InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { EmailAdapter, type EmailAdapterConfig } from '../index';
import { loadEmailSdk } from '../sdk';

// What `send()` reports is the gateway delivery ledger's only evidence. A
// refusal no retry can fix must say so (`DeliveryResult.permanent`) so the
// sweep stops at once instead of re-sending to a dead mailbox for hours.
//
// No partial case: one reply is one `sendMail`, which either hands the whole
// message to the SMTP server or does not.

beforeAll(async () => {
  await loadEmailSdk();
});

const CONFIG: EmailAdapterConfig = {
  imapHost: 'imap.example.com',
  imapPort: 993,
  user: 'agent@example.com',
  password: 'secret',
  smtpHost: 'smtp.example.com',
  smtpPort: 587,
  botKey: 'email-test-bot',
};

/** The shape nodemailer rejects with for an SMTP error reply. */
function smtpError(responseCode: number, response: string, code = 'EENVELOPE'): Error {
  return Object.assign(new Error(`Can't send mail - all recipients were rejected: ${response}`), {
    code,
    responseCode,
    response,
  });
}

function makeAdapter(err: Error) {
  const transport = { sendMail: vi.fn().mockRejectedValue(err) };
  const adapter = new EmailAdapter(CONFIG, { createTransporter: () => transport as never });
  (adapter as unknown as { threads: Map<string, unknown> }).threads.set('a@x.com:s', {
    to: 'a@x.com',
    replySubject: 'Re: s',
  });
  return adapter;
}

/** A raw inbound email that passes sender auth for `CONFIG_AUTH`. */
function rawEmail(from: string, subject: string, messageId: string): Buffer {
  const domain = from.slice(from.lastIndexOf('@') + 1);
  return Buffer.from(
    [
      `Authentication-Results: mx.example.com; dmarc=pass header.from=${domain}`,
      `From: ${from}`,
      'To: agent@example.com',
      `Subject: ${subject}`,
      `Message-ID: ${messageId}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'please look',
    ].join('\r\n'),
    'utf-8',
  );
}

function imapWith(messages: Array<{ uid: number; raw: Buffer }>) {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue(messages.map((m) => m.uid)),
    getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
    fetch: vi.fn().mockImplementation(async function* () {
      for (const m of messages) yield { uid: m.uid, source: m.raw };
    }),
    messageFlagsAdd: vi.fn().mockResolvedValue(undefined),
  };
}

// A reply owed across a restart: the delivery-ledger sweep redelivers it
// through a NEW adapter instance, which never polled the message it answers.
describe('EmailAdapter — thread state survives a restart', () => {
  const CONFIG_AUTH: EmailAdapterConfig = { ...CONFIG, trustedAuthservId: 'mx.example.com' };

  it('a new adapter on the same storage replies in-thread to a chat the old one saw', async () => {
    const storage = new InMemoryStorage();
    const first = new EmailAdapter(
      { ...CONFIG_AUTH, storage, emailDir: '/ethos/email' },
      {
        createImapClient: () =>
          imapWith([{ uid: 1, raw: rawEmail('alice@example.com', 'Build', '<m1@x>') }]) as never,
        createTransporter: () => ({ sendMail: vi.fn() }) as never,
      },
    );
    const chats: string[] = [];
    first.onMessage((m) => chats.push(m.chatId));
    await first.poll();
    const chatId = chats[0] ?? '';
    expect(chatId).toBe('alice@example.com:build');

    // "Restart": a fresh instance, same storage, never polled.
    const transport = { sendMail: vi.fn().mockResolvedValue({ messageId: '<r@x>' }) };
    const second = new EmailAdapter(
      { ...CONFIG_AUTH, storage, emailDir: '/ethos/email' },
      { createTransporter: () => transport as never },
    );
    const res = await second.send(chatId, { text: 'owed reply' });
    expect(res).toEqual({ ok: true, messageId: '<r@x>' });
    expect(transport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'alice@example.com',
        subject: 'Re: Build',
        inReplyTo: '<m1@x>',
        references: '<m1@x>',
      }),
    );
  });
});

describe('EmailAdapter.send — permanent refusals', () => {
  it.each([
    [550, '550 5.1.1 <a@x.com>: Recipient address rejected: User unknown'],
    [551, '551 5.1.6 User not local'],
    [553, '553 5.1.3 Mailbox name not allowed'],
  ])('SMTP %i is a hard bounce — permanent', async (code, response) => {
    const res = await makeAdapter(smtpError(code, response)).send('a@x.com:s', { text: 'hi' });
    expect(res).toMatchObject({ ok: false, permanent: true });
  });

  it('a chat with no thread state at all is permanent — no retry can recover it', async () => {
    const transport = { sendMail: vi.fn() };
    const adapter = new EmailAdapter(CONFIG, { createTransporter: () => transport as never });
    const res = await adapter.send('nobody@x.com:s', { text: 'hi' });
    expect(res).toMatchObject({ ok: false, permanent: true });
    expect(res.error).toMatch(/No thread state/);
    expect(transport.sendMail).not.toHaveBeenCalled();
  });

  it('4xx, auth failures and transport errors are not permanent', async () => {
    for (const err of [
      smtpError(450, '450 4.2.1 Mailbox busy'),
      smtpError(421, '421 Service not available', 'ECONNECTION'),
      smtpError(535, '535 5.7.8 Authentication failed', 'EAUTH'),
      Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    ]) {
      const res = await makeAdapter(err).send('a@x.com:s', { text: 'hi' });
      expect(res.ok).toBe(false);
      expect(res.permanent).toBeUndefined();
    }
  });
});
