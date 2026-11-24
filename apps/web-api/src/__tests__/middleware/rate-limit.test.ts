import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { clientKeyOf, createTokenBuckets, rateLimitMiddleware } from '../../middleware/rate-limit';

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

describe('clientKeyOf', () => {
  const src = { forwardedFor: '1.1.1.1, 2.2.2.2', realIp: '3.3.3.3', remoteAddress: '9.9.9.9' };
  it('ignores forwarding headers unless trustProxy', () => {
    expect(clientKeyOf(src, false)).toBe('9.9.9.9');
    expect(clientKeyOf({}, false)).toBe('unknown');
  });
  it('trustProxy prefers the first X-Forwarded-For, then X-Real-IP, then the peer', () => {
    expect(clientKeyOf(src, true)).toBe('1.1.1.1');
    expect(clientKeyOf({ realIp: '3.3.3.3', remoteAddress: '9.9.9.9' }, true)).toBe('3.3.3.3');
    expect(clientKeyOf({ remoteAddress: '9.9.9.9' }, true)).toBe('9.9.9.9');
  });
});

describe('createTokenBuckets', () => {
  it('prunes idle buckets but keeps locked and partly used ones', () => {
    const b = createTokenBuckets({ maxTokens: 2, refillMs: 1000, lockoutMs: 60_000 });
    b.take('locked', 0);
    b.take('locked', 0);
    b.take('locked', 0); // empty: locks out
    b.take('used', 0); // one token spent, not full
    for (let i = 0; i < 300; i++) b.take(`ip${i}`, 10_000);
    expect(b.size()).toBeGreaterThan(300);
    // Later takes cross the prune interval: the idle `ip*` buckets (full again) are gone ...
    for (let i = 0; i < 300; i++) b.take('later', 20_000 + i);
    expect(b.size()).toBeLessThan(10);
    // ... and the locked bucket still refuses.
    expect(b.take('locked', 20_000).ok).toBe(false);
  });

  it('caps the number of tracked keys by dropping unlocked ones', () => {
    const b = createTokenBuckets({ maxTokens: 5, refillMs: 60_000, lockoutMs: 0, maxKeys: 10 });
    for (let i = 0; i < 50; i++) b.take(`ip${i}`, 0);
    expect(b.size()).toBeLessThanOrEqual(11);
  });
});
