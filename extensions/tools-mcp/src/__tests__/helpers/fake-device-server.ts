// Scripted RFC 8628 authorization server, installed as the `globalThis.fetch`
// stub. Tests that use it must route safeFetch to that stub with the
// `vi.mock('@ethosagent/safety-network', …fetchImpl…)` pattern from
// oauth.test.ts, so the real safeFetch and its SSRF gate still run.

import { vi } from 'vitest';

export type TokenStep =
  | 'pending'
  | 'slow_down'
  | 'tokens'
  | 'denied'
  | 'expired'
  | 'network'
  | 'server_error'
  | 'unknown_error'
  | 'bad_body';

export const FAKE_SECRETS = {
  userCode: 'USER-CODE-9X',
  deviceCode: 'DEVICE-CODE-SECRET-77',
  accessToken: 'fake-access-token',
  refreshToken: 'fake-refresh-token',
} as const;

export interface TokenRequestRecord {
  /** `Date.now()` on arrival (the fake clock under vi.useFakeTimers). */
  at: number;
  body: URLSearchParams;
}

export class FakeDeviceAuthServer {
  readonly mcpUrl = 'https://mcp.device.example.com/mcp';
  readonly asOrigin = 'https://auth.device.example.com';

  /** Advertise device_authorization_endpoint in the AS metadata. */
  advertiseDevice = true;
  /** DCR echoes grant_types without the device grant (the Vercel shape). */
  dcrDropsDeviceGrant = false;
  /** `/device_authorization` answer. */
  deviceAuth: 'ok' | 'unauthorized_client' = 'ok';
  expiresInSec = 300;
  intervalSec: number | undefined = 5;
  /** Steps played by `/token`; the last step repeats. */
  tokenScript: TokenStep[] = ['pending', 'tokens'];

  readonly dcrBodies: { grant_types?: string[]; redirect_uris?: string[] }[] = [];
  readonly deviceRequests: URLSearchParams[] = [];
  readonly tokenRequests: TokenRequestRecord[] = [];
  readonly urls: string[] = [];

  private realFetch: typeof fetch | undefined;

  get deviceEndpoint(): string {
    return `${this.asOrigin}/device_authorization`;
  }
  get tokenEndpoint(): string {
    return `${this.asOrigin}/token`;
  }

  install(): void {
    this.realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      this.handle(input, init),
    ) as typeof fetch;
  }

  restore(): void {
    if (this.realFetch) globalThis.fetch = this.realFetch;
  }

  /** AS metadata as served, for tests that script discovery themselves. */
  metadata(): Record<string, unknown> {
    return {
      issuer: this.asOrigin,
      authorization_endpoint: `${this.asOrigin}/authorize`,
      token_endpoint: this.tokenEndpoint,
      registration_endpoint: `${this.asOrigin}/register`,
      code_challenge_methods_supported: ['S256'],
      ...(this.advertiseDevice ? { device_authorization_endpoint: this.deviceEndpoint } : {}),
    };
  }

  private json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  private async handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    this.urls.push(url);
    const body = init?.body === undefined ? '' : String(init.body);

    if (url === 'https://mcp.device.example.com/.well-known/oauth-protected-resource/mcp') {
      return this.json({ resource: this.mcpUrl, authorization_servers: [this.asOrigin] });
    }
    if (url === `${this.asOrigin}/.well-known/oauth-authorization-server`) {
      return this.json(this.metadata());
    }
    if (url === `${this.asOrigin}/register`) {
      const parsed = JSON.parse(body) as { grant_types?: string[]; redirect_uris?: string[] };
      this.dcrBodies.push(parsed);
      const granted = (parsed.grant_types ?? []).filter(
        (g) => !(this.dcrDropsDeviceGrant && g.includes('device_code')),
      );
      return this.json({ client_id: 'fake-client', grant_types: granted }, 201);
    }
    if (url === this.deviceEndpoint) {
      this.deviceRequests.push(new URLSearchParams(body));
      if (this.deviceAuth === 'unauthorized_client') {
        return this.json(
          {
            error: 'unauthorized_client',
            error_description: `client not allowed ${FAKE_SECRETS.deviceCode}`,
          },
          401,
        );
      }
      return this.json({
        device_code: FAKE_SECRETS.deviceCode,
        user_code: FAKE_SECRETS.userCode,
        verification_uri: `${this.asOrigin}/device`,
        verification_uri_complete: `${this.asOrigin}/device?user_code=${FAKE_SECRETS.userCode}`,
        expires_in: this.expiresInSec,
        ...(this.intervalSec !== undefined ? { interval: this.intervalSec } : {}),
      });
    }
    if (url === this.tokenEndpoint) {
      const idx = Math.min(this.tokenRequests.length, this.tokenScript.length - 1);
      this.tokenRequests.push({ at: Date.now(), body: new URLSearchParams(body) });
      return this.playToken(this.tokenScript[idx] ?? 'pending');
    }
    return new Response('not found', { status: 404 });
  }

  private playToken(step: TokenStep): Response {
    switch (step) {
      case 'pending':
        return this.json({ error: 'authorization_pending' }, 400);
      case 'slow_down':
        return this.json({ error: 'slow_down' }, 400);
      case 'denied':
        return this.json({ error: 'access_denied' }, 400);
      case 'expired':
        return this.json({ error: 'expired_token' }, 400);
      case 'network':
        throw new TypeError('fetch failed');
      case 'server_error':
        return new Response('upstream down', { status: 503 });
      case 'unknown_error':
        return this.json(
          { error: 'weird_error', error_description: `bad ${FAKE_SECRETS.deviceCode}` },
          400,
        );
      case 'bad_body':
        return new Response(`<html>${FAKE_SECRETS.deviceCode}</html>`, { status: 400 });
      case 'tokens':
        return this.json({
          access_token: FAKE_SECRETS.accessToken,
          refresh_token: FAKE_SECRETS.refreshToken,
          expires_in: 3600,
        });
    }
  }
}
