import { afterEach, describe, expect, it } from 'vitest';
import { type LoopbackServerResult, startLoopbackServer } from '../loopback-server';

async function hitCallback(
  port: number,
  path: string,
  params: Record<string, string>,
): Promise<Response> {
  const url = new URL(path, `http://127.0.0.1:${port}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return fetch(url.toString());
}

describe('startLoopbackServer', () => {
  let server: LoopbackServerResult | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it('returns code and state on valid callback', async () => {
    server = await startLoopbackServer();
    const res = hitCallback(server.port, '/oauth/callback', {
      code: 'abc',
      state: 'xyz',
    });
    const result = await server.result;
    expect(result).toEqual({ code: 'abc', state: 'xyz' });
    expect((await res).status).toBe(200);
  });

  it('rejects on OAuth error param', async () => {
    server = await startLoopbackServer();
    const rejection = expect(server.result).rejects.toThrow('OAuth error: access_denied');
    await hitCallback(server.port, '/oauth/callback', { error: 'access_denied' });
    await rejection;
  });

  it('rejects requests to wrong path with 404', async () => {
    server = await startLoopbackServer();
    const res = await hitCallback(server.port, '/wrong', { code: 'abc', state: 'xyz' });
    expect(res.status).toBe(404);
  });

  it('rejects non-GET methods with 405', async () => {
    server = await startLoopbackServer();
    const url = new URL('/oauth/callback', `http://127.0.0.1:${server.port}`);
    url.searchParams.set('code', 'abc');
    url.searchParams.set('state', 'xyz');
    const res = await fetch(url.toString(), { method: 'POST' });
    expect(res.status).toBe(405);
  });

  it('rejects missing code with 400', async () => {
    server = await startLoopbackServer();
    const res = await hitCallback(server.port, '/oauth/callback', { state: 'xyz' });
    expect(res.status).toBe(400);
  });

  it('rejects missing state with 400', async () => {
    server = await startLoopbackServer();
    const res = await hitCallback(server.port, '/oauth/callback', { code: 'abc' });
    expect(res.status).toBe(400);
  });

  it('rejects second callback after first succeeds', async () => {
    server = await startLoopbackServer();
    await hitCallback(server.port, '/oauth/callback', { code: 'abc', state: 'xyz' });
    await server.result;
    const second = await hitCallback(server.port, '/oauth/callback', {
      code: 'def',
      state: 'uvw',
    }).catch(() => ({ status: 0 }));
    expect([0, 400]).toContain(second.status);
  });

  it('supports custom path', async () => {
    server = await startLoopbackServer({ path: '/custom/cb' });
    expect(server.redirectUri).toContain('/custom/cb');
    const res = hitCallback(server.port, '/custom/cb', { code: 'abc', state: 'xyz' });
    const result = await server.result;
    expect(result).toEqual({ code: 'abc', state: 'xyz' });
    expect((await res).status).toBe(200);
  });

  it('binds to an ephemeral port by default', async () => {
    server = await startLoopbackServer();
    expect(server.port).toBeGreaterThan(0);
  });

  it('times out after configured duration', async () => {
    server = await startLoopbackServer({ timeoutMs: 50 });
    await expect(server.result).rejects.toThrow('timed out');
  });

  it('binds to 127.0.0.1', async () => {
    server = await startLoopbackServer();
    const res = await hitCallback(server.port, '/oauth/callback', {
      code: 'abc',
      state: 'xyz',
    });
    expect(res.ok).toBe(true);
  });
});
