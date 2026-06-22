import type {
  CredentialRef,
  OAuthProviderProfile,
  OAuthService,
  TokenSet,
  UserPrompt,
} from '@ethosagent/oauth-core';
import {
  buildAuthorizationUrl,
  buildDcrRequest,
  buildOAuthMetadataUrl,
  buildProtectedResourceMetadataUrl,
  buildRefreshParams,
  buildRevocationParams,
  buildTokenExchangeParams,
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
  isTokenExpired,
  parseDcrResponse,
  parseOAuthServerMetadata,
  parseProtectedResourceMetadata,
  parseTokenResponse,
} from '@ethosagent/oauth-core';
import { startDeviceCodeFlow } from './device-code';
import { startLoopbackServer } from './loopback-server';
import type { DefaultOAuthRegistry } from './registry';
import type { OAuthTokenStore } from './token-store';

interface CredentialMeta {
  tokenEndpoint: string;
  revocationEndpoint?: string;
  clientId: string;
  clientSecret?: string;
  clientAuth?: string;
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export class DefaultOAuthService implements OAuthService {
  private readonly meta = new Map<string, CredentialMeta>();
  private readonly refreshLocks = new Map<string, Promise<string>>();

  constructor(
    private readonly tokenStore: OAuthTokenStore,
    private readonly registry: DefaultOAuthRegistry,
    private readonly fetcher: Fetcher = globalThis.fetch,
  ) {}

  async authorize(
    profile: OAuthProviderProfile,
    ref: CredentialRef,
    opts?: { signal?: AbortSignal; onUserPrompt?: (p: UserPrompt) => void },
  ): Promise<void> {
    switch (profile.flow.kind) {
      case 'authorization_code':
        await this.authorizeAuthCode(profile, ref, opts);
        break;
      case 'device_code':
        await this.authorizeDeviceCode(profile, ref, opts);
        break;
      case 'client_credentials':
        await this.authorizeClientCredentials(profile, ref);
        break;
      case 'custom':
        await this.authorizeCustom(profile, ref);
        break;
    }
  }

  async getAccessToken(ref: CredentialRef): Promise<string> {
    const tokens = await this.tokenStore.get(ref);
    if (!tokens) {
      throw new Error(`No tokens stored for ${this.refKey(ref)}`);
    }

    if (!isTokenExpired(tokens)) {
      return tokens.access_token;
    }

    if (!tokens.refresh_token) {
      throw new Error(`Token expired and no refresh token for ${this.refKey(ref)}`);
    }

    const key = this.refKey(ref);
    const existing = this.refreshLocks.get(key);
    if (existing) return existing;

    const promise = this.doRefresh(ref, tokens).finally(() => {
      this.refreshLocks.delete(key);
    });
    this.refreshLocks.set(key, promise);
    return promise;
  }

  async revoke(ref: CredentialRef): Promise<void> {
    const tokens = await this.tokenStore.get(ref);
    if (!tokens) return;

    const key = this.refKey(ref);
    const credMeta = this.meta.get(key);

    if (credMeta?.revocationEndpoint) {
      try {
        const { body } = buildRevocationParams({
          token: tokens.access_token,
          clientId: credMeta.clientId,
        });
        await this.fetcher(credMeta.revocationEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        });
      } catch {
        // best-effort
      }
    }

    await this.tokenStore.delete(ref);
    this.meta.delete(key);
  }

  async status(
    ref: CredentialRef,
  ): Promise<{ present: boolean; expiresAt?: string; scopes?: string[] }> {
    return this.tokenStore.status(ref);
  }

  private refKey(ref: CredentialRef): string {
    return `${ref.providerId}:${ref.profile ?? 'default'}:${ref.personalityId}`;
  }

  private async resolveEndpoints(profile: OAuthProviderProfile): Promise<{
    authorizationEndpoint: string;
    tokenEndpoint: string;
    revocationEndpoint?: string;
    registrationEndpoint?: string;
    deviceAuthorizationEndpoint?: string;
  }> {
    if (!profile.discovery) {
      if (!profile.tokenEndpoint) {
        throw new Error('Missing tokenEndpoint');
      }
      return {
        authorizationEndpoint: profile.authorizationEndpoint ?? '',
        tokenEndpoint: profile.tokenEndpoint ?? '',
        revocationEndpoint: profile.revocationEndpoint,
      };
    }

    if (profile.discovery.kind === 'oauth-as-metadata') {
      const url = buildOAuthMetadataUrl(profile.discovery.issuer);
      const res = await this.fetcher(url, { method: 'GET', headers: {} });
      const data: unknown = await res.json();
      const meta = parseOAuthServerMetadata(data);
      return {
        authorizationEndpoint: profile.authorizationEndpoint ?? meta.authorization_endpoint,
        tokenEndpoint: profile.tokenEndpoint ?? meta.token_endpoint,
        revocationEndpoint: profile.revocationEndpoint ?? meta.revocation_endpoint,
        registrationEndpoint: meta.registration_endpoint,
        deviceAuthorizationEndpoint: meta.device_authorization_endpoint,
      };
    }

    const prUrl = buildProtectedResourceMetadataUrl(profile.discovery.resourceUrl);
    const prRes = await this.fetcher(prUrl, { method: 'GET', headers: {} });
    const prData: unknown = await prRes.json();
    const prMeta = parseProtectedResourceMetadata(prData);

    const servers = prMeta.authorization_servers;
    if (!servers?.length) {
      throw new Error('Protected resource metadata has no authorization_servers');
    }

    const asUrl = buildOAuthMetadataUrl(servers[0]);
    const asRes = await this.fetcher(asUrl, { method: 'GET', headers: {} });
    const asData: unknown = await asRes.json();
    const asMeta = parseOAuthServerMetadata(asData);

    return {
      authorizationEndpoint: profile.authorizationEndpoint ?? asMeta.authorization_endpoint,
      tokenEndpoint: profile.tokenEndpoint ?? asMeta.token_endpoint,
      revocationEndpoint: profile.revocationEndpoint ?? asMeta.revocation_endpoint,
      registrationEndpoint: asMeta.registration_endpoint,
      deviceAuthorizationEndpoint: asMeta.device_authorization_endpoint,
    };
  }

  private async authorizeAuthCode(
    profile: OAuthProviderProfile,
    ref: CredentialRef,
    opts?: {
      signal?: AbortSignal;
      onUserPrompt?: (p: UserPrompt) => void;
    },
  ): Promise<void> {
    const endpoints = await this.resolveEndpoints(profile);

    let clientId = profile.clientId ?? '';
    let clientSecret: string | undefined;

    const redirect = profile.redirect ?? { mode: 'loopback' as const };

    if (redirect.mode === 'device-code') {
      await this.authorizeDeviceCode({ ...profile, flow: { kind: 'device_code' } }, ref, opts);
      return;
    }

    const server = await startLoopbackServer({
      port: redirect.mode === 'loopback' ? redirect.port : undefined,
      path: redirect.mode === 'loopback' ? redirect.path : undefined,
    });

    try {
      if (profile.registration?.kind === 'dcr' && !clientId) {
        const regEndpoint = profile.registration.endpoint ?? endpoints.registrationEndpoint;
        if (!regEndpoint) {
          throw new Error('DCR configured but no registration endpoint available');
        }

        const dcrReq = buildDcrRequest({
          redirectUris: [server.redirectUri],
          clientName: profile.id,
        });
        const dcrRes = await this.fetcher(regEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(dcrReq),
        });
        const dcrData: unknown = await dcrRes.json();
        const dcr = parseDcrResponse(dcrData);
        clientId = dcr.client_id;
        clientSecret = dcr.client_secret;
      }

      const verifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(verifier);
      const state = generateState();

      const authUrl = buildAuthorizationUrl({
        authorizationEndpoint: endpoints.authorizationEndpoint,
        clientId,
        redirectUri: server.redirectUri,
        state,
        codeChallenge,
        scopes: profile.scopes,
        audience: profile.audience,
      });

      opts?.onUserPrompt?.({ kind: 'open-url', url: authUrl });

      const callback = await server.result;

      if (callback.state !== state) {
        throw new Error('OAuth state mismatch');
      }

      const { body, headers } = buildTokenExchangeParams({
        code: callback.code,
        redirectUri: server.redirectUri,
        clientId,
        codeVerifier: verifier,
        clientSecret,
        clientAuth: profile.clientAuth,
      });

      const tokenRes = await this.fetcher(endpoints.tokenEndpoint, {
        method: 'POST',
        headers,
        body: body.toString(),
      });
      const tokenData: unknown = await tokenRes.json();
      const tokens = parseTokenResponse(tokenData);

      server.close();

      await this.tokenStore.set(ref, tokens);
      this.meta.set(this.refKey(ref), {
        tokenEndpoint: endpoints.tokenEndpoint,
        revocationEndpoint: endpoints.revocationEndpoint,
        clientId,
        clientSecret,
        clientAuth: profile.clientAuth,
      });
    } finally {
      server.close();
    }
  }

  private async authorizeDeviceCode(
    profile: OAuthProviderProfile,
    ref: CredentialRef,
    opts?: {
      signal?: AbortSignal;
      onUserPrompt?: (p: UserPrompt) => void;
    },
  ): Promise<void> {
    const endpoints = await this.resolveEndpoints(profile);
    const deviceEndpoint = endpoints.deviceAuthorizationEndpoint;
    if (!deviceEndpoint) {
      throw new Error('Missing deviceAuthorizationEndpoint');
    }

    const clientId = profile.clientId ?? '';

    const result = await startDeviceCodeFlow({
      deviceAuthorizationEndpoint: deviceEndpoint,
      tokenEndpoint: endpoints.tokenEndpoint,
      clientId,
      scopes: profile.scopes,
      signal: opts?.signal,
    });

    opts?.onUserPrompt?.({
      kind: 'device-code',
      verificationUri: result.deviceAuth.verification_uri,
      userCode: result.deviceAuth.user_code,
      expiresIn: result.deviceAuth.expires_in,
    });

    const tokens = await result.tokens;

    await this.tokenStore.set(ref, tokens);
    this.meta.set(this.refKey(ref), {
      tokenEndpoint: endpoints.tokenEndpoint,
      revocationEndpoint: endpoints.revocationEndpoint,
      clientId,
      clientAuth: profile.clientAuth,
    });
  }

  private async authorizeClientCredentials(
    profile: OAuthProviderProfile,
    ref: CredentialRef,
  ): Promise<void> {
    const endpoints = await this.resolveEndpoints(profile);

    const clientId = profile.clientId ?? '';

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
    });
    if (profile.scopes?.length) {
      body.set('scope', profile.scopes.join(' '));
    }

    const res = await this.fetcher(endpoints.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const data: unknown = await res.json();
    const tokens = parseTokenResponse(data);

    await this.tokenStore.set(ref, tokens);
    this.meta.set(this.refKey(ref), {
      tokenEndpoint: endpoints.tokenEndpoint,
      revocationEndpoint: endpoints.revocationEndpoint,
      clientId,
      clientAuth: profile.clientAuth,
    });
  }

  private async authorizeCustom(profile: OAuthProviderProfile, ref: CredentialRef): Promise<void> {
    if (profile.flow.kind !== 'custom') {
      throw new Error('Expected custom flow');
    }
    const provider = this.registry.getCustomFlow(profile.flow.provider);
    if (!provider) {
      throw new Error(`Unknown custom flow provider: ${profile.flow.provider}`);
    }

    const clientId = profile.clientId ?? '';
    const clientSecret: string | undefined = undefined;
    const tokens = await provider.exchange({ code: '' }, { clientId, clientSecret });

    await this.tokenStore.set(ref, tokens);
    this.meta.set(this.refKey(ref), {
      tokenEndpoint: profile.tokenEndpoint ?? '',
      revocationEndpoint: profile.revocationEndpoint,
      clientId,
      clientSecret,
    });
  }

  private async doRefresh(ref: CredentialRef, tokens: TokenSet): Promise<string> {
    const key = this.refKey(ref);
    const credMeta = this.meta.get(key);
    if (!credMeta) {
      throw new Error('No credential metadata — call authorize() first');
    }

    const { body, headers } = buildRefreshParams({
      refreshToken: tokens.refresh_token ?? '',
      clientId: credMeta.clientId,
      clientSecret: credMeta.clientSecret,
      clientAuth: credMeta.clientAuth,
    });

    const res = await this.fetcher(credMeta.tokenEndpoint, {
      method: 'POST',
      headers,
      body: body.toString(),
    });
    const data: unknown = await res.json();
    const newTokens = parseTokenResponse(data);

    newTokens.refresh_token = newTokens.refresh_token ?? tokens.refresh_token;

    await this.tokenStore.set(ref, newTokens);
    return newTokens.access_token;
  }
}
