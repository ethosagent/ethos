import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateTelegramToken } from '../validate';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('validateTelegramToken', () => {
  it('returns ok with label on success', async () => {
    vi.stubGlobal('fetch', async () => ({
      status: 200,
      json: async () => ({ ok: true, result: { username: 'MyBot' } }),
    }));

    const result = await validateTelegramToken('valid-token');
    expect(result).toEqual({ ok: true, label: '@MyBot' });
  });

  it('classifies a rejected token from data.ok=false as rejected', async () => {
    vi.stubGlobal('fetch', async () => ({
      status: 200,
      json: async () => ({ ok: false }),
    }));

    const result = await validateTelegramToken('bad-token');
    expect(result).toEqual({ ok: false, error: 'Invalid token', reason: 'rejected' });
  });

  it('classifies a 401 as rejected', async () => {
    vi.stubGlobal('fetch', async () => ({ status: 401, json: async () => ({}) }));

    const result = await validateTelegramToken('bad-token');
    expect(result).toEqual({ ok: false, error: 'Invalid token', reason: 'rejected' });
  });

  it('classifies a 429 / 5xx as unreachable', async () => {
    vi.stubGlobal('fetch', async () => ({ status: 429, json: async () => ({}) }));

    const result = await validateTelegramToken('any-token');
    expect(result).toEqual({ ok: false, error: 'Telegram returned 429', reason: 'unreachable' });
  });

  it('classifies a network failure as unreachable', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('network error');
    });

    const result = await validateTelegramToken('any-token');
    expect(result).toEqual({
      ok: false,
      error: 'Could not reach Telegram (timeout)',
      reason: 'unreachable',
    });
  });
});
