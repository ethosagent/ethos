import { describe, expect, it } from 'vitest';
import { classifyChannelError } from '../classify-error';

describe('classifyChannelError (slack)', () => {
  it('classifies invalid_auth from the Web API error data shape', () => {
    const err = Object.assign(new Error('An API error occurred: invalid_auth'), {
      data: { ok: false, error: 'invalid_auth' },
    });
    const classified = classifyChannelError(err);
    expect(classified).not.toBeNull();
    expect(classified?.code).toBe('CHANNEL_CONFIG');
    expect(classified?.cause).toContain('Slack configuration problem (not an Ethos issue)');
    expect(classified?.cause).toContain('invalid_auth');
    expect(classified?.action).toContain('OAuth & Permissions');
  });

  it('classifies not_authed and token_revoked as token problems', () => {
    expect(classifyChannelError(new Error('An API error occurred: not_authed'))?.code).toBe(
      'CHANNEL_CONFIG',
    );
    const revoked = Object.assign(new Error('boom'), { data: { error: 'token_revoked' } });
    expect(classifyChannelError(revoked)?.code).toBe('CHANNEL_CONFIG');
  });

  it('classifies missing_scope and names the needed scope when present', () => {
    const err = Object.assign(new Error('An API error occurred: missing_scope'), {
      data: { ok: false, error: 'missing_scope', needed: 'chat:write' },
    });
    const classified = classifyChannelError(err);
    expect(classified?.code).toBe('CHANNEL_CONFIG');
    expect(classified?.cause).toContain("'chat:write'");
    expect(classified?.action).toContain('Scopes');
  });

  it('classifies invalid_app_token (socket mode without a valid app token)', () => {
    const err = Object.assign(new Error('An API error occurred: invalid_app_token'), {
      data: { ok: false, error: 'invalid_app_token' },
    });
    const classified = classifyChannelError(err);
    expect(classified?.code).toBe('CHANNEL_CONFIG');
    expect(classified?.action).toContain('connections:write');
  });

  it('returns null for unrelated errors', () => {
    expect(classifyChannelError(new Error('socket hang up'))).toBeNull();
    expect(classifyChannelError({ data: { error: 'ratelimited' } })).toBeNull();
  });
});
