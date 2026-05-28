import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateSlackToken } from '../validate';

afterEach(() => {
  vi.unstubAllGlobals();
});
describe('validateSlackToken', () => {
  it('returns ok with label on success', async () => {
    vi.stubGlobal('fetch', async () => ({
      json: async () => ({ ok: true, team: 'MyWorkspace' }),
    }));
    const result = await validateSlackToken('xoxb-valid');
    expect(result).toEqual({ ok: true, label: 'MyWorkspace' });
  });
  it('returns error on auth failure', async () => {
    vi.stubGlobal('fetch', async () => ({
      json: async () => ({ ok: false, error: 'invalid_auth' }),
    }));
    const result = await validateSlackToken('bad-token');
    expect(result).toEqual({ ok: false, error: 'invalid_auth' });
  });
  it('returns error on network failure', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('network error');
    });
    const result = await validateSlackToken('any-token');
    expect(result).toEqual({ ok: false, error: 'Could not reach Slack (timeout)' });
  });
});
