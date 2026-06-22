import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildRefreshParams,
  buildRevocationParams,
  buildTokenExchangeParams,
  isTokenExpired,
  parseTokenResponse,
} from '../token';

describe('parseTokenResponse', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('extracts access_token, refresh_token, and computes expires_at', () => {
    const result = parseTokenResponse({
      access_token: 'abc',
      refresh_token: 'def',
      expires_in: 3600,
    });
    expect(result.access_token).toBe('abc');
    expect(result.refresh_token).toBe('def');
    expect(result.expires_at).toBe(new Date('2025-01-01T01:00:00Z').toISOString());
  });

  it('throws on missing access_token', () => {
    expect(() => parseTokenResponse({ refresh_token: 'def' })).toThrow('missing access_token');
  });

  it('throws on non-object input', () => {
    expect(() => parseTokenResponse('not-an-object')).toThrow('must be an object');
    expect(() => parseTokenResponse(null)).toThrow('must be an object');
  });
});

describe('isTokenExpired', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns false when no expires_at', () => {
    expect(isTokenExpired({ access_token: 'abc' })).toBe(false);
  });

  it('returns true within buffer window', () => {
    const thirtySecondsFromNow = new Date('2025-01-01T00:00:30Z').toISOString();
    expect(isTokenExpired({ access_token: 'abc', expires_at: thirtySecondsFromNow })).toBe(true);
  });

  it('returns false when well outside buffer', () => {
    const twoHoursFromNow = new Date('2025-01-01T02:00:00Z').toISOString();
    expect(isTokenExpired({ access_token: 'abc', expires_at: twoHoursFromNow })).toBe(false);
  });
});

describe('buildTokenExchangeParams', () => {
  it('includes code_verifier and grant_type=authorization_code', () => {
    const { body } = buildTokenExchangeParams({
      code: 'auth-code',
      redirectUri: 'http://127.0.0.1:3000/callback',
      clientId: 'my-client',
      codeVerifier: 'my-verifier',
    });
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code_verifier')).toBe('my-verifier');
    expect(body.get('code')).toBe('auth-code');
  });

  it('sets Authorization header with client_secret_basic', () => {
    const { headers } = buildTokenExchangeParams({
      code: 'auth-code',
      redirectUri: 'http://127.0.0.1:3000/callback',
      clientId: 'my-client',
      codeVerifier: 'my-verifier',
      clientSecret: 'my-secret',
      clientAuth: 'client_secret_basic',
    });
    const expected = Buffer.from('my-client:my-secret').toString('base64');
    expect(headers.Authorization).toBe(`Basic ${expected}`);
  });

  it('puts client_secret in body with client_secret_post', () => {
    const { body, headers } = buildTokenExchangeParams({
      code: 'auth-code',
      redirectUri: 'http://127.0.0.1:3000/callback',
      clientId: 'my-client',
      codeVerifier: 'my-verifier',
      clientSecret: 'my-secret',
      clientAuth: 'client_secret_post',
    });
    expect(body.get('client_secret')).toBe('my-secret');
    expect(headers.Authorization).toBeUndefined();
  });

  it('throws for private_key_jwt auth', () => {
    expect(() =>
      buildTokenExchangeParams({
        code: 'auth-code',
        redirectUri: 'http://127.0.0.1:3000/callback',
        clientId: 'my-client',
        codeVerifier: 'my-verifier',
        clientSecret: 'my-secret',
        clientAuth: 'private_key_jwt',
      }),
    ).toThrow('private_key_jwt auth is not yet implemented');
  });

  it('throws for mtls auth', () => {
    expect(() =>
      buildTokenExchangeParams({
        code: 'auth-code',
        redirectUri: 'http://127.0.0.1:3000/callback',
        clientId: 'my-client',
        codeVerifier: 'my-verifier',
        clientSecret: 'my-secret',
        clientAuth: 'mtls',
      }),
    ).toThrow('mtls auth is not yet implemented');
  });

  it('throws for unknown auth method', () => {
    expect(() =>
      buildTokenExchangeParams({
        code: 'auth-code',
        redirectUri: 'http://127.0.0.1:3000/callback',
        clientId: 'my-client',
        codeVerifier: 'my-verifier',
        clientSecret: 'my-secret',
        clientAuth: 'invented_method',
      }),
    ).toThrow('Unknown client auth method: invented_method');
  });
});

describe('buildRefreshParams', () => {
  it('includes grant_type=refresh_token', () => {
    const { body } = buildRefreshParams({
      refreshToken: 'my-refresh',
      clientId: 'my-client',
    });
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('my-refresh');
  });
});

describe('buildRevocationParams', () => {
  it('includes token and token_type_hint', () => {
    const { body } = buildRevocationParams({
      token: 'my-token',
      clientId: 'my-client',
      tokenTypeHint: 'access_token',
    });
    expect(body.get('token')).toBe('my-token');
    expect(body.get('token_type_hint')).toBe('access_token');
    expect(body.get('client_id')).toBe('my-client');
  });
});
