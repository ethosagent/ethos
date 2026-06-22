import type { TokenSet } from '@ethosagent/oauth-core';
import { parseTokenResponse } from '@ethosagent/oauth-core';

export interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

export interface DeviceCodeOptions {
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  scopes?: string[];
  signal?: AbortSignal;
}

export interface DeviceCodeResult {
  deviceAuth: DeviceAuthorizationResponse;
  tokens: Promise<TokenSet>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateDeviceAuthResponse(data: unknown): DeviceAuthorizationResponse {
  if (typeof data !== 'object' || data === null) {
    throw new Error('Device authorization response must be an object');
  }

  const obj = data as Record<string, unknown>;

  if (typeof obj.device_code !== 'string' || obj.device_code === '') {
    throw new Error('Device authorization response missing device_code');
  }
  if (typeof obj.user_code !== 'string' || obj.user_code === '') {
    throw new Error('Device authorization response missing user_code');
  }
  if (typeof obj.verification_uri !== 'string' || obj.verification_uri === '') {
    throw new Error('Device authorization response missing verification_uri');
  }
  if (typeof obj.expires_in !== 'number' || obj.expires_in <= 0) {
    throw new Error('Device authorization response missing expires_in');
  }

  const result: DeviceAuthorizationResponse = {
    device_code: obj.device_code,
    user_code: obj.user_code,
    verification_uri: obj.verification_uri,
    expires_in: obj.expires_in,
  };

  if (typeof obj.verification_uri_complete === 'string') {
    result.verification_uri_complete = obj.verification_uri_complete;
  }
  if (typeof obj.interval === 'number') {
    result.interval = obj.interval;
  }

  return result;
}

async function pollForTokens(
  deviceAuth: DeviceAuthorizationResponse,
  opts: DeviceCodeOptions,
): Promise<TokenSet> {
  let intervalMs = (deviceAuth.interval ?? 5) * 1000;
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: deviceAuth.device_code,
    client_id: opts.clientId,
  });

  for (;;) {
    if (opts.signal?.aborted) {
      throw new Error('Device code flow aborted');
    }

    await delay(intervalMs);

    if (opts.signal?.aborted) {
      throw new Error('Device code flow aborted');
    }

    const response = await fetch(opts.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const data = (await response.json()) as Record<string, unknown>;

    if (typeof data.error === 'string') {
      switch (data.error) {
        case 'authorization_pending':
          continue;
        case 'slow_down':
          intervalMs += 5000;
          continue;
        case 'expired_token':
          throw new Error('Device code expired — please restart the authorization flow');
        case 'access_denied':
          throw new Error('Authorization denied by user');
        default:
          throw new Error(`Device code token error: ${data.error}`);
      }
    }

    return parseTokenResponse(data);
  }
}

export async function startDeviceCodeFlow(opts: DeviceCodeOptions): Promise<DeviceCodeResult> {
  const body = new URLSearchParams({ client_id: opts.clientId });
  if (opts.scopes?.length) {
    body.set('scope', opts.scopes.join(' '));
  }

  const response = await fetch(opts.deviceAuthorizationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data: unknown = await response.json();
  const deviceAuth = validateDeviceAuthResponse(data);

  return {
    deviceAuth,
    tokens: pollForTokens(deviceAuth, opts),
  };
}
