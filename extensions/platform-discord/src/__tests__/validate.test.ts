import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateDiscordToken } from '../validate';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('validateDiscordToken', () => {
  it('returns ok with label on success', async () => {
    vi.stubGlobal('fetch', async () => ({
      status: 200,
      json: async () => ({ username: 'MyBotName' }),
    }));

    const result = await validateDiscordToken('valid-token');
    expect(result).toEqual({ ok: true, label: 'MyBotName' });
  });

  it('classifies a 401 as rejected', async () => {
    vi.stubGlobal('fetch', async () => ({
      status: 401,
      json: async () => ({}),
    }));

    const result = await validateDiscordToken('bad-token');
    expect(result).toEqual({ ok: false, error: 'Invalid bot token', reason: 'rejected' });
  });

  it('classifies a 403 as rejected', async () => {
    vi.stubGlobal('fetch', async () => ({ status: 403, json: async () => ({}) }));

    const result = await validateDiscordToken('bad-token');
    expect(result).toEqual({ ok: false, error: 'Invalid bot token', reason: 'rejected' });
  });

  it('classifies a 429 as unverified (rate-limited, not a settled verdict)', async () => {
    vi.stubGlobal('fetch', async () => ({ status: 429, json: async () => ({}) }));

    const result = await validateDiscordToken('any-token');
    expect(result).toEqual({
      ok: false,
      error: 'Discord returned 429 (rate limited)',
      reason: 'unverified',
    });
  });

  it('classifies a 5xx as unreachable', async () => {
    vi.stubGlobal('fetch', async () => ({ status: 503, json: async () => ({}) }));

    const result = await validateDiscordToken('any-token');
    expect(result).toEqual({ ok: false, error: 'Discord returned 503', reason: 'unreachable' });
  });

  it('classifies a network failure as unreachable', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('network error');
    });

    const result = await validateDiscordToken('any-token');
    expect(result).toEqual({
      ok: false,
      error: 'Could not reach Discord (timeout)',
      reason: 'unreachable',
    });
  });
});
