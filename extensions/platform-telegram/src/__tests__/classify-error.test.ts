import { describe, expect, it } from 'vitest';
import { classifyChannelError } from '../classify-error';

describe('classifyChannelError (telegram)', () => {
  it('classifies a 401 Unauthorized (bad bot token) via error_code', () => {
    // GrammyError shape: carries the Bot API error_code alongside the message.
    const err = Object.assign(new Error("Call to 'getMe' failed! (401: Unauthorized)"), {
      error_code: 401,
    });
    const classified = classifyChannelError(err);
    expect(classified).not.toBeNull();
    expect(classified?.code).toBe('CHANNEL_CONFIG');
    expect(classified?.cause).toContain('Telegram configuration problem (not an Ethos issue)');
    expect(classified?.cause).toContain('401');
    expect(classified?.action).toContain('@BotFather');
  });

  it('classifies a 401 from the message alone', () => {
    const classified = classifyChannelError(new Error('getMe failed (401: Unauthorized)'));
    expect(classified?.code).toBe('CHANNEL_CONFIG');
  });

  it('classifies a 409 Conflict (second getUpdates consumer / webhook set)', () => {
    const err = Object.assign(
      new Error(
        "Call to 'getUpdates' failed! (409: Conflict: terminated by other getUpdates request; make sure that only one bot instance is running)",
      ),
      { error_code: 409 },
    );
    const classified = classifyChannelError(err);
    expect(classified?.code).toBe('CHANNEL_CONFIG');
    expect(classified?.cause).toContain('409');
    expect(classified?.action).toContain('deleteWebhook');
  });

  it('returns null for unrelated errors', () => {
    expect(classifyChannelError(new Error('Network request for getUpdates failed'))).toBeNull();
    expect(classifyChannelError(null)).toBeNull();
  });
});
