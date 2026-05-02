import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateTelegramToken } from '../validate';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('validateTelegramToken', () => {
  it('returns ok with label on success', async () => {
    vi.stubGlobal('fetch', async () => ({
      json: async () => ({ ok: true, result: { username: 'MyBot' } }),
    }));

    const result = await validateTelegramToken('valid-token');
    expect(result).toEqual({ ok: true, label: '@MyBot' });
  });

  it('returns error on auth failure', async () => {
    vi.stubGlobal('fetch', async () => ({
      json: async () => ({ ok: false }),
    }));

    const result = await validateTelegramToken('bad-token');
    expect(result).toEqual({ ok: false, error: 'Invalid token' });
  });

  it('returns error on network failure', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('network error');
    });

    const result = await validateTelegramToken('any-token');
    expect(result).toEqual({ ok: false, error: 'Could not reach Telegram (timeout)' });
  });
});
