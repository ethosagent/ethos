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
  it('returns error on 401 auth failure', async () => {
    vi.stubGlobal('fetch', async () => ({
      status: 401,
      json: async () => ({}),
    }));
    const result = await validateDiscordToken('bad-token');
    expect(result).toEqual({ ok: false, error: 'Invalid bot token' });
  });
  it('returns error on network failure', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('network error');
    });
    const result = await validateDiscordToken('any-token');
    expect(result).toEqual({ ok: false, error: 'Could not reach Discord (timeout)' });
  });
});
