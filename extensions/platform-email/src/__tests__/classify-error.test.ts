import { describe, expect, it } from 'vitest';
import { classifyChannelError, isAuthFailure } from '../classify-error';

describe('classifyChannelError (email)', () => {
  it('classifies an IMAP authentication failure (imapflow shape)', () => {
    const err = Object.assign(new Error('Command failed'), {
      authenticationFailed: true,
      responseText: 'LOGIN failed.',
    });
    expect(isAuthFailure(err)).toBe(true);
    const classified = classifyChannelError(err);
    expect(classified).not.toBeNull();
    expect(classified?.code).toBe('CHANNEL_CONFIG');
    expect(classified?.cause).toContain('Email configuration problem (not an Ethos issue)');
    expect(classified?.action).toContain('app password');
  });

  it('classifies an auth failure from the message alone', () => {
    expect(classifyChannelError(new Error('Invalid credentials (Failure)'))?.code).toBe(
      'CHANNEL_CONFIG',
    );
  });

  it('classifies ENOTFOUND as a wrong-host problem', () => {
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND imap.gmial.com'), {
      code: 'ENOTFOUND',
    });
    const classified = classifyChannelError(err);
    expect(classified?.code).toBe('CHANNEL_CONFIG');
    expect(classified?.cause).toContain('ENOTFOUND');
  });

  it('classifies ECONNREFUSED as a wrong host/port problem', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9993'), {
      code: 'ECONNREFUSED',
    });
    const classified = classifyChannelError(err);
    expect(classified?.code).toBe('CHANNEL_CONFIG');
    expect(classified?.action).toContain('993');
  });

  it('returns null for transient errors', () => {
    expect(classifyChannelError(new Error('Socket timeout'))).toBeNull();
    expect(isAuthFailure(new Error('Socket timeout'))).toBe(false);
  });
});
