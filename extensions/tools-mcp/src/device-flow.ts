// RFC 8628 device authorization: request + polling state machine. I/O is
// injected (`DeviceFlowDeps`) so the transitions are testable on a fake clock.
// State machine pinned by __tests__/device-flow.test.ts.
//
// No error message or return value here carries response-body text: a token
// endpoint may echo the device code. Only RFC error codes that match
// SAFE_CODE leave this module (pinned by "never echoes the body").

import { validateUrl as validateSsrfUrl } from '@ethosagent/core';
import {
  buildDeviceAuthorizationParams,
  buildDeviceTokenParams,
  classifyDeviceTokenResponse,
  type DeviceAuthorization,
  parseDeviceAuthorizationResponse,
} from '@ethosagent/oauth-core';
import { safeFetch } from '@ethosagent/safety-network';
import type { TokenSet } from './oauth';

export type { DeviceAuthorization } from '@ethosagent/oauth-core';

export interface DeviceFlowDeps {
  /** One form POST. Throws `DeviceFlowBlockedError` when the URL is refused by the SSRF gate; any other throw is a network error. */
  post(
    url: string,
    body: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<{ status: number; body: unknown }>;
  /** Resolves after `ms`; rejects when `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
}

export type DeviceFlowOutcome =
  | { kind: 'tokens'; tokens: TokenSet }
  | { kind: 'denied' }
  | { kind: 'expired' }
  | { kind: 'cancelled' }
  | { kind: 'error'; code: string };

export class DeviceFlowBlockedError extends Error {
  constructor() {
    super('Device flow request blocked by the network policy');
    this.name = 'DeviceFlowBlockedError';
  }
}

/** The device endpoint answered, but not with a usable authorization. `code` is an RFC error code or one of network_error / invalid_response / http_<status>. */
export class DeviceAuthorizationError extends Error {
  constructor(public readonly code: string) {
    super(`Device authorization failed: ${code}`);
    this.name = 'DeviceAuthorizationError';
  }
}

const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_BODY_BYTES = 64 * 1024;
const SLOW_DOWN_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;

function safeCode(value: unknown, fallback: string): string {
  return typeof value === 'string' && SAFE_CODE.test(value) ? value : fallback;
}

export async function requestDeviceAuthorization(
  cfg: { deviceAuthorizationEndpoint: string; clientId: string; scopes?: string[] },
  deps: DeviceFlowDeps,
  signal?: AbortSignal,
): Promise<DeviceAuthorization> {
  const { body } = buildDeviceAuthorizationParams({
    clientId: cfg.clientId,
    scopes: cfg.scopes,
  });
  let res: { status: number; body: unknown };
  try {
    res = await deps.post(cfg.deviceAuthorizationEndpoint, body, signal);
  } catch (err) {
    if (err instanceof DeviceFlowBlockedError) throw err;
    throw new DeviceAuthorizationError('network_error');
  }
  if (res.status < 200 || res.status >= 300) {
    const errField =
      typeof res.body === 'object' && res.body !== null
        ? (res.body as Record<string, unknown>).error
        : undefined;
    throw new DeviceAuthorizationError(safeCode(errField, `http_${res.status}`));
  }
  try {
    return parseDeviceAuthorizationResponse(res.body, { now: deps.now() });
  } catch {
    throw new DeviceAuthorizationError('invalid_response');
  }
}

export async function pollDeviceToken(
  auth: DeviceAuthorization,
  cfg: { tokenEndpoint: string; clientId: string; onPoll?: () => void },
  deps: DeviceFlowDeps,
  signal: AbortSignal,
): Promise<DeviceFlowOutcome> {
  let interval = auth.intervalSec * 1000;
  let wait = interval;
  const { body } = buildDeviceTokenParams({ deviceCode: auth.deviceCode, clientId: cfg.clientId });

  for (;;) {
    if (signal.aborted) return { kind: 'cancelled' };
    if (deps.now() >= auth.expiresAt) return { kind: 'expired' };
    try {
      await deps.sleep(wait, signal);
    } catch {
      return { kind: 'cancelled' };
    }
    if (signal.aborted) return { kind: 'cancelled' };
    if (deps.now() >= auth.expiresAt) return { kind: 'expired' };

    cfg.onPoll?.();
    let res: { status: number; body: unknown };
    try {
      res = await deps.post(cfg.tokenEndpoint, body, signal);
    } catch (err) {
      if (signal.aborted) return { kind: 'cancelled' };
      if (err instanceof DeviceFlowBlockedError) return { kind: 'error', code: 'blocked' };
      wait = Math.min(wait * 2, MAX_BACKOFF_MS); // RFC 8628 §3.5: back off on a network error
      continue;
    }
    if (res.status >= 500 || res.status === 429) {
      wait = Math.min(wait * 2, MAX_BACKOFF_MS);
      continue;
    }

    const result = classifyDeviceTokenResponse(res.status, res.body);
    switch (result.kind) {
      case 'tokens':
        return {
          kind: 'tokens',
          tokens: {
            access_token: result.tokens.access_token,
            ...(result.tokens.refresh_token ? { refresh_token: result.tokens.refresh_token } : {}),
            ...(result.tokens.expires_at ? { expires_at: result.tokens.expires_at } : {}),
          },
        };
      case 'denied':
        return { kind: 'denied' };
      case 'expired':
        return { kind: 'expired' };
      case 'error':
        return { kind: 'error', code: safeCode(result.code, 'invalid_response') };
      case 'slow_down':
        interval += SLOW_DOWN_MS; // kept for every later poll
        wait = interval;
        break;
      case 'pending':
        wait = interval; // recovers from any backoff
        break;
    }
  }
}

async function readCapped(resp: Response): Promise<string | null> {
  const reader = resp.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Production deps: `safeFetch` behind `validateSsrfUrl`, the same gate `exchangeCode` uses. */
export function createDeviceFlowDeps(): DeviceFlowDeps {
  return {
    async post(url, body, signal) {
      try {
        validateSsrfUrl(url);
      } catch {
        throw new DeviceFlowBlockedError();
      }
      const fetched = await safeFetch(url, {
        policy: {},
        init: {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: body.toString(),
          ...(signal ? { signal } : {}),
        },
      });
      if (!fetched.ok) {
        // safeFetch reports a transport failure as `fetch failed: …`; everything else is a policy block.
        if (fetched.reason.startsWith('fetch failed'))
          throw new Error('Device flow request failed');
        throw new DeviceFlowBlockedError();
      }
      const text = await readCapped(fetched.response);
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null; // lenient: never surface body text
        }
      }
      return { status: fetched.response.status, body: parsed };
    },
    sleep: abortableSleep,
    now: () => Date.now(),
  };
}
