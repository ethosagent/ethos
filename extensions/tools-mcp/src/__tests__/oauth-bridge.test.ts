import { describe, expect, it } from 'vitest';
import { mcpProfileFromDiscovery } from '../oauth-bridge';

describe('mcpProfileFromDiscovery', () => {
  it('builds a profile from discovery metadata', () => {
    const profile = mcpProfileFromDiscovery(
      'my-server',
      {
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
        registration_endpoint: 'https://auth.example.com/register',
        revocation_endpoint: 'https://auth.example.com/revoke',
        scopes_supported: ['read', 'write'],
      },
      'client-123',
    );

    expect(profile.id).toBe('mcp/my-server');
    expect(profile.flow).toEqual({ kind: 'authorization_code' });
    expect(profile.authorizationEndpoint).toBe('https://auth.example.com/authorize');
    expect(profile.tokenEndpoint).toBe('https://auth.example.com/token');
    expect(profile.revocationEndpoint).toBe('https://auth.example.com/revoke');
    expect(profile.registration).toEqual({
      kind: 'dcr',
      endpoint: 'https://auth.example.com/register',
    });
    expect(profile.scopes).toEqual(['read', 'write']);
    expect(profile.clientId).toBe('client-123');
    expect(profile.redirect).toEqual({ mode: 'loopback' });
    expect(profile.refreshable).toBe(true);
  });

  it('omits registration when no registration_endpoint', () => {
    const profile = mcpProfileFromDiscovery(
      'no-dcr',
      {
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
      },
      'client-456',
    );

    expect(profile.registration).toBeUndefined();
  });
});
