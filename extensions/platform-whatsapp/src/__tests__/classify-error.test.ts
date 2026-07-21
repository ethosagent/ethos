import { describe, expect, it } from 'vitest';
import { classifyChannelError, loggedOutError } from '../classify-error';

describe('classifyChannelError (whatsapp)', () => {
  it('classifies a Boom 401 (DisconnectReason.loggedOut)', () => {
    // Baileys wraps disconnects in Boom errors with output.statusCode.
    const err = Object.assign(new Error('Stream Errored (conflict)'), {
      output: { statusCode: 401, payload: { message: 'Unauthorized' } },
    });
    const classified = classifyChannelError(err, '/home/u/.ethos/whatsapp');
    expect(classified).not.toBeNull();
    expect(classified?.code).toBe('CHANNEL_CONFIG');
    expect(classified?.cause).toContain('WhatsApp configuration problem (not an Ethos issue)');
    expect(classified?.cause).toContain('logged out');
    expect(classified?.action).toContain('/home/u/.ethos/whatsapp');
    expect(classified?.action).toContain('relink');
  });

  it('classifies a logged-out message without the Boom shape', () => {
    expect(classifyChannelError(new Error('Connection was logged out'))?.code).toBe(
      'CHANNEL_CONFIG',
    );
  });

  it('returns null for transient disconnects', () => {
    const err = Object.assign(new Error('Connection closed'), {
      output: { statusCode: 428 },
    });
    expect(classifyChannelError(err)).toBeNull();
  });

  it('loggedOutError names the session directory', () => {
    expect(loggedOutError('/tmp/wa-session').action).toContain('/tmp/wa-session');
  });
});
