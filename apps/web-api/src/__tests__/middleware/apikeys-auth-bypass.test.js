import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cookieOnlyGuard, dualAuth, resolveScope } from '../../middleware/dual-auth';
import { errorHandler } from '../../middleware/error-envelope';
import { WebTokenRepository } from '../../repositories/web-token.repository';
// Regression tests for the apiKeys namespace auth bypass (CRITICAL).
//
// The `/rpc/apiKeys/*` namespace must ONLY be accessible via cookie auth.
// Bearer tokens (API keys) must be rejected in two layers:
//   1. The route-level `cookieOnlyGuard()` middleware
//   2. Defense-in-depth rejection inside the `dualAuth` bearer path
describe('apiKeys namespace — bearer token rejection', () => {
    let store;
    let secret;
    let app;
    let cookieToken;
    beforeEach(async () => {
        store = new SqliteApiKeyStore(':memory:');
        const created = await store.create({ name: 'test-key', scopes: ['sessions:read'] });
        secret = created.secret;
        // Minimal Hono app that mirrors the production route wiring:
        // dualAuth on /rpc/*, then cookieOnlyGuard on /rpc/apiKeys/*
        app = new Hono();
        app.onError(errorHandler);
        const dir = mkdtempSync(join(tmpdir(), 'ethos-bypass-'));
        const tokens = new WebTokenRepository({ dataDir: dir });
        cookieToken = await tokens.getOrCreate();
        const dual = dualAuth({
            tokens,
            apiKeys: store,
            scopeForPath: resolveScope,
        });
        app.use('/rpc/*', dual);
        app.use('/rpc/apiKeys/*', cookieOnlyGuard());
        // Stub handlers that return 200 if middleware passes
        app.post('/rpc/apiKeys/create', (c) => c.json({ ok: true }));
        app.post('/rpc/apiKeys/list', (c) => c.json({ ok: true }));
        app.post('/rpc/sessions/list', (c) => c.json({ ok: true }));
    });
    afterEach(() => {
        store.close();
    });
    it('rejects bearer token on /rpc/apiKeys/create with FORBIDDEN', async () => {
        const res = await app.request('/rpc/apiKeys/create', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${secret}`,
            },
            body: JSON.stringify({}),
        });
        expect(res.status).toBe(403);
        const body = (await res.json());
        expect(body.code).toBe('FORBIDDEN');
        expect(body.error).toMatch(/apiKeys.*cookie/i);
    });
    it('rejects bearer token on /rpc/apiKeys/list with FORBIDDEN', async () => {
        const res = await app.request('/rpc/apiKeys/list', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${secret}`,
            },
            body: JSON.stringify({}),
        });
        expect(res.status).toBe(403);
        const body = (await res.json());
        expect(body.code).toBe('FORBIDDEN');
    });
    it('allows cookie auth on /rpc/apiKeys/create (not blocked by guard)', async () => {
        // dualAuth checks getCookie(c, 'ethos_auth') against tokens.matches().
        // The stored token IS the cookie value before exchange rotates it.
        const res = await app.request('/rpc/apiKeys/create', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                cookie: `ethos_auth=${cookieToken}`,
            },
            body: JSON.stringify({}),
        });
        expect(res.status).toBe(200);
        const body = (await res.json());
        expect(body.ok).toBe(true);
    });
    it('still allows bearer token on non-apiKeys namespaces', async () => {
        // sessions namespace should work fine with bearer + correct scope
        const withScope = await store.create({ name: 'sessions-key', scopes: ['sessions:read'] });
        const res = await app.request('/rpc/sessions/list', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${withScope.secret}`,
            },
            body: JSON.stringify({}),
        });
        expect(res.status).toBe(200);
    });
});
