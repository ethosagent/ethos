import { describe, expect, it } from 'vitest';
import {
  buildOAuthMetadataUrl,
  buildProtectedResourceMetadataUrl,
  parseOAuthServerMetadata,
  parseProtectedResourceMetadata,
} from '../discovery';

describe('buildOAuthMetadataUrl', () => {
  it('produces correct .well-known URL for root issuer', () => {
    expect(buildOAuthMetadataUrl('https://auth.example.com')).toBe(
      'https://auth.example.com/.well-known/oauth-authorization-server',
    );
  });

  it('handles path-based issuers', () => {
    expect(buildOAuthMetadataUrl('https://auth.example.com/tenant/123')).toBe(
      'https://auth.example.com/.well-known/oauth-authorization-server/tenant/123',
    );
  });
});

describe('buildProtectedResourceMetadataUrl', () => {
  it('produces correct .well-known URL', () => {
    expect(buildProtectedResourceMetadataUrl('https://api.example.com')).toBe(
      'https://api.example.com/.well-known/oauth-protected-resource',
    );
  });
});

describe('parseOAuthServerMetadata', () => {
  const validMetadata = {
    issuer: 'https://auth.example.com',
    authorization_endpoint: 'https://auth.example.com/authorize',
    token_endpoint: 'https://auth.example.com/token',
    registration_endpoint: 'https://auth.example.com/register',
    revocation_endpoint: 'https://auth.example.com/revoke',
    introspection_endpoint: 'https://auth.example.com/introspect',
    scopes_supported: ['openid', 'profile'],
    code_challenge_methods_supported: ['S256'],
    device_authorization_endpoint: 'https://auth.example.com/device',
  };

  it('extracts all fields from valid data', () => {
    const result = parseOAuthServerMetadata(validMetadata);
    expect(result).toEqual(validMetadata);
  });

  it('reads grant_types_supported', () => {
    const result = parseOAuthServerMetadata({
      ...validMetadata,
      grant_types_supported: ['authorization_code', 'urn:ietf:params:oauth:grant-type:device_code'],
    });
    expect(result.grant_types_supported).toEqual([
      'authorization_code',
      'urn:ietf:params:oauth:grant-type:device_code',
    ]);
    expect(parseOAuthServerMetadata(validMetadata).grant_types_supported).toBeUndefined();
  });

  it('throws on missing authorization_endpoint', () => {
    expect(() =>
      parseOAuthServerMetadata({ token_endpoint: 'https://auth.example.com/token' }),
    ).toThrow('authorization_endpoint');
  });

  it('throws on missing token_endpoint', () => {
    expect(() =>
      parseOAuthServerMetadata({
        authorization_endpoint: 'https://auth.example.com/authorize',
      }),
    ).toThrow('token_endpoint');
  });

  it('throws if S256 not in code_challenge_methods_supported', () => {
    expect(() =>
      parseOAuthServerMetadata({
        ...validMetadata,
        code_challenge_methods_supported: ['plain'],
      }),
    ).toThrow('S256');
  });

  it('rejects http: endpoints', () => {
    expect(() =>
      parseOAuthServerMetadata({
        ...validMetadata,
        authorization_endpoint: 'http://auth.example.com/authorize',
      }),
    ).toThrow('https:');
  });
});

describe('parseProtectedResourceMetadata', () => {
  it('extracts authorization_servers', () => {
    const result = parseProtectedResourceMetadata({
      resource: 'https://api.example.com',
      authorization_servers: ['https://auth.example.com'],
    });
    expect(result).toEqual({
      resource: 'https://api.example.com',
      authorization_servers: ['https://auth.example.com'],
    });
  });
});

describe('parseOAuthServerMetadata — RFC 9207', () => {
  const base = {
    authorization_endpoint: 'https://auth.example.com/authorize',
    token_endpoint: 'https://auth.example.com/token',
  };

  it('parseOAuthServerMetadata reads authorization_response_iss_parameter_supported', () => {
    expect(
      parseOAuthServerMetadata({ ...base, authorization_response_iss_parameter_supported: true })
        .authorization_response_iss_parameter_supported,
    ).toBe(true);
    expect(
      parseOAuthServerMetadata({ ...base, authorization_response_iss_parameter_supported: false })
        .authorization_response_iss_parameter_supported,
    ).toBe(false);
    expect(
      parseOAuthServerMetadata({ ...base, authorization_response_iss_parameter_supported: 'yes' })
        .authorization_response_iss_parameter_supported,
    ).toBeUndefined();
    expect(
      parseOAuthServerMetadata(base).authorization_response_iss_parameter_supported,
    ).toBeUndefined();
  });
});
