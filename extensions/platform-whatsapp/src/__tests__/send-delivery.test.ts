import { describe, expect, it, vi } from 'vitest';
import { WhatsAppAdapter } from '../index';

// What `send()` reports is the gateway delivery ledger's only evidence. A
// `{ ok: false }` after text already reached the chat makes the ledger's
// sweep post that text again on every retry.
//
// No `permanent` mapping here: Baileys surfaces no error that says "this chat
// can never be reached" — a blocked contact or a number not on WhatsApp does
// not fail `sendMessage` at all — so every failure stays retryable.

function makeAdapter(sendMessage: (jid: string, content: unknown) => Promise<unknown>) {
  const adapter = new WhatsAppAdapter({ sessionDir: '/tmp/test-wa-send', allowedJids: ['1'] });
  const spy = vi.fn(sendMessage);
  (adapter as unknown as { sock: unknown }).sock = { sendMessage: spy };
  return { adapter, spy };
}

const TWO_CHUNKS = `${'a'.repeat(65530)} ${'b'.repeat(100)}`;

describe('WhatsAppAdapter.send — partial delivery', () => {
  it('a later chunk failing after the first landed is reported delivered, not retryable', async () => {
    let n = 0;
    const { adapter, spy } = makeAdapter(async () => {
      n++;
      if (n === 2) throw new Error('Connection Closed');
      return { key: { id: `wa-${n}` } };
    });
    const res = await adapter.send('1@s.whatsapp.net', { text: TWO_CHUNKS });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(res.ok).toBe(true);
    expect(res.messageId).toBe('wa-1');
    expect(res.error).toMatch(/partial: 1 of 2 chunks/);
  });

  it('the first chunk failing is a plain, retryable failure', async () => {
    const { adapter } = makeAdapter(async () => {
      throw new Error('Connection Closed');
    });
    const res = await adapter.send('1@s.whatsapp.net', { text: 'hi' });
    expect(res).toEqual({ ok: false, error: 'Connection Closed' });
  });
});
