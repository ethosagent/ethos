import { SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bearerAuth } from '../../middleware/bearer-auth';

describe('bearerAuth middleware', () => {
  let store;
  let app;
  let secret;
  beforeEach(async () => {
    store = new SqliteApiKeyStore(':memory:');
    const created = await store.create({ name: 'cursor', scopes: ['chat'] });
    secret = created.secret;
    app = new Hono();
    app.use('/v1/*', bearerAuth({ store, scope: 'chat' }));
    app.get('/v1/ping', (c) => c.json({ ok: true, keyName: c.get('apiKey').name }));
  });
  afterEach(() => {
    store.close();
  });
  it('returns 200 + sets c.set(apiKey) for a valid key', async () => {
    const res = await app.request('/v1/ping', {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, keyName: 'cursor' });
  });
  it('returns 401 with OpenAI error envelope when Authorization is missing', async () => {
    const res = await app.request('/v1/ping');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.type).toBe('authentication_error');
    expect(body.error.code).toBe('invalid_api_key');
    expect(body.error.message).toMatch(/Missing Authorization/i);
  });
  it('returns 401 when the scheme is not Bearer', async () => {
    const res = await app.request('/v1/ping', {
      headers: { Authorization: `Basic ${secret}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_api_key');
  });
  it('returns 401 when the key does not start with sk-ethos-', async () => {
    const res = await app.request('/v1/ping', {
      headers: { Authorization: 'Bearer foo-bar-baz' },
    });
    expect(res.status).toBe(401);
  });
  it('returns 401 when the hash does not match a stored key', async () => {
    const res = await app.request('/v1/ping', {
      headers: { Authorization: 'Bearer sk-ethos-deadbeefdeadbeef' },
    });
    expect(res.status).toBe(401);
  });
  it('returns 401 when the key has been revoked', async () => {
    const all = await store.list();
    const target = all[0];
    if (!target) throw new Error('expected one key');
    await store.revoke(target.prefix);
    const res = await app.request('/v1/ping', {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(401);
  });
  it('returns 403 with permission_error when the key lacks the required scope', async () => {
    const adminApp = new Hono();
    adminApp.use('/v1/*', bearerAuth({ store, scope: 'admin' }));
    adminApp.get('/v1/ping', (c) => c.json({ ok: true }));
    const res = await adminApp.request('/v1/ping', {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.type).toBe('permission_error');
    expect(body.error.code).toBe('insufficient_scope');
  });
  it('touches last_used on a successful request', async () => {
    const before = (await store.list())[0]?.lastUsed;
    expect(before).toBeNull();
    await app.request('/v1/ping', {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const after = (await store.list())[0]?.lastUsed;
    expect(after).toBeInstanceOf(Date);
  });
  it('coalesces last_used writes within the throttle window (no SQLite write per request)', async () => {
    // Spy on the underlying store. The middleware should write once on the
    // first request and then skip subsequent calls until the throttle expires.
    const touch = vi.spyOn(store, 'touchLastUsed');
    const headers = { Authorization: `Bearer ${secret}` };
    await app.request('/v1/ping', { headers });
    await app.request('/v1/ping', { headers });
    await app.request('/v1/ping', { headers });
    expect(touch).toHaveBeenCalledTimes(1);
    touch.mockRestore();
  });
});
