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

  it('classifies a 403 as rejected', async () => {
    vi.stubGlobal('fetch', async () => ({ status: 403, json: async () => ({}) }));

    const result = await validateTelegramToken('bad-token');
    expect(result).toEqual({ ok: false, error: 'Invalid token', reason: 'rejected' });
  });

  it('classifies a 429 as unverified (rate-limited, not a settled verdict)', async () => {
    vi.stubGlobal('fetch', async () => ({ status: 429, json: async () => ({}) }));

    const result = await validateTelegramToken('any-token');
    expect(result).toEqual({
      ok: false,
      error: 'Telegram returned 429 (rate limited)',
      reason: 'unverified',
    });
  });

  it('classifies a 5xx as unreachable', async () => {
    vi.stubGlobal('fetch', async () => ({ status: 503, json: async () => ({}) }));

    const result = await validateTelegramToken('any-token');
    expect(result).toEqual({ ok: false, error: 'Telegram returned 503', reason: 'unreachable' });
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
