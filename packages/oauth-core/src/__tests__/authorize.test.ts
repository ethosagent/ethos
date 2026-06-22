import { describe, expect, it } from 'vitest';
import { buildAuthorizationUrl } from '../authorize';

describe('buildAuthorizationUrl', () => {
  const base = {
    authorizationEndpoint: 'https://auth.example.com/authorize',
    clientId: 'my-client',
    redirectUri: 'http://127.0.0.1:3000/callback',
    state: 'random-state',
    codeChallenge: 'challenge-value',
  };

  it('includes all required params', () => {
    const url = new URL(buildAuthorizationUrl(base));
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('my-client');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:3000/callback');
    expect(url.searchParams.get('state')).toBe('random-state');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-value');
  });

  it('always sets code_challenge_method to S256', () => {
    const url = new URL(buildAuthorizationUrl(base));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('joins scopes with spaces', () => {
    const url = new URL(buildAuthorizationUrl({ ...base, scopes: ['read', 'write', 'admin'] }));
    expect(url.searchParams.get('scope')).toBe('read write admin');
  });

  it('sets resource param for audience', () => {
    const url = new URL(buildAuthorizationUrl({ ...base, audience: 'https://api.example.com' }));
    expect(url.searchParams.get('resource')).toBe('https://api.example.com');
  });
});
