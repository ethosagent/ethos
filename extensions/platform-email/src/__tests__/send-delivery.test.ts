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

describe('EmailAdapter.send — permanent refusals', () => {
  it.each([
    [550, '550 5.1.1 <a@x.com>: Recipient address rejected: User unknown'],
    [551, '551 5.1.6 User not local'],
    [553, '553 5.1.3 Mailbox name not allowed'],
  ])('SMTP %i is a hard bounce — permanent', async (code, response) => {
    const res = await makeAdapter(smtpError(code, response)).send('a@x.com:s', { text: 'hi' });
    expect(res).toMatchObject({ ok: false, permanent: true });
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
