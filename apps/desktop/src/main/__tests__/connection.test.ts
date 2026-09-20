import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `connection.ts` reaches for the OS keychain and the Electron cookie jar; the
// function under test does neither, but importing the module pulls both in,
// so both are stubbed to whatever lets the module load.
vi.mock('electron', () => ({
  session: { defaultSession: { cookies: { set: async () => {} } } },
  safeStorage: {
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}));

vi.mock('electron-store', () => ({
  default: class MockStore {
    get(_key: string, fallback?: unknown) {
      return fallback;
    }
    set() {}
  },
}));

import { testConnection } from '../connection';

// `normalizeRemoteUrl`/`remoteOrigin`/`remoteHost`/`wsOriginFor` moved to
// `@ethosagent/sdk` (T-CONN) and are tested there —
// `packages/sdk/src/__tests__/connection.test.ts`. `testConnection` stays
// here: it is cookie-based (the desktop's own auth transport), unlike the
// sdk's bearer-based `probeConnection`.
describe('testConnection', () => {
  const healthOk = (body: unknown = { status: 'ok' }) =>
    new Response(JSON.stringify(body), { status: 200 });

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects a URL that is not http(s) without any request', async () => {
    const result = await testConnection('ftp://ethos.example.com');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Enter an http:// or https:// server URL.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('probes /healthz on the normalized origin and reports latency', async () => {
    fetchMock.mockResolvedValue(healthOk());
    const result = await testConnection('https://ethos.example.com/dashboard');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://ethos.example.com/healthz');
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeTypeOf('number');
  });

  it('reports the version when /healthz carries one, and omits it otherwise', async () => {
    fetchMock.mockResolvedValue(healthOk({ status: 'ok', version: '0.7.3' }));
    expect((await testConnection('https://ethos.example.com')).version).toBe('0.7.3');

    fetchMock.mockResolvedValue(healthOk());
    expect((await testConnection('https://ethos.example.com')).version).toBeUndefined();
  });

  it('accepts 503 — a reachable server whose gateway is down', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 503 }));
    expect((await testConnection('https://ethos.example.com')).ok).toBe(true);
  });

  it('rejects any other status', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 404 }));
    const result = await testConnection('https://ethos.example.com');
    expect(result).toMatchObject({ ok: false, error: 'Server returned 404.' });
  });

  it('surfaces a network failure as the concrete error', async () => {
    fetchMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND ethos.example.com'));
    const result = await testConnection('https://ethos.example.com');
    expect(result).toEqual({ ok: false, error: 'getaddrinfo ENOTFOUND ethos.example.com' });
  });

  it('does not probe auth when no token is supplied', async () => {
    fetchMock.mockResolvedValue(healthOk());
    await testConnection('https://ethos.example.com');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('sends the token as the ethos_auth cookie on an authenticated RPC', async () => {
    fetchMock.mockResolvedValueOnce(healthOk()).mockResolvedValueOnce(new Response('[]'));
    const result = await testConnection('https://ethos.example.com', 'tok-123');
    expect(result.ok).toBe(true);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://ethos.example.com/rpc/personalities/list');
    const init = fetchMock.mock.calls[1]?.[1] as { headers: Record<string, string>; body: string };
    expect(init.headers.Cookie).toBe('ethos_auth=tok-123');
    expect(init.headers.Origin).toBe('https://ethos.example.com');
    expect(init.body).toBe(JSON.stringify({ json: {} }));
  });

  it.each([401, 403])('treats %i as a rejected token', async (status) => {
    fetchMock
      .mockResolvedValueOnce(healthOk())
      .mockResolvedValueOnce(new Response('denied', { status }));
    const result = await testConnection('https://ethos.example.com', 'tok-123');
    expect(result).toMatchObject({ ok: false, error: 'Server rejected the token.' });
  });

  it('treats any other auth-probe outcome as token-accepted', async () => {
    fetchMock
      .mockResolvedValueOnce(healthOk())
      .mockResolvedValueOnce(new Response('boom', { status: 500 }));
    expect((await testConnection('https://ethos.example.com', 'tok-123')).ok).toBe(true);

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(healthOk()).mockRejectedValueOnce(new Error('socket hang up'));
    expect((await testConnection('https://ethos.example.com', 'tok-123')).ok).toBe(true);
  });
});
