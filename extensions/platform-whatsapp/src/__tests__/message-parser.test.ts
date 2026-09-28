// `parseInboundMessage`'s audience hint (plan personality-memory-boundary D10):
// a JID that is not a group but not one person either is still routed as a DM
// (`isDm` unchanged — admission, pairing and engagement stay as they were) and
// carries `audienceHint: 'shared'` so the gateway runs it without private memory.

import { describe, expect, it } from 'vitest';
import { isOneToOneJid, parseInboundMessage, type RawWhatsAppMessage } from '../message-parser';

function raw(remoteJid: string, participant?: string): RawWhatsAppMessage {
  return {
    key: { remoteJid, fromMe: false, id: 'm1', ...(participant ? { participant } : {}) },
    message: { conversation: 'hello' },
  };
}

const BOT = '9999999999@s.whatsapp.net';

describe('parseInboundMessage audienceHint', () => {
  it.each(['15551234567@s.whatsapp.net', '123456789012345@lid'])(
    'a one-to-one DM (%s) carries no hint',
    (jid) => {
      const parsed = parseInboundMessage(raw(jid), BOT, 'bot');
      expect(parsed?.isDm).toBe(true);
      expect(parsed?.audienceHint).toBeUndefined();
    },
  );

  it.each(['status@broadcast', '1234567890@broadcast', '120363000000000000@newsletter'])(
    '%s stays a DM for routing but is hinted shared',
    (jid) => {
      const parsed = parseInboundMessage(raw(jid, '15551234567@s.whatsapp.net'), BOT, 'bot');
      expect(parsed?.isDm).toBe(true);
      expect(parsed?.audienceHint).toBe('shared');
    },
  );

  it('a group is not a DM and needs no hint (isDm already says shared)', () => {
    const parsed = parseInboundMessage(
      raw('120363000000000001@g.us', '15551234567@s.whatsapp.net'),
      BOT,
      'bot',
    );
    expect(parsed?.isDm).toBe(false);
    expect(parsed?.audienceHint).toBeUndefined();
  });

  it('isOneToOneJid accepts only phone JIDs and LIDs', () => {
    expect(isOneToOneJid('1@s.whatsapp.net')).toBe(true);
    expect(isOneToOneJid('1@lid')).toBe(true);
    expect(isOneToOneJid('status@broadcast')).toBe(false);
    expect(isOneToOneJid('1@g.us')).toBe(false);
    expect(isOneToOneJid('1@newsletter')).toBe(false);
  });
});
