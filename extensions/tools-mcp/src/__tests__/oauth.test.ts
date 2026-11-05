import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OAuthConfig, TokenSet } from '../oauth';
import {
  buildAuthorizationUrl,
  consumeOAuthState,
  deleteTokens,
  exchangeCode,
  generateCodeChallenge,
  generateCodeVerifier,
  isTokenExpired,
  loadAccessToken,
  MissingToken,
  OAuthIssuerMismatch,
  PastedRedirectError,
  parsePastedRedirect,
  refreshToken,
  registerOAuthState,
  runPkceLogin,
  startCallbackServer,
  storeTokens,
} from '../oauth';

// safeFetch's default transport pins each connection to the validated address
// through undici (`pinnedFetch`, packages/safety/network/src/safe-fetch.ts),
// which the global-fetch stubs in this file cannot see. Route it to the stubs
// through the documented, unpinned `fetchImpl` seam; URL validation and
// redirect handling stay real.
vi.mock('@ethosagent/safety-network', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ethosagent/safety-network')>();
  return {
    ...actual,
    safeFetch: (url: string, opts: Parameters<typeof actual.safeFetch>[1]) =>
      actual.safeFetch(url, { ...opts, fetchImpl: (input, init) => globalThis.fetch(input, init) }),
  };
});

// ---------------------------------------------------------------------------
// In-memory secrets resolver for tests
// ---------------------------------------------------------------------------

function createMockSecrets() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (ref: string) => store.get(ref) ?? null),
    set: vi.fn(async (ref: string, value: string) => {
      store.set(ref, value);
    }),
    delete: vi.fn(async (ref: string) => {
      store.delete(ref);
    }),
    list: vi.fn(async (prefix?: string) => {
      const all = [...store.keys()];
      if (!prefix) return all;
      return all.filter((k) => k.startsWith(prefix));
    }),
    _store: store,
  };
}

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

describe('generateCodeVerifier', () => {
  it('produces a string of at least 43 characters', () => {
    const verifier = generateCodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
  });

  it('produces different values on each call', () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    expect(a).not.toBe(b);
  });

  it('uses base64url encoding (no +, /, or =)', () => {
    const verifier = generateCodeVerifier();
    expect(verifier).not.toMatch(/[+/=]/);
  });
});

describe('generateCodeChallenge', () => {
  it('is deterministic SHA256 of the verifier', () => {
    const verifier = 'test-verifier-value';
    const challenge = generateCodeChallenge(verifier);
    const expected = createHash('sha256').update(verifier).digest('base64url');
    expect(challenge).toBe(expected);
  });

  it('produces a base64url string', () => {
    const challenge = generateCodeChallenge('some-verifier');
    expect(challenge).not.toMatch(/[+/=]/);
  });

  it('same verifier produces same challenge', () => {
    const verifier = generateCodeVerifier();
    expect(generateCodeChallenge(verifier)).toBe(generateCodeChallenge(verifier));
  });
});

// ---------------------------------------------------------------------------
// Token storage (uses correct secret refs)
// ---------------------------------------------------------------------------

describe('token storage', () => {
  it('storeTokens writes to correct secret refs', async () => {
    const secrets = createMockSecrets();
    const tokens: TokenSet = {
      access_token: 'access-123',
      refresh_token: 'refresh-456',
      expires_at: '2026-12-01T00:00:00.000Z',
    };

    await storeTokens('my-server', tokens, secrets, {
      v: 1,
      token_endpoint: 'https://auth.example.com/token',
    });

    expect(secrets.set).toHaveBeenCalledWith('mcp/my-server/access_token', 'access-123');
    expect(secrets.set).toHaveBeenCalledWith('mcp/my-server/refresh_token', 'refresh-456');
    expect(secrets.set).toHaveBeenCalledWith(
      'mcp/my-server/expires_at',
      '2026-12-01T00:00:00.000Z',
    );
  });

  it('storeTokens skips optional fields when absent', async () => {
    const secrets = createMockSecrets();
    const tokens: TokenSet = { access_token: 'access-only' };

    await storeTokens('srv', tokens, secrets, {
      v: 1,
      token_endpoint: 'https://auth.example.com/token',
    });

    // access_token + the token_binding; no refresh_token / expires_at
    expect(secrets.set).toHaveBeenCalledTimes(2);
    expect(secrets.set).toHaveBeenCalledWith('mcp/srv/access_token', 'access-only');
  });

  it('loadAccessToken reads from correct ref', async () => {
    const secrets = createMockSecrets();
    secrets._store.set('mcp/srv/access_token', 'my-token');

    const token = await loadAccessToken('srv', secrets);
    expect(token).toBe('my-token');
    expect(secrets.get).toHaveBeenCalledWith('mcp/srv/access_token');
  });

  it('deleteTokens removes all three refs', async () => {
    const secrets = createMockSecrets();
    secrets._store.set('mcp/srv/access_token', 'a');
    secrets._store.set('mcp/srv/refresh_token', 'r');
    secrets._store.set('mcp/srv/expires_at', 'e');

    await deleteTokens('srv', secrets);

    expect(secrets.delete).toHaveBeenCalledWith('mcp/srv/access_token');
    expect(secrets.delete).toHaveBeenCalledWith('mcp/srv/refresh_token');
    expect(secrets.delete).toHaveBeenCalledWith('mcp/srv/expires_at');
  });
});

// ---------------------------------------------------------------------------
// Token expiry
// ---------------------------------------------------------------------------

describe('isTokenExpired', () => {
  it('returns false when no expires_at is stored', async () => {
    const secrets = createMockSecrets();
    const expired = await isTokenExpired('srv', secrets);
    expect(expired).toBe(false);
  });

  it('returns true when token is past expiry', async () => {
    const secrets = createMockSecrets();
    secrets._store.set('mcp/srv/expires_at', '2020-01-01T00:00:00.000Z');

    const expired = await isTokenExpired('srv', secrets);
    expect(expired).toBe(true);
  });

  it('returns true when token is within buffer of expiry', async () => {
    const secrets = createMockSecrets();
    // Expires 30s from now, but buffer is 60s
    const soon = new Date(Date.now() + 30_000).toISOString();
    secrets._store.set('mcp/srv/expires_at', soon);

    const expired = await isTokenExpired('srv', secrets, 60_000);
    expect(expired).toBe(true);
  });

  it('returns false when token is well within validity', async () => {
    const secrets = createMockSecrets();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    secrets._store.set('mcp/srv/expires_at', future);

    const expired = await isTokenExpired('srv', secrets);
    expect(expired).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Authorization URL construction
// ---------------------------------------------------------------------------

describe('buildAuthorizationUrl', () => {
  const config: OAuthConfig = {
    authorization_endpoint: 'https://auth.example.com/authorize',
    token_endpoint: 'https://auth.example.com/token',
    client_id: 'my-client',
    scopes: ['read', 'write'],
  };

  it('includes all required PKCE params', () => {
    const url = buildAuthorizationUrl(config, 'http://127.0.0.1:9999', 'state123', 'challenge456');
    const parsed = new URL(url);

    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('client_id')).toBe('my-client');
    expect(parsed.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:9999');
    expect(parsed.searchParams.get('state')).toBe('state123');
    expect(parsed.searchParams.get('code_challenge')).toBe('challenge456');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('scope')).toBe('read write');
  });

  it('omits scope when not configured', () => {
    const noScopes = { ...config, scopes: undefined };
    const url = buildAuthorizationUrl(noScopes, 'http://127.0.0.1:9999', 'st', 'ch');
    const parsed = new URL(url);
    expect(parsed.searchParams.has('scope')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Refresh flow
// ---------------------------------------------------------------------------

describe('refreshToken', () => {
  const config: OAuthConfig = {
    authorization_endpoint: 'https://auth.example.com/authorize',
    token_endpoint: 'https://auth.example.com/token',
    client_id: 'my-client',
  };

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls token endpoint with refresh_token grant', async () => {
    const secrets = createMockSecrets();
    secrets._store.set('mcp/srv/refresh_token', 'rt-abc');

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'new-access', expires_in: 3600 }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const token = await refreshToken('srv', config, secrets);

    expect(token).toBe('new-access');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://auth.example.com/token',
      expect.objectContaining({ method: 'POST' }),
    );

    // Verify the body contains the correct params
    const body = mockFetch.mock.calls[0][1].body;
    const params = new URLSearchParams(body);
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe('rt-abc');
    expect(params.get('client_id')).toBe('my-client');
  });

  it('throws when no refresh token is available', async () => {
    const secrets = createMockSecrets();
    await expect(refreshToken('srv', config, secrets)).rejects.toThrow(
      'No refresh token available',
    );
  });

  it('stores refreshed tokens atomically via secrets.set()', async () => {
    const secrets = createMockSecrets();
    secrets._store.set('mcp/srv/refresh_token', 'rt-old');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'new-at',
          refresh_token: 'new-rt',
          expires_in: 7200,
        }),
      }),
    );

    await refreshToken('srv', config, secrets);

    expect(secrets.set).toHaveBeenCalledWith('mcp/srv/access_token', 'new-at');
    expect(secrets.set).toHaveBeenCalledWith('mcp/srv/refresh_token', 'new-rt');
    // expires_at should be set
    const expiresCall = secrets.set.mock.calls.find(
      (c: [string, string]) => c[0] === 'mcp/srv/expires_at',
    );
    expect(expiresCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

describe('exchangeCode', () => {
  const config: OAuthConfig = {
    authorization_endpoint: 'https://auth.example.com/authorize',
    token_endpoint: 'https://auth.example.com/token',
    client_id: 'my-client',
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends code and verifier to token endpoint', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'at-xyz', expires_in: 3600 }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await exchangeCode(config, 'auth-code', 'http://127.0.0.1:8080', 'verifier-123');

    expect(result.access_token).toBe('at-xyz');
    expect(result.expires_at).toBeDefined();

    const body = mockFetch.mock.calls[0][1].body;
    const params = new URLSearchParams(body);
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('code')).toBe('auth-code');
    expect(params.get('code_verifier')).toBe('verifier-123');
    expect(params.get('redirect_uri')).toBe('http://127.0.0.1:8080');
  });

  it('throws on non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'invalid_grant',
      }),
    );

    await expect(exchangeCode(config, 'bad', 'http://x', 'v')).rejects.toThrow(
      'Token exchange failed (400)',
    );
  });
});

// ---------------------------------------------------------------------------
// Callback server
// ---------------------------------------------------------------------------

describe('startCallbackServer', () => {
  it('starts on a random port and resolves code from query param', async () => {
    const { port, resultPromise, close } = await startCallbackServer();
    expect(port).toBeGreaterThan(0);

    // Register state before simulating callback
    registerOAuthState('st');

    // Simulate the OAuth callback on the correct path
    const resp = await fetch(`http://127.0.0.1:${port}/oauth/callback?code=test-code&state=st`);
    expect(resp.status).toBe(200);

    const result = await resultPromise;
    expect(result.code).toBe('test-code');
    expect(result.state).toBe('st');
    close();
  });

  it('rejects on error parameter', async () => {
    const { port, resultPromise, close } = await startCallbackServer();

    // Attach rejection handler before triggering the error to prevent unhandled rejection warning
    const rejection = resultPromise.catch((err: unknown) => err);

    await fetch(`http://127.0.0.1:${port}/oauth/callback?error=access_denied`);

    const err = await rejection;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('OAuth error: access_denied');
    close();
  });

  it('rejects non-GET methods', async () => {
    const { port, close } = await startCallbackServer();

    const resp = await fetch(`http://127.0.0.1:${port}/oauth/callback?code=x&state=s`, {
      method: 'POST',
    });
    expect(resp.status).toBe(405);
    close();
  });

  it('rejects requests to wrong path', async () => {
    const { port, close } = await startCallbackServer();

    const resp = await fetch(`http://127.0.0.1:${port}/?code=x&state=s`);
    expect(resp.status).toBe(404);
    close();
  });

  it('rejects requests with invalid state', async () => {
    const { port, close } = await startCallbackServer();

    const resp = await fetch(
      `http://127.0.0.1:${port}/oauth/callback?code=test-code&state=bad-state`,
    );
    expect(resp.status).toBe(400);
    close();
  });

  it('provides redirectUri with callback path', async () => {
    const { port, redirectUri, close } = await startCallbackServer();
    expect(redirectUri).toBe(`http://127.0.0.1:${port}/oauth/callback`);
    close();
  });
});

describe('OAuth state management', () => {
  it('registerOAuthState + consumeOAuthState roundtrip', () => {
    registerOAuthState('test-state-1');
    expect(consumeOAuthState('test-state-1')).toBe(true);
  });

  it('state is single-use', () => {
    registerOAuthState('test-state-2');
    expect(consumeOAuthState('test-state-2')).toBe(true);
    expect(consumeOAuthState('test-state-2')).toBe(false);
  });

  it('rejects unknown state', () => {
    expect(consumeOAuthState('never-registered')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TOCTOU discipline verification
// ---------------------------------------------------------------------------

describe('TOCTOU safety', () => {
  it('refreshToken uses single get() call without exists() check', async () => {
    const secrets = createMockSecrets();
    secrets._store.set('mcp/srv/refresh_token', 'rt');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: 'new' }),
      }),
    );

    await refreshToken(
      'srv',
      {
        authorization_endpoint: 'https://a/authorize',
        token_endpoint: 'https://a/token',
        client_id: 'c',
      },
      secrets,
    );

    // Verify only get() was called for the refresh token — no list() or exists() pattern
    const getCalls = secrets.get.mock.calls.map((c: [string]) => c[0]);
    expect(getCalls).toContain('mcp/srv/refresh_token');
    // No list() calls that would indicate an exists-then-get pattern
    expect(secrets.list).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('isTokenExpired uses single get() for expires_at', async () => {
    const secrets = createMockSecrets();
    secrets._store.set('mcp/srv/expires_at', '2099-01-01T00:00:00.000Z');

    await isTokenExpired('srv', secrets);

    expect(secrets.get).toHaveBeenCalledTimes(1);
    expect(secrets.get).toHaveBeenCalledWith('mcp/srv/expires_at');
  });
});

// ---------------------------------------------------------------------------
// Coalesced refresh (plan hermes-0.21.4-fixes §5.4). Every test uses a distinct
// refresh-token string, so the process-wide flight map needs no reset hook.
// ---------------------------------------------------------------------------

describe('refreshToken — coalesced refresh', () => {
  const config: OAuthConfig = {
    authorization_endpoint: 'https://auth.example.com/authorize',
    token_endpoint: 'https://auth.example.com/token',
    client_id: 'my-client',
  };

  /** A fetch stub that holds every request until `release()` is called. */
  function gatedFetch(respond: (refreshToken: string | null) => Response | object) {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const mock = vi.fn(async (_url: string, init: { body: string }) => {
      await gate;
      return respond(new URLSearchParams(init.body).get('refresh_token'));
    });
    vi.stubGlobal('fetch', mock);
    return { mock, release: () => open() };
  }

  function okResponse(body: Record<string, unknown>) {
    return { ok: true, status: 200, json: async () => body, text: async () => '' };
  }

  /** Resolver whose store is the given backing map (models one vault behind several resolvers). */
  function secretsOver(store: Map<string, string>) {
    return {
      get: vi.fn(async (ref: string) => store.get(ref) ?? null),
      set: vi.fn(async (ref: string, value: string) => {
        store.set(ref, value);
      }),
      delete: vi.fn(async (ref: string) => {
        store.delete(ref);
      }),
      list: vi.fn(async () => [...store.keys()]),
    };
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('two concurrent calls on one resolver make one refresh', async () => {
    const secrets = createMockSecrets();
    secrets._store.set('mcp/srv/refresh_token', 'rt-coalesce-one');
    const { mock, release } = gatedFetch(() =>
      okResponse({ access_token: 'at-one', refresh_token: 'rt-coalesce-one-2', expires_in: 60 }),
    );

    const a = refreshToken('srv', config, secrets);
    const b = refreshToken('srv', config, secrets);
    release();

    await expect(Promise.all([a, b])).resolves.toEqual(['at-one', 'at-one']);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(secrets._store.get('mcp/srv/refresh_token')).toBe('rt-coalesce-one-2');
    expect(secrets._store.get('mcp/srv/access_token')).toBe('at-one');
  });

  it('two resolver instances over one vault (two bots) make one refresh', async () => {
    const vault = new Map([['mcp/srv/refresh_token', 'rt-two-bots']]);
    const botA = secretsOver(vault);
    const botB = secretsOver(vault);
    const { mock, release } = gatedFetch(() =>
      okResponse({ access_token: 'at-bots', refresh_token: 'rt-two-bots-2' }),
    );

    const a = refreshToken('srv', config, botA);
    const b = refreshToken('srv', config, botB);
    release();

    await expect(Promise.all([a, b])).resolves.toEqual(['at-bots', 'at-bots']);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(vault.get('mcp/srv/refresh_token')).toBe('rt-two-bots-2');
  });

  it('two personalities with different refresh tokens for one server never share a refresh', async () => {
    const alice = createMockSecrets();
    alice._store.set('mcp/srv/refresh_token', 'rt-alice');
    const bob = createMockSecrets();
    bob._store.set('mcp/srv/refresh_token', 'rt-bob');
    const { mock, release } = gatedFetch((rt) =>
      okResponse({ access_token: `at-for-${rt}`, refresh_token: `${rt}-2` }),
    );

    const a = refreshToken('srv', config, alice);
    const b = refreshToken('srv', config, bob);
    release();

    await expect(Promise.all([a, b])).resolves.toEqual(['at-for-rt-alice', 'at-for-rt-bob']);
    expect(mock).toHaveBeenCalledTimes(2);
    expect(alice._store.get('mcp/srv/access_token')).toBe('at-for-rt-alice');
    expect(alice._store.get('mcp/srv/refresh_token')).toBe('rt-alice-2');
    expect(bob._store.get('mcp/srv/access_token')).toBe('at-for-rt-bob');
    expect(bob._store.get('mcp/srv/refresh_token')).toBe('rt-bob-2');
    expect([...alice._store.values()].some((v) => v.includes('bob'))).toBe(false);
    expect([...bob._store.values()].some((v) => v.includes('alice'))).toBe(false);
  });

  it('a failed shared refresh rejects every caller, stores nothing, and the next call retries', async () => {
    const secrets = createMockSecrets();
    secrets._store.set('mcp/srv/refresh_token', 'rt-fails');
    // Bound grant: an unbound one would write a migration binding on first refresh.
    secrets._store.set(
      'mcp/srv/token_binding',
      JSON.stringify({ v: 1, token_endpoint: config.token_endpoint }),
    );
    const { mock, release } = gatedFetch(() => ({
      ok: false,
      status: 400,
      text: async () => 'invalid_grant',
      json: async () => ({}),
    }));

    const a = refreshToken('srv', config, secrets);
    const b = refreshToken('srv', config, secrets);
    release();

    await expect(a).rejects.toThrow('Token refresh failed (400)');
    await expect(b).rejects.toThrow('Token refresh failed (400)');
    expect(mock).toHaveBeenCalledTimes(1);
    expect(secrets.set).not.toHaveBeenCalled();

    await expect(refreshToken('srv', config, secrets)).rejects.toThrow(
      'Token refresh failed (400)',
    );
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('a late joiner within the reuse window gets the new token without a second fetch', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const leader = createMockSecrets();
    leader._store.set('mcp/srv/refresh_token', 'rt-late');
    const { mock, release } = gatedFetch(() =>
      okResponse({ access_token: 'at-late', refresh_token: 'rt-late-2', expires_in: 60 }),
    );
    release();

    await expect(refreshToken('srv', config, leader)).resolves.toBe('at-late');
    expect(mock).toHaveBeenCalledTimes(1);

    // A caller that read the old token just before the rotation (its vault still holds it).
    const late = createMockSecrets();
    late._store.set('mcp/srv/refresh_token', 'rt-late');
    await expect(refreshToken('srv', config, late)).resolves.toBe('at-late');
    expect(mock).toHaveBeenCalledTimes(1);
    // Its token still matched, so it stores — it never keeps a spent refresh token.
    expect(late._store.get('mcp/srv/refresh_token')).toBe('rt-late-2');
    expect(late._store.get('mcp/srv/access_token')).toBe('at-late');
    expect(late._store.get('mcp/srv/expires_at')).toBe(leader._store.get('mcp/srv/expires_at'));

    // Past the window the entry is gone, so the same old token fetches again.
    vi.advanceTimersByTime(30_001);
    const afterWindow = createMockSecrets();
    afterWindow._store.set('mcp/srv/refresh_token', 'rt-late');
    await refreshToken('srv', config, afterWindow);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('a joiner whose vault no longer holds the presented token stores nothing', async () => {
    const vault = new Map([
      ['mcp/srv/refresh_token', 'rt-moved'],
      ['mcp/srv/token_binding', JSON.stringify({ v: 1, token_endpoint: config.token_endpoint })],
    ]);
    const leader = secretsOver(vault);
    const { release } = gatedFetch(() =>
      okResponse({ access_token: 'at-moved', refresh_token: 'rt-moved-2' }),
    );
    release();
    await refreshToken('srv', config, leader);

    // Same vault, but this resolver started from the old token (read before the leader stored).
    const joiner = secretsOver(vault);
    let staleRead = true;
    joiner.get.mockImplementation(async (ref: string) => {
      if (ref === 'mcp/srv/refresh_token' && staleRead) {
        staleRead = false;
        return 'rt-moved';
      }
      return vault.get(ref) ?? null;
    });
    await expect(refreshToken('srv', config, joiner)).resolves.toBe('at-moved');
    expect(joiner.set).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Paste-the-redirect (plan mcp-device-code-login §5)
// ---------------------------------------------------------------------------

describe('parsePastedRedirect', () => {
  const REDIRECT = 'http://127.0.0.1:43210/oauth/callback';
  const parse = (s: string) => parsePastedRedirect(s, { expectedRedirectUri: REDIRECT });

  it('accepts the registered loopback URL and extracts code, state, iss', () => {
    expect(parse(`  ${REDIRECT}?code=c1&state=s1&iss=https%3A%2F%2Fas.example.com \n`)).toEqual({
      code: 'c1',
      state: 's1',
      iss: 'https://as.example.com',
    });
    expect(parse(`${REDIRECT}?code=c1&state=s1`)).toEqual({ code: 'c1', state: 's1' });
  });

  it('refuses another host, another path, an https origin and an over-long string', () => {
    for (const bad of [
      'http://127.0.0.1:43211/oauth/callback?code=c&state=s',
      'http://localhost:43210/oauth/callback?code=c&state=s',
      'https://evil.example.com/oauth/callback?code=c&state=s',
      'http://127.0.0.1:43210/other?code=c&state=s',
      'https://127.0.0.1:43210/oauth/callback?code=c&state=s',
      `${REDIRECT}?code=${'a'.repeat(5000)}&state=s`,
      'not a url',
      '',
      `${REDIRECT}?state=s`,
    ]) {
      expect(() => parse(bad), bad.slice(0, 60)).toThrow(PastedRedirectError);
    }
  });

  it('accepts a localhost registration when localhost is what was registered', () => {
    expect(
      parsePastedRedirect('http://localhost:9/oauth/callback?code=c&state=s', {
        expectedRedirectUri: 'http://localhost:9/oauth/callback',
      }),
    ).toEqual({ code: 'c', state: 's' });
  });

  it('surfaces error=access_denied as a refusal', () => {
    expect(() => parse(`${REDIRECT}?error=access_denied&state=s`)).toThrow(
      expect.objectContaining({ code: 'access_denied' }),
    );
    expect(() => parse(`${REDIRECT}?error=server_error&error_description=SECRET`)).toThrow(
      expect.objectContaining({ code: 'provider_error' }),
    );
  });

  it('never echoes the pasted text in the error message', () => {
    try {
      parse('https://evil.example.com/cb?code=SECRET-CODE&state=SECRET-STATE');
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain('SECRET');
    }
  });
});

describe('runPkceLogin — paste', () => {
  const realFetch = globalThis.fetch;
  const config: OAuthConfig = {
    authorization_endpoint: 'https://auth.example.com/authorize',
    token_endpoint: 'https://auth.example.com/token',
    client_id: 'my-client',
  };
  let tokenCalls: URLSearchParams[];

  beforeEach(() => {
    tokenCalls = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://auth.example.com/token') {
        tokenCalls.push(new URLSearchParams(String(init?.body)));
        return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return realFetch(input, init);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** onAuthUrl + a `pasted` promise the test settles after seeing the authorize URL. */
  function pasteHarness(build: (redirectUri: string, state: string) => string) {
    let resolvePaste!: (s: string) => void;
    const pasted = new Promise<string>((r) => {
      resolvePaste = r;
    });
    const seen: { redirectUri?: string } = {};
    return {
      seen,
      opts: {
        pasted,
        onAuthUrl: (authUrl: string) => {
          const u = new URL(authUrl);
          seen.redirectUri = u.searchParams.get('redirect_uri') ?? '';
          resolvePaste(build(seen.redirectUri, u.searchParams.get('state') ?? ''));
        },
      },
    };
  }

  it('completes from a paste and closes the listener', async () => {
    const secrets = createMockSecrets();
    const h = pasteHarness((r, state) => `${r}?code=pasted-code&state=${state}`);
    const tokens = await runPkceLogin('srv', config, secrets, h.opts);

    expect(tokens.access_token).toBe('at');
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]?.get('code')).toBe('pasted-code');
    expect(tokenCalls[0]?.get('redirect_uri')).toBe(h.seen.redirectUri);
    expect(secrets._store.get('mcp/srv/access_token')).toBe('at');
    expect(JSON.parse(secrets._store.get('mcp/srv/token_binding') ?? '{}')).toMatchObject({
      token_endpoint: config.token_endpoint,
    });
    await expect(realFetch(h.seen.redirectUri ?? '')).rejects.toThrow(); // listener is closed
  });

  it('a pasted state mismatch makes no token request', async () => {
    const secrets = createMockSecrets();
    const h = pasteHarness((r) => `${r}?code=c&state=forged`);
    await expect(runPkceLogin('srv', config, secrets, h.opts)).rejects.toBeInstanceOf(
      PastedRedirectError,
    );
    expect(tokenCalls).toHaveLength(0);
    expect(secrets._store.size).toBe(0);
  });

  it('a pasted iss mismatch is refused (B1 helper)', async () => {
    const secrets = createMockSecrets();
    const h = pasteHarness(
      (r, state) =>
        `${r}?code=c&state=${state}&iss=${encodeURIComponent('https://evil.example.com')}`,
    );
    await expect(
      runPkceLogin('srv', { ...config, issuer: 'https://auth.example.com' }, secrets, h.opts),
    ).rejects.toBeInstanceOf(OAuthIssuerMismatch);
    expect(tokenCalls).toHaveLength(0);
  });
});

describe('MissingToken', () => {
  it('points at /mcp login for a chat-only owner', () => {
    expect(new MissingToken('linear').message).toContain('/mcp login <name>');
  });
});
