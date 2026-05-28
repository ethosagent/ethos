import { SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { bearerAuth } from '../../middleware/bearer-auth';
import { idempotencyMiddleware } from '../../middleware/idempotency';
import { IdempotencyStore } from '../../stores/idempotency-store';
function makeApp(store, apiKeys) {
    const app = new Hono();
    app.use('*', bearerAuth({ store: apiKeys, scope: 'chat' }));
    app.use('*', idempotencyMiddleware({ store }));
    app.post('/chat', async (c) => {
        const body = await c.req.json();
        return c.json({ result: `processed: ${body.input}` });
    });
    return app;
}
describe('idempotency middleware', () => {
    const stores = [];
    afterEach(() => {
        for (const s of stores)
            s.close();
        stores.length = 0;
    });
    async function setup() {
        const apiKeys = new SqliteApiKeyStore(':memory:');
        const idempotencyStore = new IdempotencyStore(':memory:');
        stores.push(apiKeys, idempotencyStore);
        const created = await apiKeys.create({ name: 'test', scopes: ['chat'] });
        const app = makeApp(idempotencyStore, apiKeys);
        return { app, bearer: { Authorization: `Bearer ${created.secret}` }, idempotencyStore };
    }
    it('passes through when no Idempotency-Key header', async () => {
        const { app, bearer } = await setup();
        const res = await app.request('/chat', {
            method: 'POST',
            headers: { ...bearer, 'content-type': 'application/json' },
            body: JSON.stringify({ input: 'hello' }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json());
        expect(body.result).toBe('processed: hello');
    });
    it('returns cached response on second call with same key + same body', async () => {
        const { app, bearer } = await setup();
        const headers = { ...bearer, 'content-type': 'application/json', 'idempotency-key': 'key-1' };
        const body = JSON.stringify({ input: 'test' });
        const res1 = await app.request('/chat', { method: 'POST', headers, body });
        expect(res1.status).toBe(200);
        const res2 = await app.request('/chat', { method: 'POST', headers, body });
        expect(res2.status).toBe(200);
        const body1 = await res1.json();
        const body2 = await res2.json();
        expect(body1).toEqual(body2);
    });
    it('returns 422 when same key is reused with different body', async () => {
        const { app, bearer } = await setup();
        const baseHeaders = {
            ...bearer,
            'content-type': 'application/json',
            'idempotency-key': 'key-2',
        };
        await app.request('/chat', {
            method: 'POST',
            headers: baseHeaders,
            body: JSON.stringify({ input: 'first' }),
        });
        const res = await app.request('/chat', {
            method: 'POST',
            headers: baseHeaders,
            body: JSON.stringify({ input: 'different' }),
        });
        expect(res.status).toBe(422);
        const body = (await res.json());
        expect(body.error.code).toBe('idempotency_key_reused');
    });
    it('skips idempotency for streaming requests', async () => {
        const apiKeys = new SqliteApiKeyStore(':memory:');
        const idempotencyStore = new IdempotencyStore(':memory:');
        stores.push(apiKeys, idempotencyStore);
        const created = await apiKeys.create({ name: 'test', scopes: ['chat'] });
        let callCount = 0;
        const app = new Hono();
        app.use('*', bearerAuth({ store: apiKeys, scope: 'chat' }));
        app.use('*', idempotencyMiddleware({ store: idempotencyStore }));
        app.post('/chat', async (c) => {
            callCount++;
            return c.json({ call: callCount });
        });
        const headers = {
            Authorization: `Bearer ${created.secret}`,
            'content-type': 'application/json',
            'idempotency-key': 'stream-key',
        };
        // First call with stream: true
        await app.request('/chat', {
            method: 'POST',
            headers,
            body: JSON.stringify({ input: 'test', stream: true }),
        });
        // Second call with same key — should NOT return cached because streaming is bypassed
        const res2 = await app.request('/chat', {
            method: 'POST',
            headers,
            body: JSON.stringify({ input: 'test', stream: true }),
        });
        const body2 = (await res2.json());
        expect(body2.call).toBe(2); // handler was called twice, not cached
    });
});
