import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { type CsrfMiddlewareOptions, csrfMiddleware } from '../../middleware/csrf';
import { errorHandler } from '../../middleware/error-envelope';

function makeApp(opts: CsrfMiddlewareOptions = {}): Hono {
  const app = new Hono();
  app.onError(errorHandler);
  app.use('*', csrfMiddleware(opts));
  app.post('/ping', (c) => c.json({ ok: true }));
  app.get('/ping', (c) => c.json({ ok: true }));
  return app;
}

function post(app: Hono, origin: string | undefined, host = 'localhost:3000') {
  return app.request('/ping', {
    method: 'POST',
    headers: { host, ...(origin ? { origin } : {}) },
  });
}

describe('csrfMiddleware isAllowed', () => {
  it('no allowedOrigins set, localhost origin is allowed (regression)', async () => {
    const app = makeApp();
    const res = await post(app, 'http://localhost:3000');
    expect(res.status).toBe(200);
  });

  it('no allowedOrigins set, non-localhost origin is blocked', async () => {
    const app = makeApp();
    const res = await post(app, 'https://evil.com');
    expect(res.status).toBe(401);
  });

  it('allowedOrigins exact match is allowed', async () => {
    const app = makeApp({ allowedOrigins: ['https://app.example.com'] });
    const res = await post(app, 'https://app.example.com');
    expect(res.status).toBe(200);
  });

  it('allowedOrigins with a different origin is blocked', async () => {
    const app = makeApp({ allowedOrigins: ['https://app.example.com'] });
    const res = await post(app, 'https://other.example.com');
    expect(res.status).toBe(401);
  });

  it('wildcard allowedOrigins matches a subdomain', async () => {
    const app = makeApp({ allowedOrigins: ['*.ethos.example.com'] });
    const res = await post(app, 'https://foo.ethos.example.com');
    expect(res.status).toBe(200);
  });

  it('wildcard allowedOrigins matches the bare apex domain', async () => {
    const app = makeApp({ allowedOrigins: ['*.ethos.example.com'] });
    const res = await post(app, 'https://ethos.example.com');
    expect(res.status).toBe(200);
  });

  it('wildcard allowedOrigins does not match an unrelated domain', async () => {
    const app = makeApp({ allowedOrigins: ['*.ethos.example.com'] });
    const res = await post(app, 'https://evil.com');
    expect(res.status).toBe(401);
  });

  // openclaw-advisory-fixes L-d: a localhost Origin passes only when its
  // host:port equals the request Host — true same-origin.
  it('localhost origin on the same port as Host is allowed', async () => {
    const res = await post(makeApp(), 'http://localhost:5173', 'localhost:5173');
    expect(res.status).toBe(200);
  });

  it('localhost origin on a different port from Host is blocked', async () => {
    const res = await post(makeApp(), 'http://localhost:8080', 'localhost:3000');
    expect(res.status).toBe(401);
  });

  it('127.0.0.1 origin against a localhost Host on the same port is blocked', async () => {
    const res = await post(makeApp(), 'http://127.0.0.1:3000', 'localhost:3000');
    expect(res.status).toBe(401);
  });

  it('[::1] origin on the same port as Host is allowed', async () => {
    const res = await post(makeApp(), 'http://[::1]:3000', '[::1]:3000');
    expect(res.status).toBe(200);
  });

  it('a Referer from another localhost port is blocked when Origin is absent', async () => {
    const res = await makeApp().request('/ping', {
      method: 'POST',
      headers: { host: 'localhost:3000', referer: 'http://localhost:8080/page' },
    });
    expect(res.status).toBe(401);
  });

  it('explicit allowedOrigins wins over the Host comparison', async () => {
    const app = makeApp({ allowedOrigins: ['http://localhost:8080'] });
    expect((await post(app, 'http://localhost:8080', 'localhost:3000')).status).toBe(200);
    // …and replaces the localhost rule: a same-origin localhost not listed fails.
    expect((await post(app, 'http://localhost:3000', 'localhost:3000')).status).toBe(401);
  });

  it('GET requests bypass the check regardless of origin (regression)', async () => {
    const app = makeApp({ allowedOrigins: ['https://app.example.com'] });
    const res = await app.request('/ping', {
      method: 'GET',
      headers: { origin: 'https://evil.com' },
    });
    expect(res.status).toBe(200);
  });
});
