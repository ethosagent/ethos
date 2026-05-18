import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { openAiCors } from '../../middleware/openai-cors';

function makeApp(origins?: string): Hono {
  const app = new Hono();
  app.use('*', openAiCors({ origins }));
  app.get('/ping', (c) => c.json({ ok: true }));
  app.post('/chat', (c) => c.json({ ok: true }));
  return app;
}

describe('openAiCors middleware', () => {
  it('allows all origins when set to *', async () => {
    const app = makeApp('*');
    const res = await app.request('/ping', {
      headers: { Origin: 'https://example.com' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('allows a listed origin', async () => {
    const app = makeApp('https://foo.com, https://bar.com');
    const res = await app.request('/ping', {
      headers: { Origin: 'https://foo.com' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://foo.com');
  });

  it('rejects an unlisted origin', async () => {
    const app = makeApp('https://foo.com');
    const res = await app.request('/ping', {
      headers: { Origin: 'https://evil.com' },
    });
    const aoh = res.headers.get('access-control-allow-origin');
    expect(!aoh || aoh === '').toBe(true);
  });

  it('does not set CORS headers when origins is empty (default deny)', async () => {
    const app = makeApp('');
    const res = await app.request('/ping', {
      headers: { Origin: 'https://example.com' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('responds to OPTIONS preflight with correct methods', async () => {
    const app = makeApp('*');
    const res = await app.request('/chat', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://example.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Authorization, Content-Type',
      },
    });
    // Preflight should be 204 or 200
    expect(res.status).toBeLessThanOrEqual(204);
    const allowMethods = res.headers.get('access-control-allow-methods');
    expect(allowMethods).toMatch(/POST/);
  });
});
