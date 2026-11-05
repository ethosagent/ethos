import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDeviceFlowDeps,
  DeviceFlowBlockedError,
  type DeviceFlowOutcome,
  pollDeviceToken,
  requestDeviceAuthorization,
} from '../device-flow';
import { FAKE_SECRETS, FakeDeviceAuthServer, type TokenStep } from './helpers/fake-device-server';

// Route safeFetch to the globalThis.fetch stub (same seam as oauth.test.ts);
// URL validation and the SSRF gate stay real.
vi.mock('@ethosagent/safety-network', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ethosagent/safety-network')>();
  return {
    ...actual,
    safeFetch: (url: string, opts: Parameters<typeof actual.safeFetch>[1]) =>
      actual.safeFetch(url, {
        ...opts,
        fetchImpl: (input, init) => globalThis.fetch(input, init),
        // No real DNS: fake timers cannot advance past a pending socket lookup.
        resolveHost: async () => ['93.184.216.34'],
      }),
  };
});

const deps = createDeviceFlowDeps();

describe('pollDeviceToken', () => {
  let server: FakeDeviceAuthServer;
  let t0: number;

  beforeEach(() => {
    vi.useFakeTimers();
    t0 = Date.now();
    server = new FakeDeviceAuthServer();
    server.install();
  });

  afterEach(() => {
    server.restore();
    vi.useRealTimers();
  });

  async function run(
    script: TokenStep[],
    opts: { expiresInSec?: number; intervalSec?: number; abortAtMs?: number } = {},
    advanceMs = 600_000,
  ): Promise<DeviceFlowOutcome> {
    server.tokenScript = script;
    if (opts.expiresInSec !== undefined) server.expiresInSec = opts.expiresInSec;
    if (opts.intervalSec !== undefined) server.intervalSec = opts.intervalSec;
    const auth = await requestDeviceAuthorization(
      {
        deviceAuthorizationEndpoint: server.deviceEndpoint,
        clientId: 'fake-client',
      },
      deps,
    );
    const ac = new AbortController();
    if (opts.abortAtMs !== undefined) setTimeout(() => ac.abort(), opts.abortAtMs);
    const p = pollDeviceToken(
      auth,
      { tokenEndpoint: server.tokenEndpoint, clientId: 'fake-client' },
      deps,
      ac.signal,
    );
    await vi.advanceTimersByTimeAsync(advanceMs);
    return p;
  }

  const gaps = () => server.tokenRequests.map((r, i, a) => r.at - (a[i - 1]?.at ?? t0));

  it('waits one interval before the first poll', async () => {
    const out = await run(['tokens']);
    expect(out.kind).toBe('tokens');
    expect(server.tokenRequests[0]?.at).toBe(t0 + 5_000);
    expect(server.tokenRequests[0]?.body.get('grant_type')).toBe(
      'urn:ietf:params:oauth:grant-type:device_code',
    );
  });

  it('authorization_pending keeps the interval', async () => {
    const out = await run(['pending', 'pending', 'tokens']);
    expect(out.kind).toBe('tokens');
    expect(gaps()).toEqual([5_000, 5_000, 5_000]);
  });

  it('slow_down adds 5s and keeps it for every later poll', async () => {
    const out = await run(['pending', 'slow_down', 'pending', 'pending', 'tokens']);
    expect(out.kind).toBe('tokens');
    expect(gaps()).toEqual([5_000, 5_000, 10_000, 10_000, 10_000]);
  });

  it('access_denied ends denied with no further request', async () => {
    const out = await run(['denied', 'tokens']);
    expect(out).toEqual({ kind: 'denied' });
    expect(server.tokenRequests).toHaveLength(1);
  });

  it('expired_token ends expired', async () => {
    const out = await run(['pending', 'expired', 'tokens']);
    expect(out).toEqual({ kind: 'expired' });
    expect(server.tokenRequests).toHaveLength(2);
  });

  it('the local deadline ends expired without a request after it', async () => {
    const out = await run(['pending'], { expiresInSec: 12, intervalSec: 5 });
    expect(out).toEqual({ kind: 'expired' });
    // polls at 5 s and 10 s; the 15 s wake-up is past the 12 s deadline
    expect(server.tokenRequests).toHaveLength(2);
  });

  it('a network error backs off to double the interval, capped at 60s, then recovers', async () => {
    const out = await run(
      ['network', 'server_error', 'network', 'network', 'network', 'network', 'pending', 'tokens'],
      { intervalSec: 5 },
    );
    expect(out.kind).toBe('tokens');
    // wait before poll n: 5, then doubled after each failure (10, 20, 40, 60, 60), pending restores 5
    expect(gaps()).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 5_000]);
  });

  it('an unknown error code ends error with that code and never echoes the body', async () => {
    const out = await run(['unknown_error']);
    expect(out).toEqual({ kind: 'error', code: 'weird_error' });
    expect(JSON.stringify(out)).not.toContain(FAKE_SECRETS.deviceCode);
    const html = await run(['bad_body']);
    expect(html).toEqual({ kind: 'error', code: 'invalid_response' });
  });

  it('abort during the wait ends cancelled with no request', async () => {
    const out = await run(['tokens'], { abortAtMs: 2_000 });
    expect(out).toEqual({ kind: 'cancelled' });
    expect(server.tokenRequests).toHaveLength(0);
  });

  it('the device endpoint is refused by the SSRF gate when it is private', async () => {
    await expect(
      requestDeviceAuthorization(
        { deviceAuthorizationEndpoint: 'https://10.0.0.5/device_authorization', clientId: 'c' },
        deps,
      ),
    ).rejects.toBeInstanceOf(DeviceFlowBlockedError);
    expect(server.urls).toHaveLength(0);
  });
});

describe('requestDeviceAuthorization', () => {
  it('maps a 401 unauthorized_client to a DeviceAuthorizationError without the body text', async () => {
    const server = new FakeDeviceAuthServer();
    server.deviceAuth = 'unauthorized_client';
    server.install();
    try {
      const err = await requestDeviceAuthorization(
        { deviceAuthorizationEndpoint: server.deviceEndpoint, clientId: 'c' },
        deps,
      ).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'unauthorized_client' });
      expect(String((err as Error).message)).not.toContain(FAKE_SECRETS.deviceCode);
    } finally {
      server.restore();
    }
  });
});
