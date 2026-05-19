import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverOAuthMetadata, OAuthDiscoveryError } from '../oauth';

describe('discoverOAuthMetadata', () => {
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

  function errorResponse(status: number): Response {
    return {
      ok: false,
      status,
      json: async () => ({}),
      text: async () => `Error ${status}`,
    } as Response;
  }

  it('returns metadata when protected-resource provides authorization_servers', async () => {
    const asMetadata = {
      authorization_endpoint: 'https://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/token',
      registration_endpoint: 'https://auth.example.com/register',
      scopes_supported: ['read', 'write'],
      code_challenge_methods_supported: ['S256'],
    };

    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/.well-known/oauth-protected-resource')) {
        return Promise.resolve(
          jsonResponse({ authorization_servers: ['https://auth.example.com'] }),
        );
      }
      if (url === 'https://auth.example.com/.well-known/oauth-authorization-server') {
        return Promise.resolve(jsonResponse(asMetadata));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    const result = await discoverOAuthMetadata('https://mcp.example.com/api');

    expect(result.authorization_endpoint).toBe('https://auth.example.com/authorize');
    expect(result.token_endpoint).toBe('https://auth.example.com/token');
    expect(result.registration_endpoint).toBe('https://auth.example.com/register');
    expect(result.scopes_supported).toEqual(['read', 'write']);
  });

  it('falls back to origin AS metadata when protected-resource returns 404', async () => {
    const asMetadata = {
      authorization_endpoint: 'https://mcp.example.com/authorize',
      token_endpoint: 'https://mcp.example.com/token',
    };

    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/.well-known/oauth-protected-resource')) {
        return Promise.resolve(errorResponse(404));
      }
      if (url === 'https://mcp.example.com/.well-known/oauth-authorization-server') {
        return Promise.resolve(jsonResponse(asMetadata));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    const result = await discoverOAuthMetadata('https://mcp.example.com/api');

    expect(result.authorization_endpoint).toBe('https://mcp.example.com/authorize');
    expect(result.token_endpoint).toBe('https://mcp.example.com/token');
  });

  it('throws OAuthDiscoveryError when AS metadata is missing required fields', async () => {
    const incomplete = {
      token_endpoint: 'https://mcp.example.com/token',
    };

    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/.well-known/oauth-protected-resource')) {
        return Promise.resolve(errorResponse(404));
      }
      if (url.includes('/.well-known/oauth-authorization-server')) {
        return Promise.resolve(jsonResponse(incomplete));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    await expect(discoverOAuthMetadata('https://mcp.example.com/api')).rejects.toThrow(
      OAuthDiscoveryError,
    );

    try {
      await discoverOAuthMetadata('https://mcp.example.com/api');
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthDiscoveryError);
      expect((err as OAuthDiscoveryError).message).toContain(
        'missing required authorization_endpoint',
      );
    }
  });

  it('throws OAuthDiscoveryError when S256 is not in code_challenge_methods_supported', async () => {
    const noS256 = {
      authorization_endpoint: 'https://mcp.example.com/authorize',
      token_endpoint: 'https://mcp.example.com/token',
      code_challenge_methods_supported: ['plain'],
    };

    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/.well-known/oauth-protected-resource')) {
        return Promise.resolve(errorResponse(404));
      }
      if (url.includes('/.well-known/oauth-authorization-server')) {
        return Promise.resolve(jsonResponse(noS256));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    try {
      await discoverOAuthMetadata('https://mcp.example.com/api');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthDiscoveryError);
      expect((err as OAuthDiscoveryError).message).toContain('S256');
    }
  });

  it('throws OAuthDiscoveryError with status: null when network errors occur', async () => {
    mockFetch.mockImplementation(() => {
      return Promise.reject(new TypeError('fetch failed'));
    });

    try {
      await discoverOAuthMetadata('https://mcp.example.com/api');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthDiscoveryError);
      const discovery = err as OAuthDiscoveryError;
      expect(discovery.attemptedUrls.length).toBeGreaterThanOrEqual(1);
      for (const entry of discovery.attemptedUrls) {
        expect(entry.status).toBeNull();
      }
    }
  });

  it('throws OAuthDiscoveryError when a discovered endpoint uses HTTP', async () => {
    const httpEndpoints = {
      authorization_endpoint: 'http://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/token',
    };

    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/.well-known/oauth-protected-resource')) {
        return Promise.resolve(errorResponse(404));
      }
      if (url.includes('/.well-known/oauth-authorization-server')) {
        return Promise.resolve(jsonResponse(httpEndpoints));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    try {
      await discoverOAuthMetadata('https://mcp.example.com/api');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthDiscoveryError);
      expect((err as OAuthDiscoveryError).message).toContain('insecure protocol');
    }
  });

  it('preserves resource path in well-known URLs per RFC 9728', async () => {
    const asMetadata = {
      authorization_endpoint: 'https://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/token',
      registration_endpoint: 'https://auth.example.com/register',
    };

    mockFetch.mockImplementation((url: string) => {
      if (url === 'https://mcp.example.com/.well-known/oauth-protected-resource/team/mcp') {
        return Promise.resolve(
          jsonResponse({ authorization_servers: ['https://auth.example.com'] }),
        );
      }
      if (url === 'https://auth.example.com/.well-known/oauth-authorization-server') {
        return Promise.resolve(jsonResponse(asMetadata));
      }
      return Promise.resolve(errorResponse(404));
    });

    const result = await discoverOAuthMetadata('https://mcp.example.com/team/mcp');
    expect(result.authorization_endpoint).toBe('https://auth.example.com/authorize');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://mcp.example.com/.well-known/oauth-protected-resource/team/mcp',
    );
  });

  it('preserves issuer path in AS metadata URL per RFC 8414', async () => {
    const asMetadata = {
      authorization_endpoint: 'https://auth.example.com/tenant/authorize',
      token_endpoint: 'https://auth.example.com/tenant/token',
    };

    mockFetch.mockImplementation((url: string) => {
      if (url === 'https://mcp.example.com/.well-known/oauth-protected-resource') {
        return Promise.resolve(
          jsonResponse({ authorization_servers: ['https://auth.example.com/tenant'] }),
        );
      }
      if (url === 'https://auth.example.com/.well-known/oauth-authorization-server/tenant') {
        return Promise.resolve(jsonResponse(asMetadata));
      }
      return Promise.resolve(errorResponse(404));
    });

    const result = await discoverOAuthMetadata('https://mcp.example.com');
    expect(result.authorization_endpoint).toBe('https://auth.example.com/tenant/authorize');
  });

  it('throws OAuthDiscoveryError with status captured when AS metadata returns 500', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/.well-known/oauth-protected-resource')) {
        return Promise.resolve(errorResponse(404));
      }
      if (url.includes('/.well-known/oauth-authorization-server')) {
        return Promise.resolve(errorResponse(500));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    try {
      await discoverOAuthMetadata('https://mcp.example.com/api');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthDiscoveryError);
      const discovery = err as OAuthDiscoveryError;
      const asEntry = discovery.attemptedUrls.find((u) =>
        u.url.includes('oauth-authorization-server'),
      );
      expect(asEntry).toBeDefined();
      expect(asEntry?.status).toBe(500);
    }
  });
});
