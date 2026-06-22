import { afterEach, describe, expect, it, vi } from 'vitest';
import { startDeviceCodeFlow } from '../device-code';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const DEVICE_AUTH_ENDPOINT = 'https://auth.example.com/device/code';
const TOKEN_ENDPOINT = 'https://auth.example.com/token';
const CLIENT_ID = 'test-client';

const VALID_DEVICE_AUTH = {
  device_code: 'dev_123',
  user_code: 'ABCD-EFGH',
  verification_uri: 'https://auth.example.com/activate',
  verification_uri_complete: 'https://auth.example.com/activate?user_code=ABCD-EFGH',
  expires_in: 900,
  interval: 0,
};

const VALID_TOKEN_RESPONSE = {
  access_token: 'at_abc',
  refresh_token: 'rt_xyz',
  token_type: 'Bearer',
  scope: 'read write',
  expires_in: 3600,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  mockFetch.mockReset();
});

describe('startDeviceCodeFlow', () => {
  it('sends correct device authorization request', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(VALID_DEVICE_AUTH))
      .mockResolvedValueOnce(jsonResponse(VALID_TOKEN_RESPONSE));

    const result = await startDeviceCodeFlow({
      deviceAuthorizationEndpoint: DEVICE_AUTH_ENDPOINT,
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: CLIENT_ID,
      scopes: ['read', 'write'],
    });

    await result.tokens;

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(DEVICE_AUTH_ENDPOINT);
    expect(init.method).toBe('POST');

    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');

    const body = new URLSearchParams(init.body as string);
    expect(body.get('client_id')).toBe(CLIENT_ID);
    expect(body.get('scope')).toBe('read write');
  });

  it('returns device auth response with user_code and verification_uri', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(VALID_DEVICE_AUTH))
      .mockResolvedValueOnce(jsonResponse(VALID_TOKEN_RESPONSE));

    const result = await startDeviceCodeFlow({
      deviceAuthorizationEndpoint: DEVICE_AUTH_ENDPOINT,
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: CLIENT_ID,
    });

    expect(result.deviceAuth.user_code).toBe('ABCD-EFGH');
    expect(result.deviceAuth.verification_uri).toBe('https://auth.example.com/activate');
    expect(result.deviceAuth.verification_uri_complete).toBe(
      'https://auth.example.com/activate?user_code=ABCD-EFGH',
    );
    expect(result.deviceAuth.device_code).toBe('dev_123');
    expect(result.deviceAuth.expires_in).toBe(900);

    await result.tokens;
  });

  it('polls token endpoint until success', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(VALID_DEVICE_AUTH))
      .mockResolvedValueOnce(jsonResponse({ error: 'authorization_pending' }))
      .mockResolvedValueOnce(jsonResponse(VALID_TOKEN_RESPONSE));

    const result = await startDeviceCodeFlow({
      deviceAuthorizationEndpoint: DEVICE_AUTH_ENDPOINT,
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: CLIENT_ID,
    });

    const tokens = await result.tokens;
    expect(tokens.access_token).toBe('at_abc');
    expect(tokens.refresh_token).toBe('rt_xyz');
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.scopes).toEqual(['read', 'write']);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('respects slow_down by increasing interval', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(VALID_DEVICE_AUTH))
      .mockResolvedValueOnce(jsonResponse({ error: 'slow_down' }))
      .mockResolvedValueOnce(jsonResponse(VALID_TOKEN_RESPONSE));

    const result = await startDeviceCodeFlow({
      deviceAuthorizationEndpoint: DEVICE_AUTH_ENDPOINT,
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: CLIENT_ID,
    });

    const tokens = await result.tokens;
    expect(tokens.access_token).toBe('at_abc');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('rejects on expired_token', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(VALID_DEVICE_AUTH))
      .mockResolvedValueOnce(jsonResponse({ error: 'expired_token' }));

    const result = await startDeviceCodeFlow({
      deviceAuthorizationEndpoint: DEVICE_AUTH_ENDPOINT,
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: CLIENT_ID,
    });

    await expect(result.tokens).rejects.toThrow('Device code expired');
  });

  it('rejects on access_denied', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(VALID_DEVICE_AUTH))
      .mockResolvedValueOnce(jsonResponse({ error: 'access_denied' }));

    const result = await startDeviceCodeFlow({
      deviceAuthorizationEndpoint: DEVICE_AUTH_ENDPOINT,
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: CLIENT_ID,
    });

    await expect(result.tokens).rejects.toThrow('Authorization denied by user');
  });

  it('aborts on signal', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(VALID_DEVICE_AUTH));

    const controller = new AbortController();
    controller.abort();

    const result = await startDeviceCodeFlow({
      deviceAuthorizationEndpoint: DEVICE_AUTH_ENDPOINT,
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: CLIENT_ID,
      signal: controller.signal,
    });

    await expect(result.tokens).rejects.toThrow('Device code flow aborted');
  });

  it('throws on invalid device auth response', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ device_code: 'x' }));

    await expect(
      startDeviceCodeFlow({
        deviceAuthorizationEndpoint: DEVICE_AUTH_ENDPOINT,
        tokenEndpoint: TOKEN_ENDPOINT,
        clientId: CLIENT_ID,
      }),
    ).rejects.toThrow('missing user_code');
  });
});
