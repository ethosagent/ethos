import { describe, expect, it } from 'vitest';
import { classifyChannelError, classifyDiscordCloseCode } from '../classify-error';

describe('classifyChannelError (discord)', () => {
  it('classifies the raw WS close-reason error for disallowed intents (close 4014)', () => {
    // Exact shape observed in the incident: discord.js surfaces the WS close
    // reason as a plain Error message.
    const err = new Error('Used disallowed intents');
    const classified = classifyChannelError(err);
    expect(classified).not.toBeNull();
    expect(classified?.code).toBe('CHANNEL_CONFIG');
    expect(classified?.cause).toContain('Discord configuration problem (not an Ethos issue)');
    expect(classified?.cause).toContain('Message Content');
    expect(classified?.action).toContain('Privileged Gateway Intents');
    expect(classified?.details).toEqual({ platform: 'Discord' });
  });

  it('classifies the DiscordjsError code for disallowed intents', () => {
    const err = Object.assign(
      new Error('Privileged intent provided is not enabled or whitelisted.'),
      { code: 'DisallowedIntents' },
    );
    const classified = classifyChannelError(err);
    expect(classified?.code).toBe('CHANNEL_CONFIG');
    expect(classified?.action).toContain('Message Content Intent');
  });

  it('classifies an invalid token (TokenInvalid / 4004)', () => {
    const err = Object.assign(new Error('An invalid token was provided.'), {
      code: 'TokenInvalid',
    });
    const classified = classifyChannelError(err);
    expect(classified?.code).toBe('CHANNEL_CONFIG');
    expect(classified?.cause).toContain('Discord configuration problem (not an Ethos issue)');
    expect(classified?.action).toContain('Reset Token');
  });

  it('returns null for unrelated errors', () => {
    expect(classifyChannelError(new Error('read ECONNRESET'))).toBeNull();
    expect(classifyChannelError('boom')).toBeNull();
    expect(classifyChannelError(null)).toBeNull();
  });
});

describe('classifyDiscordCloseCode', () => {
  it('maps 4014 and 4013 to the intents error', () => {
    expect(classifyDiscordCloseCode(4014)?.cause).toContain('privileged intent');
    expect(classifyDiscordCloseCode(4013)?.code).toBe('CHANNEL_CONFIG');
  });

  it('maps 4004 to the token error', () => {
    expect(classifyDiscordCloseCode(4004)?.action).toContain('Reset Token');
  });

  it('ignores recoverable close codes', () => {
    expect(classifyDiscordCloseCode(1000)).toBeNull();
    expect(classifyDiscordCloseCode(4009)).toBeNull();
  });
});
