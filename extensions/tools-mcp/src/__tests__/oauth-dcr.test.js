import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConfidentialClientUnsupported,
  ensureValidToken,
  MissingToken,
  registerOAuthClient,
} from '../oauth';

describe('registerOAuthClient', () => {
  const mockFetch = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  function jsonResponse(data, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => data,
      text: async () => JSON.stringify(data),
    };
  }
  function errorResponse(status, body = `Error ${status}`) {
    return {
      ok: false,
      status,
      json: async () => ({}),
      text: async () => body,
    };
  }
  const baseDcrRequest = {
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
      expect(err.message).toContain('403');
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
    const secrets = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn(),
      delete: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
    };
    const config = {
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
      expect(err.serverName).toBe('test-server');
    }
  });
});
