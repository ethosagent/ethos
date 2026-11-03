// Tests for the refresh-token issuer binding (plan hermes-0.22-hardening §4).
// Each case uses its own refresh-token string: refreshFlights is process-wide
// and has no reset helper (same convention as the coalescing tests in oauth.test.ts).

import { PersonalityScopedSecrets } from '@ethosagent/storage-fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OAuthConfig, TokenBinding } from '../oauth';
import {
  deleteTokens,
  OAuthBindingMismatch,
  refreshToken,
  revokeToken,
  storeTokens,
} from '../oauth';

// Route safeFetch to the global fetch stub (see oauth.test.ts for the rationale).
vi.mock('@ethosagent/safety-network', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ethosagent/safety-network')>();
  return {
    ...actual,
    safeFetch: (url: string, opts: Parameters<typeof actual.safeFetch>[1]) =>
      actual.safeFetch(url, { ...opts, fetchImpl: (input, init) => globalThis.fetch(input, init) }),
  };
});

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
      return prefix ? all.filter((k) => k.startsWith(prefix)) : all;
    }),
    _store: store,
  };
}

const BOUND: OAuthConfig = {
  authorization_endpoint: 'https://auth.example.com/authorize',
  token_endpoint: 'https://auth.example.com/token',
  client_id: 'client-1',
  issuer: 'https://auth.example.com',
};

const BINDING: TokenBinding = {
  v: 1,
  token_endpoint: 'https://auth.example.com/token',
  issuer: 'https://auth.example.com',
};

function stubFetch(body: Record<string, unknown> = { access_token: 'at-new' }) {
  const mock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => '',
  }));
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('token binding', () => {
  it('storeTokens writes a binding for the token endpoint and issuer', async () => {
    const secrets = createMockSecrets();
    await storeTokens(
      'srv',
      { access_token: 'a', refresh_token: 'rt-bind-write' },
      secrets,
      BINDING,
    );
    expect(JSON.parse(secrets._store.get('mcp/srv/token_binding') ?? 'null')).toEqual(BINDING);
  });

  it('a refresh against the bound endpoint proceeds and keeps the binding after rotation', async () => {
    const secrets = createMockSecrets();
    await storeTokens('srv', { access_token: 'a', refresh_token: 'rt-bound-ok' }, secrets, BINDING);
    const mock = stubFetch({ access_token: 'at-2', refresh_token: 'rt-bound-ok-2' });

    await expect(refreshToken('srv', BOUND, secrets)).resolves.toBe('at-2');

    expect(mock).toHaveBeenCalledTimes(1);
    expect(secrets._store.get('mcp/srv/refresh_token')).toBe('rt-bound-ok-2');
    expect(JSON.parse(secrets._store.get('mcp/srv/token_binding') ?? 'null')).toEqual(BINDING);
  });

  it('a refresh after token_endpoint changes is refused before any request is made', async () => {
    const secrets = createMockSecrets();
    await storeTokens(
      'srv',
      { access_token: 'a', refresh_token: 'rt-moved-ep', expires_at: '2030-01-01T00:00:00.000Z' },
      secrets,
      BINDING,
    );
    const mock = stubFetch();

    const err = await refreshToken(
      'srv',
      { ...BOUND, token_endpoint: 'https://evil.example.com/token' },
      secrets,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OAuthBindingMismatch);
    expect((err as Error).message).toContain('ethos mcp login srv');
    expect((err as Error).message).toContain('evil.example.com');
    // A request started before the check would still be inside the async
    // SSRF/DNS step when the rejection lands; let it reach fetch before asserting.
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(mock).not.toHaveBeenCalled();
    expect(secrets._store.get('mcp/srv/access_token')).toBe('a');
    expect(secrets._store.get('mcp/srv/refresh_token')).toBe('rt-moved-ep');
    expect(secrets._store.get('mcp/srv/expires_at')).toBe('2030-01-01T00:00:00.000Z');
  });

  it('a refresh after issuer changes is refused', async () => {
    const secrets = createMockSecrets();
    await storeTokens(
      'srv',
      { access_token: 'a', refresh_token: 'rt-moved-iss' },
      secrets,
      BINDING,
    );
    const mock = stubFetch();

    await expect(
      refreshToken('srv', { ...BOUND, issuer: 'https://other-issuer.example.com' }, secrets),
    ).rejects.toBeInstanceOf(OAuthBindingMismatch);
    expect(mock).not.toHaveBeenCalled();
  });

  it('the binding is checked before joining an in-flight refresh', async () => {
    const secrets = createMockSecrets();
    await storeTokens(
      'srv',
      { access_token: 'a', refresh_token: 'rt-flight-join' },
      secrets,
      BINDING,
    );
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const mock = vi.fn(async () => {
      await gate;
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'at-flight' }),
        text: async () => '',
      };
    });
    vi.stubGlobal('fetch', mock);

    const leader = refreshToken('srv', BOUND, secrets);
    // Same refresh token, different endpoint: would key differently, but a
    // mismatched caller must be refused by the binding, not by the flight map.
    const intruder = refreshToken(
      'srv',
      { ...BOUND, token_endpoint: 'https://evil.example.com/token' },
      secrets,
    );
    await expect(intruder).rejects.toBeInstanceOf(OAuthBindingMismatch);
    open();
    await expect(leader).resolves.toBe('at-flight');
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('an unbound grant with same-origin https endpoints is bound on first refresh without re-auth', async () => {
    const secrets = createMockSecrets();
    secrets._store.set('mcp/srv/refresh_token', 'rt-legacy-ok');
    const warn = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), child: () => logger };
    const mock = stubFetch();

    await expect(refreshToken('srv', BOUND, secrets, logger)).resolves.toBe('at-new');

    expect(mock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(secrets._store.get('mcp/srv/token_binding') ?? 'null')).toEqual({
      v: 1,
      token_endpoint: BOUND.token_endpoint,
      issuer: BOUND.issuer,
    });
    expect(warn).toHaveBeenCalledWith(
      'mcp.oauth.binding_migrated',
      expect.objectContaining({ component: 'tools-mcp', event: 'mcp.oauth.binding_migrated' }),
    );
  });

  it('an unbound grant whose token endpoint origin differs from the authorization endpoint is refused', async () => {
    const secrets = createMockSecrets();
    secrets._store.set('mcp/srv/refresh_token', 'rt-legacy-bad');
    const mock = stubFetch();

    await expect(
      refreshToken(
        'srv',
        { ...BOUND, token_endpoint: 'https://tokens.other.example.com/token' },
        secrets,
      ),
    ).rejects.toBeInstanceOf(OAuthBindingMismatch);

    expect(mock).not.toHaveBeenCalled();
    expect(secrets._store.has('mcp/srv/token_binding')).toBe(false);
    expect(secrets._store.get('mcp/srv/refresh_token')).toBe('rt-legacy-bad');
  });

  it('deleteTokens removes the binding', async () => {
    const secrets = createMockSecrets();
    await storeTokens('srv', { access_token: 'a', refresh_token: 'rt-del' }, secrets, BINDING);
    await deleteTokens('srv', secrets);
    expect([...secrets._store.keys()]).toEqual([]);
  });

  it("two personalities' bindings for one server name are independent", async () => {
    const base = createMockSecrets();
    const alice = new PersonalityScopedSecrets(base, 'alice');
    const bob = new PersonalityScopedSecrets(base, 'bob');
    await storeTokens('srv', { access_token: 'a1', refresh_token: 'rt-alice-ind' }, alice, BINDING);
    await storeTokens('srv', { access_token: 'b1', refresh_token: 'rt-bob-ind' }, bob, {
      v: 1,
      token_endpoint: 'https://bob-auth.example.com/token',
    });
    const mock = stubFetch();

    // Alice's config still matches her binding; Bob's binding names another endpoint.
    await expect(refreshToken('srv', BOUND, alice)).resolves.toBe('at-new');
    await expect(refreshToken('srv', BOUND, bob)).rejects.toBeInstanceOf(OAuthBindingMismatch);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(base._store.get('personalities/bob/mcp/srv/refresh_token')).toBe('rt-bob-ind');
  });

  it('storeTokens clears the old refresh token before writing the binding and tokens', async () => {
    const secrets = createMockSecrets();
    secrets._store.set('mcp/srv/refresh_token', 'rt-old');
    await storeTokens('srv', { access_token: 'a2' }, secrets, BINDING);
    expect(secrets._store.has('mcp/srv/refresh_token')).toBe(false);
    const deleteOrder = secrets.delete.mock.invocationCallOrder[0] ?? 0;
    const bindingOrder = secrets.set.mock.invocationCallOrder[0] ?? 0;
    expect(deleteOrder).toBeLessThan(bindingOrder);
  });
});

describe('revokeToken binding gate', () => {
  const WITH_REVOCATION: OAuthConfig = {
    ...BOUND,
    revocation_endpoint: 'https://evil.example.net/revoke',
  };

  it('revokeToken does not send the token to a revocation endpoint off the bound origin', async () => {
    const secrets = createMockSecrets();
    await storeTokens('srv', { access_token: 'at-secret' }, secrets, BINDING);
    const mock = stubFetch();

    await revokeToken('srv', WITH_REVOCATION, secrets);

    expect(mock).not.toHaveBeenCalled();
    expect([...secrets._store.keys()]).toEqual([]);
  });

  it('revokeToken sends to a same-origin revocation endpoint', async () => {
    const secrets = createMockSecrets();
    await storeTokens('srv', { access_token: 'at-secret' }, secrets, BINDING);
    const mock = stubFetch();

    await revokeToken(
      'srv',
      { ...BOUND, revocation_endpoint: 'https://auth.example.com/revoke' },
      secrets,
    );

    expect(mock).toHaveBeenCalledTimes(1);
    expect([...secrets._store.keys()]).toEqual([]);
  });
});
