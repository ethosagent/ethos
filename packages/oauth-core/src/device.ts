import { parseTokenResponse } from './token';
import type { TokenSet } from './types';

export const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

const DEFAULT_INTERVAL_SEC = 5;
/** Local cap on how long a device authorization may stay open, whatever `expires_in` says. */
export const MAX_DEVICE_AUTH_MS = 15 * 60_000;

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  /** Epoch ms. `min(expires_in, 15 min)` from the response time. */
  expiresAt: number;
  intervalSec: number;
}

export type DeviceTokenResult =
  | { kind: 'tokens'; tokens: TokenSet }
  | { kind: 'pending' }
  | { kind: 'slow_down' }
  | { kind: 'denied' }
  | { kind: 'expired' }
  | { kind: 'error'; code: string };

const FORM_HEADERS = { 'Content-Type': 'application/x-www-form-urlencoded' };

export function buildDeviceAuthorizationParams(params: { clientId: string; scopes?: string[] }): {
  body: URLSearchParams;
  headers: Record<string, string>;
} {
  const body = new URLSearchParams({ client_id: params.clientId });
  if (params.scopes?.length) body.set('scope', params.scopes.join(' '));
  return { body, headers: { ...FORM_HEADERS } };
}

export function buildDeviceTokenParams(params: { deviceCode: string; clientId: string }): {
  body: URLSearchParams;
  headers: Record<string, string>;
} {
  const body = new URLSearchParams({
    grant_type: DEVICE_CODE_GRANT_TYPE,
    device_code: params.deviceCode,
    client_id: params.clientId,
  });
  return { body, headers: { ...FORM_HEADERS } };
}

function requireString(obj: Record<string, unknown>, field: string): string {
  const value = obj[field];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Device authorization response: ${field} must be a non-empty string`);
  }
  return value;
}

function requireHttps(url: string, field: string): string {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new Error(`Device authorization response: ${field} is not a valid URL`);
  }
  if (protocol !== 'https:') {
    throw new Error(`Device authorization response: ${field} must use https:`);
  }
  return url;
}

/** Error messages name the field only, never its value (device_code / user_code are secrets). */
export function parseDeviceAuthorizationResponse(
  data: unknown,
  opts: { now: number },
): DeviceAuthorization {
  if (typeof data !== 'object' || data === null) {
    throw new Error('Device authorization response must be an object');
  }
  const obj = data as Record<string, unknown>;

  const deviceCode = requireString(obj, 'device_code');
  const userCode = requireString(obj, 'user_code');
  const verificationUri = requireHttps(requireString(obj, 'verification_uri'), 'verification_uri');

  const expiresIn = obj.expires_in;
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error('Device authorization response: expires_in must be a positive number');
  }

  const interval = obj.interval;
  const intervalSec =
    typeof interval === 'number' && Number.isFinite(interval) && interval >= 1
      ? interval
      : DEFAULT_INTERVAL_SEC;

  const result: DeviceAuthorization = {
    deviceCode,
    userCode,
    verificationUri,
    expiresAt: opts.now + Math.min(expiresIn * 1000, MAX_DEVICE_AUTH_MS),
    intervalSec,
  };
  if (obj.verification_uri_complete !== undefined) {
    result.verificationUriComplete = requireHttps(
      requireString(obj, 'verification_uri_complete'),
      'verification_uri_complete',
    );
  }
  return result;
}

/** Classify one token-endpoint answer to a device poll (RFC 8628 §3.5). */
export function classifyDeviceTokenResponse(status: number, body: unknown): DeviceTokenResult {
  if (typeof body !== 'object' || body === null) {
    return { kind: 'error', code: 'invalid_response' };
  }
  const obj = body as Record<string, unknown>;
  if (typeof obj.error === 'string') {
    switch (obj.error) {
      case 'authorization_pending':
        return { kind: 'pending' };
      case 'slow_down':
        return { kind: 'slow_down' };
      case 'access_denied':
        return { kind: 'denied' };
      case 'expired_token':
        return { kind: 'expired' };
      default:
        return { kind: 'error', code: obj.error };
    }
  }
  if (status >= 200 && status < 300) {
    try {
      return { kind: 'tokens', tokens: parseTokenResponse(obj) };
    } catch {
      return { kind: 'error', code: 'invalid_response' };
    }
  }
  return { kind: 'error', code: 'invalid_response' };
}
