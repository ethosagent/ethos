// The gateway keys inbound dedup, the inbound spool and reply dedup (UBP-014)
// on `InboundMessage.messageId`, so the parser passes on any stable id Baileys
// gives: the stanza id (`key.id`), else a newsletter's server-assigned
// `key.server_id` (`decodeMessageNode`, Baileys lib/Utils/decode-wa-message.js).

import { describe, expect, it } from 'vitest';
import { parseInboundMessage, type RawWhatsAppMessage } from '../message-parser';

const BOT = '9999999999@s.whatsapp.net';

function raw(key: Partial<RawWhatsAppMessage['key']>): RawWhatsAppMessage {
  return {
    key: { remoteJid: '1234567890@s.whatsapp.net', fromMe: false, id: '', ...key },
    message: { conversation: 'hello' },
  };
}

describe('parseInboundMessage — messageId', () => {
  it('uses the stanza id', () => {
    expect(parseInboundMessage(raw({ id: 'ABC123' }), BOT, 'bot')?.messageId).toBe('ABC123');
  });

  it('falls back to a newsletter server_id when the key has no id', () => {
    const parsed = parseInboundMessage(raw({ id: '', server_id: '42' }), BOT, 'bot');
    expect(parsed?.messageId).toBe('42');
  });

  it('prefers the stanza id over server_id', () => {
    const parsed = parseInboundMessage(raw({ id: 'ABC123', server_id: '42' }), BOT, 'bot');
    expect(parsed?.messageId).toBe('ABC123');
  });

  it('with neither, leaves messageId unset (never an empty string)', () => {
    expect(parseInboundMessage(raw({ id: '' }), BOT, 'bot')?.messageId).toBeUndefined();
  });
});
