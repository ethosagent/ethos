import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { rateLimitMiddleware } from '../../middleware/rate-limit';

// WEB-006 — the bucket key must not be derived from the spoofable
// X-Forwarded-For header unless `trustProxy` is explicitly enabled.

function makeApp(trustProxy: boolean): Hono {
  const app = new Hono();
  app.use('*', rateLimitMiddleware({ maxTokens: 3, trustProxy }));
  app.get('/ping', (c) => c.json({ ok: true }));
  return app;
}

function ping(app: Hono, xff: string) {
  return app.request('/ping', { headers: { 'x-forwarded-for': xff } });
}

describe('rateLimitMiddleware bucket keying (WEB-006)', () => {
  it('with trustProxy off, rotating X-Forwarded-For does NOT mint fresh buckets', async () => {
    const app = makeApp(false);
    // Each request spoofs a distinct XFF. With trustProxy off, the header is
    // ignored, so all share one bucket and drain it.
    expect((await ping(app, '1.1.1.1')).status).toBe(200);
    expect((await ping(app, '2.2.2.2')).status).toBe(200);
    expect((await ping(app, '3.3.3.3')).status).toBe(200);
    // 4th spoofed origin — bucket is empty → rate limited.
    expect((await ping(app, '4.4.4.4')).status).toBe(429);
  });

  it('with trustProxy on, distinct X-Forwarded-For values get distinct buckets', async () => {
    const app = makeApp(true);
    // Each distinct XFF is trusted and gets its own fresh bucket, so none is
    // ever exhausted by a single request.
    expect((await ping(app, '1.1.1.1')).status).toBe(200);
    expect((await ping(app, '2.2.2.2')).status).toBe(200);
    expect((await ping(app, '3.3.3.3')).status).toBe(200);
    expect((await ping(app, '4.4.4.4')).status).toBe(200);
  });
});
