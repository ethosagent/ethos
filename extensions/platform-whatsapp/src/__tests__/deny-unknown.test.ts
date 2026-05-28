import { describe, expect, it } from 'vitest';
import type { WhatsAppAdapterConfig } from '../index';

/**
 * Replicates the denyUnknown filter decision from WhatsAppAdapter's
 * messages.upsert handler. Tests this logic in isolation without
 * requiring a Baileys socket.
 */
function shouldRejectSender(
  config: Pick<WhatsAppAdapterConfig, 'denyUnknown' | 'allowedJids'>,
  senderJid: string,
): boolean {
  const denyUnknown = config.denyUnknown ?? true;
  if (!denyUnknown) return false;
  if (!config.allowedJids || config.allowedJids.length === 0) return true;
  const number = senderJid.split('@')[0].replace(/[^0-9]/g, '');
  return !config.allowedJids.some((allowed) => {
    const normalizedAllowed = allowed.replace(/[^0-9]/g, '');
    return number === normalizedAllowed;
  });
}

describe('WhatsApp denyUnknown filter', () => {
  it('rejects all senders by default (denyUnknown defaults to true, no allowedJids)', () => {
    expect(shouldRejectSender({}, '1234567890@s.whatsapp.net')).toBe(true);
  });

  it('rejects all senders when denyUnknown=true and allowedJids is empty', () => {
    expect(
      shouldRejectSender({ denyUnknown: true, allowedJids: [] }, '1234567890@s.whatsapp.net'),
    ).toBe(true);
  });

  it('rejects unknown sender when denyUnknown=true and allowedJids is set', () => {
    expect(
      shouldRejectSender(
        { denyUnknown: true, allowedJids: ['9876543210'] },
        '1234567890@s.whatsapp.net',
      ),
    ).toBe(true);
  });

  it('allows a matching sender when denyUnknown=true', () => {
    expect(
      shouldRejectSender(
        { denyUnknown: true, allowedJids: ['1234567890'] },
        '1234567890@s.whatsapp.net',
      ),
    ).toBe(false);
  });

  it('allows all senders when denyUnknown=false', () => {
    expect(shouldRejectSender({ denyUnknown: false }, '1234567890@s.whatsapp.net')).toBe(false);
    expect(shouldRejectSender({ denyUnknown: false }, 'unknown@s.whatsapp.net')).toBe(false);
  });

  it('normalizes phone numbers for comparison (strips non-digits)', () => {
    expect(
      shouldRejectSender(
        { denyUnknown: true, allowedJids: ['+1-234-567-8900'] },
        '12345678900@s.whatsapp.net',
      ),
    ).toBe(false);
  });
});
