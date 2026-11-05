import type { SecretsResolver } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DcrRequest, OAuthConfig } from '../oauth';
import {
  ConfidentialClientUnsupported,
  ensureValidToken,
  MissingToken,
  OAuthIssuerMismatch,
  registerOAuthClient,
  runDcrAuthorization,
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

describe('registerOAuthClient', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function jsonResponse(data: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => data,
      text: async () => JSON.stringify(data),
    } as Response;
  }

  function errorResponse(status: number, body = `Error ${status}`): Response {
    return {
      ok: false,
      status,
      json: async () => ({}),
      text: async () => body,
    } as Response;
  }

  const baseDcrRequest: DcrRequest = {
    redirect_uris: ['http://127.0.0.1:9999'],
    client_name: 'ethos',
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: 'read write',
  };

  it('returns DcrResponse on successful registration without client_secret', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        client_id: 'new-client-abc',
      }),
    );

    const result = await registerOAuthClient('https://auth.example.com/register', baseDcrRequest);

    expect(result.client_id).toBe('new-client-abc');
    expect(result.client_secret).toBeUndefined();
    // Verify fetch was called with the registration endpoint URL (safeFetch adds redirect:'manual')
    expect(mockFetch).toHaveBeenCalledWith(
      'https://auth.example.com/register',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(baseDcrRequest),
      }),
    );
  });

  it('throws ConfidentialClientUnsupported when server returns client_secret', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        client_id: 'confidential-client',
        client_secret: 'super-secret',
      }),
    );

    await expect(
      registerOAuthClient('https://auth.example.com/register', baseDcrRequest),
    ).rejects.toThrow(ConfidentialClientUnsupported);
  });

  it('throws an error with status code when registration endpoint returns 4xx/5xx', async () => {
    mockFetch.mockResolvedValue(errorResponse(403, 'Forbidden'));

    try {
      await registerOAuthClient('https://auth.example.com/register', baseDcrRequest);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('403');
    }
  });

  it('throws when response is missing client_id', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}));

    await expect(
      registerOAuthClient('https://auth.example.com/register', baseDcrRequest),
    ).rejects.toThrow('Dynamic client registration response missing required client_id');
  });

  it('preserves all optional fields in the response', async () => {
    const fullResponse = {
      client_id: 'full-client-xyz',
      client_id_issued_at: 1716100000,
      registration_access_token: 'reg-token-abc',
      registration_client_uri: 'https://auth.example.com/register/full-client-xyz',
    };

    mockFetch.mockResolvedValue(jsonResponse(fullResponse));

    const result = await registerOAuthClient('https://auth.example.com/register', baseDcrRequest);

    expect(result.client_id).toBe('full-client-xyz');
    expect(result.client_id_issued_at).toBe(1716100000);
    expect(result.registration_access_token).toBe('reg-token-abc');
    expect(result.registration_client_uri).toBe(
      'https://auth.example.com/register/full-client-xyz',
    );
  });
});

describe('ensureValidToken with UI context', () => {
  it('throws MissingToken when no token exists and context is ui', async () => {
    const secrets: SecretsResolver = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn(),
      delete: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
    };
    const config: OAuthConfig = {
      authorization_endpoint: 'https://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/token',
      client_id: 'test-client',
    };

    await expect(ensureValidToken('test-server', config, secrets, 'ui')).rejects.toThrow(
      MissingToken,
    );

    try {
      await ensureValidToken('test-server', config, secrets, 'ui');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingToken);
      expect((err as MissingToken).serverName).toBe('test-server');
    }
  });
});

// ---------------------------------------------------------------------------
// runDcrAuthorization — redirect URI + RFC 9207 iss (plan hermes-0.22-hardening §4)
// ---------------------------------------------------------------------------

describe('runDcrAuthorization', () => {
  const realFetch = globalThis.fetch;
  const MCP_URL = 'https://mcp.dcr.example.com/mcp';
  const AS_META = 'https://mcp.dcr.example.com/.well-known/oauth-authorization-server';
  const PR_META = 'https://mcp.dcr.example.com/.well-known/oauth-protected-resource/mcp';

  function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  /**
   * Stubs the discovery / DCR / token endpoints; requests to the loopback
   * callback server go to the real fetch. `onAuthorize` plays the browser.
   */
  function script(meta: Record<string, unknown>) {
    const seen: {
      dcrBody?: { redirect_uris: string[]; grant_types?: string[] };
      tokenBody?: URLSearchParams;
    } = {};
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('http://127.0.0.1')) return realFetch(input, init);
      if (url === PR_META) return new Response('nf', { status: 404 });
      if (url === AS_META) {
        return json({
          issuer: 'https://mcp.dcr.example.com',
          authorization_endpoint: 'https://mcp.dcr.example.com/authorize',
          token_endpoint: 'https://mcp.dcr.example.com/token',
          registration_endpoint: 'https://mcp.dcr.example.com/register',
          code_challenge_methods_supported: ['S256'],
          ...meta,
        });
      }
      if (url === 'https://mcp.dcr.example.com/register') {
        seen.dcrBody = JSON.parse(String(init?.body));
        return json({ client_id: 'dcr-client' }, 201);
      }
      if (url === 'https://mcp.dcr.example.com/token') {
        seen.tokenBody = new URLSearchParams(String(init?.body));
        return json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
      }
      return new Response('nf', { status: 404 });
    }) as typeof fetch;
    return seen;
  }

  /** Plays the browser: hits the redirect URI the authorize URL names, with `extra` params. */
  function browser(extra: Record<string, string>, captured: { authUrl?: string }) {
    return (authUrl: string) => {
      captured.authUrl = authUrl;
      const u = new URL(authUrl);
      const cb = new URL(u.searchParams.get('redirect_uri') ?? '');
      cb.searchParams.set('code', 'code-1');
      cb.searchParams.set('state', u.searchParams.get('state') ?? '');
      for (const [k, v] of Object.entries(extra)) cb.searchParams.set(k, v);
      void realFetch(cb.toString());
    };
  }

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('runDcrAuthorization registers the redirect URI the callback server serves', async () => {
    const seen = script({});
    const captured: { authUrl?: string } = {};

    const result = await runDcrAuthorization(MCP_URL, 'Ethos', browser({}, captured));

    const registered = seen.dcrBody?.redirect_uris[0] ?? '';
    expect(registered).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
    expect(new URL(captured.authUrl ?? '').searchParams.get('redirect_uri')).toBe(registered);
    expect(seen.tokenBody?.get('redirect_uri')).toBe(registered);
    expect(result.tokens.access_token).toBe('at');
    expect(result.oauthConfig.issuer).toBe('https://mcp.dcr.example.com');
  });

  it('a callback whose iss differs from the discovered issuer is rejected', async () => {
    const seen = script({});
    await expect(
      runDcrAuthorization(MCP_URL, 'Ethos', browser({ iss: 'https://evil.example.com' }, {})),
    ).rejects.toBeInstanceOf(OAuthIssuerMismatch);
    expect(seen.tokenBody).toBeUndefined();
  });

  it('a callback without iss is rejected when the metadata advertises iss support', async () => {
    const seen = script({ authorization_response_iss_parameter_supported: true });
    await expect(runDcrAuthorization(MCP_URL, 'Ethos', browser({}, {}))).rejects.toBeInstanceOf(
      OAuthIssuerMismatch,
    );
    expect(seen.tokenBody).toBeUndefined();
  });

  it('a callback without iss is accepted when the metadata does not advertise it', async () => {
    script({});
    await expect(runDcrAuthorization(MCP_URL, 'Ethos', browser({}, {}))).resolves.toMatchObject({
      tokens: { access_token: 'at' },
    });
  });

  it('runDcrAuthorization asks for the device grant only when discovery advertises the endpoint', async () => {
    const grant = 'urn:ietf:params:oauth:grant-type:device_code';
    const without = script({});
    await runDcrAuthorization(MCP_URL, 'Ethos', browser({}, {}));
    expect(without.dcrBody?.grant_types).toEqual(['authorization_code', 'refresh_token']);

    const withDevice = script({
      device_authorization_endpoint: 'https://mcp.dcr.example.com/device_authorization',
    });
    await runDcrAuthorization(MCP_URL, 'Ethos', browser({}, {}));
    expect(withDevice.dcrBody?.grant_types).toEqual(['authorization_code', 'refresh_token', grant]);
  });
});
