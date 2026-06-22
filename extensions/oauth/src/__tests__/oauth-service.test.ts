import type { CredentialRef, OAuthProviderProfile } from '@ethosagent/oauth-core';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultOAuthService } from '../oauth-service';
import { DefaultOAuthRegistry } from '../registry';
import { OAuthTokenStore } from '../token-store';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  });
}

const CC_PROFILE: OAuthProviderProfile = {
  id: 'test-cc',
  flow: { kind: 'client_credentials' },
  tokenEndpoint: 'https://auth.example.com/token',
  clientId: 'client-123',
  scopes: ['read'],
};

const REF: CredentialRef = {
  providerId: 'test-cc',
  personalityId: 'alice',
};

describe('DefaultOAuthService', () => {
  let tokenStore: OAuthTokenStore;
  let registry: DefaultOAuthRegistry;
  let fetcher: ReturnType<typeof vi.fn>;
  let service: DefaultOAuthService;

  beforeEach(() => {
    const storage = new InMemoryStorage();
    tokenStore = new OAuthTokenStore(storage, '/tokens');
    registry = new DefaultOAuthRegistry();
    fetcher = vi.fn();
    service = new DefaultOAuthService(
      tokenStore,
      registry,
      fetcher as unknown as (url: string, init: RequestInit) => Promise<Response>,
    );
  });

  it('authorize() with client_credentials stores tokens', async () => {
    fetcher.mockResolvedValueOnce(
      jsonResponse({ access_token: 'at_cc', token_type: 'bearer', expires_in: 3600 }),
    );

    await service.authorize(CC_PROFILE, REF);
    const token = await service.getAccessToken(REF);
    expect(token).toBe('at_cc');
  });

  it('getAccessToken() returns stored token', async () => {
    fetcher.mockResolvedValueOnce(
      jsonResponse({ access_token: 'at_stored', token_type: 'bearer', expires_in: 3600 }),
    );

    await service.authorize(CC_PROFILE, REF);
    const token = await service.getAccessToken(REF);
    expect(token).toBe('at_stored');
  });

  it('getAccessToken() auto-refreshes expired token', async () => {
    fetcher.mockResolvedValueOnce(
      jsonResponse({ access_token: 'at_initial', token_type: 'bearer', expires_in: 3600 }),
    );
    await service.authorize(CC_PROFILE, REF);

    await tokenStore.set(REF, {
      access_token: 'at_expired',
      refresh_token: 'rt_123',
      expires_at: '2020-01-01T00:00:00Z',
    });

    fetcher.mockResolvedValueOnce(
      jsonResponse({ access_token: 'at_refreshed', token_type: 'bearer' }),
    );

    const token = await service.getAccessToken(REF);
    expect(token).toBe('at_refreshed');
  });

  it('getAccessToken() handles rotated refresh token', async () => {
    fetcher.mockResolvedValueOnce(
      jsonResponse({ access_token: 'at_initial', token_type: 'bearer', expires_in: 3600 }),
    );
    await service.authorize(CC_PROFILE, REF);

    await tokenStore.set(REF, {
      access_token: 'at_expired',
      refresh_token: 'rt_old',
      expires_at: '2020-01-01T00:00:00Z',
    });

    fetcher.mockResolvedValueOnce(
      jsonResponse({
        access_token: 'at_new',
        refresh_token: 'rt_new',
        token_type: 'bearer',
      }),
    );

    await service.getAccessToken(REF);
    const stored = await tokenStore.get(REF);
    expect(stored?.refresh_token).toBe('rt_new');
  });

  it('getAccessToken() single-flight: concurrent calls share one refresh', async () => {
    fetcher.mockResolvedValueOnce(
      jsonResponse({ access_token: 'at_initial', token_type: 'bearer', expires_in: 3600 }),
    );
    await service.authorize(CC_PROFILE, REF);

    await tokenStore.set(REF, {
      access_token: 'at_expired',
      refresh_token: 'rt_123',
      expires_at: '2020-01-01T00:00:00Z',
    });

    let callCount = 0;
    let resolveRefresh: ((r: Response) => void) | undefined;
    const refreshPromise = new Promise<Response>((r) => {
      resolveRefresh = r;
    });
    fetcher.mockImplementation(() => {
      callCount++;
      return refreshPromise;
    });

    const p1 = service.getAccessToken(REF);
    const p2 = service.getAccessToken(REF);

    const resolve = resolveRefresh;
    if (resolve) resolve(jsonResponse({ access_token: 'at_refreshed', token_type: 'bearer' }));

    const [t1, t2] = await Promise.all([p1, p2]);
    expect(t1).toBe('at_refreshed');
    expect(t2).toBe('at_refreshed');
    expect(callCount).toBe(1);
  });

  it('getAccessToken() throws when no tokens', async () => {
    await expect(service.getAccessToken(REF)).rejects.toThrow('No tokens stored');
  });

  it('getAccessToken() throws when expired with no refresh_token', async () => {
    fetcher.mockResolvedValueOnce(
      jsonResponse({ access_token: 'at_initial', token_type: 'bearer', expires_in: 3600 }),
    );
    await service.authorize(CC_PROFILE, REF);

    await tokenStore.set(REF, {
      access_token: 'at_expired',
      expires_at: '2020-01-01T00:00:00Z',
    });

    await expect(service.getAccessToken(REF)).rejects.toThrow('no refresh token');
  });

  it('revoke() deletes tokens from store', async () => {
    fetcher.mockResolvedValueOnce(
      jsonResponse({ access_token: 'at_cc', token_type: 'bearer', expires_in: 3600 }),
    );
    await service.authorize(CC_PROFILE, REF);

    await service.revoke(REF);
    await expect(service.getAccessToken(REF)).rejects.toThrow('No tokens stored');
  });

  it('revoke() calls revocation endpoint', async () => {
    const profileWithRevocation: OAuthProviderProfile = {
      ...CC_PROFILE,
      id: 'test-revoke',
      revocationEndpoint: 'https://auth.example.com/revoke',
    };
    const revRef: CredentialRef = { providerId: 'test-revoke', personalityId: 'alice' };

    fetcher.mockResolvedValueOnce(
      jsonResponse({ access_token: 'at_revoke', token_type: 'bearer', expires_in: 3600 }),
    );
    await service.authorize(profileWithRevocation, revRef);

    fetcher.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await service.revoke(revRef);

    const revocationCall = fetcher.mock.calls[1];
    expect(revocationCall[0]).toBe('https://auth.example.com/revoke');
  });

  it('status() returns presence info', async () => {
    fetcher.mockResolvedValueOnce(
      jsonResponse({ access_token: 'at_cc', token_type: 'bearer', expires_in: 3600 }),
    );
    await service.authorize(CC_PROFILE, REF);

    const result = await service.status(REF);
    expect(result.present).toBe(true);
  });

  it('getAccessToken() refreshes after simulated restart (meta loaded from store)', async () => {
    fetcher.mockResolvedValueOnce(
      jsonResponse({ access_token: 'at_initial', token_type: 'bearer', expires_in: 3600 }),
    );
    await service.authorize(CC_PROFILE, REF);

    // Simulate a process restart: new service instance with the same token store
    const service2 = new DefaultOAuthService(
      tokenStore,
      registry,
      fetcher as unknown as (url: string, init: RequestInit) => Promise<Response>,
    );

    // Write an expired token so refresh is triggered
    await tokenStore.set(REF, {
      access_token: 'at_expired',
      refresh_token: 'rt_123',
      expires_at: '2020-01-01T00:00:00Z',
    });

    fetcher.mockResolvedValueOnce(
      jsonResponse({ access_token: 'at_refreshed_post_restart', token_type: 'bearer' }),
    );

    const token = await service2.getAccessToken(REF);
    expect(token).toBe('at_refreshed_post_restart');
  });

  it('revoke() works after simulated restart (meta loaded from store)', async () => {
    const profileWithRevocation: OAuthProviderProfile = {
      ...CC_PROFILE,
      id: 'test-revoke2',
      revocationEndpoint: 'https://auth.example.com/revoke',
    };
    const revRef: CredentialRef = { providerId: 'test-revoke2', personalityId: 'alice' };

    fetcher.mockResolvedValueOnce(
      jsonResponse({ access_token: 'at_rev', token_type: 'bearer', expires_in: 3600 }),
    );
    await service.authorize(profileWithRevocation, revRef);

    // Simulate a process restart: new service instance
    const service2 = new DefaultOAuthService(
      tokenStore,
      registry,
      fetcher as unknown as (url: string, init: RequestInit) => Promise<Response>,
    );

    fetcher.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await service2.revoke(revRef);

    const revocationCall = fetcher.mock.calls[1];
    expect(revocationCall[0]).toBe('https://auth.example.com/revoke');
  });
});
