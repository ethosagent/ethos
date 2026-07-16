import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateSlackToken } from '../validate';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('validateSlackToken', () => {
  it('returns ok with label on success', async () => {
    vi.stubGlobal('fetch', async () => ({
      status: 200,
      json: async () => ({ ok: true, team: 'MyWorkspace' }),
    }));

    const result = await validateSlackToken('xoxb-valid');
    expect(result).toEqual({ ok: true, label: 'MyWorkspace' });
  });

  it('classifies invalid_auth as rejected', async () => {
    vi.stubGlobal('fetch', async () => ({
      status: 200,
      json: async () => ({ ok: false, error: 'invalid_auth' }),
    }));

    const result = await validateSlackToken('bad-token');
    expect(result).toEqual({ ok: false, error: 'invalid_auth', reason: 'rejected' });
  });

  it('classifies a transient error code (ratelimited) as unreachable', async () => {
    vi.stubGlobal('fetch', async () => ({
      status: 200,
      json: async () => ({ ok: false, error: 'ratelimited' }),
    }));

    const result = await validateSlackToken('any-token');
    expect(result).toEqual({ ok: false, error: 'ratelimited', reason: 'unreachable' });
  });

  it('classifies a 5xx as unreachable', async () => {
    vi.stubGlobal('fetch', async () => ({ status: 503, json: async () => ({}) }));

    const result = await validateSlackToken('any-token');
    expect(result).toEqual({ ok: false, error: 'Slack returned 503', reason: 'unreachable' });
  });

  it('classifies a network failure as unreachable', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('network error');
    });

    const result = await validateSlackToken('any-token');
    expect(result).toEqual({
      ok: false,
      error: 'Could not reach Slack (timeout)',
      reason: 'unreachable',
    });
  });
});
