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
