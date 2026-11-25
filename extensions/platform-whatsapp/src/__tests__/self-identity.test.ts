import { describe, expect, it } from 'vitest';
import { WhatsAppAdapter } from '../index';

// Plan channel-prompts §3.8, D10 — the bot's number is the user part of `botJid`.

describe('WhatsAppAdapter.selfIdentity', () => {
  const make = () => new WhatsAppAdapter({ sessionDir: '/tmp/test-wa-self', allowedJids: ['1'] });

  it('is undefined until the socket reports the bot JID', () => {
    expect(make().selfIdentity()).toBeUndefined();
  });

  it('is the user part of the JID, device suffix dropped', () => {
    const adapter = make();
    (adapter as unknown as { botJid: string }).botJid = '15551234567:12@s.whatsapp.net';
    expect(adapter.selfIdentity()).toEqual({
      handle: '15551234567',
      platformUserId: '15551234567:12@s.whatsapp.net',
    });
  });
});
