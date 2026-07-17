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

  it('classifies unenumerated bad-credential codes as rejected (inverted allowlist)', async () => {
    // missing_scope / not_allowed_token_type / ekm_access_denied are real
    // bad-token verdicts; the old rejected-allowlist wrongly downgraded them.
    for (const code of ['missing_scope', 'not_allowed_token_type', 'ekm_access_denied']) {
      vi.stubGlobal('fetch', async () => ({
        status: 200,
        json: async () => ({ ok: false, error: code }),
      }));
      const result = await validateSlackToken('bad-token');
      expect(result).toEqual({ ok: false, error: code, reason: 'rejected' });
    }
  });

  it('classifies rate limit (ratelimited) as unverified, not a settled verdict', async () => {
    vi.stubGlobal('fetch', async () => ({
      status: 200,
      json: async () => ({ ok: false, error: 'ratelimited' }),
    }));

    const result = await validateSlackToken('any-token');
    expect(result).toEqual({ ok: false, error: 'ratelimited', reason: 'unverified' });
  });

  it('classifies a 429 as unverified', async () => {
    vi.stubGlobal('fetch', async () => ({ status: 429, json: async () => ({}) }));

    const result = await validateSlackToken('any-token');
    expect(result).toEqual({
      ok: false,
      error: 'Slack returned 429 (rate limited)',
      reason: 'unverified',
    });
  });

  it('classifies a genuine transient code (service_unavailable) as unreachable', async () => {
    vi.stubGlobal('fetch', async () => ({
      status: 200,
      json: async () => ({ ok: false, error: 'service_unavailable' }),
    }));

    const result = await validateSlackToken('any-token');
    expect(result).toEqual({ ok: false, error: 'service_unavailable', reason: 'unreachable' });
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
