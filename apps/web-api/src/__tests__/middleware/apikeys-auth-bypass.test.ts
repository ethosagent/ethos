import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore, SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebApi } from '../../index';
import { createCookieVerifier } from '../../middleware/cookie-verifier';
import { cookieOnlyGuard, dualAuth, resolveScope } from '../../middleware/dual-auth';
import { errorHandler } from '../../middleware/error-envelope';
import { WebSessionStore } from '../../repositories/web-session.store';
import { WebTokenRepository } from '../../repositories/web-token.repository';
import {
  makeStubAgentLoop,
  makeStubMemoryBundle,
  makeStubPersonalityRegistry,
} from '../test-helpers';

// Regression tests for the apiKeys namespace auth bypass (CRITICAL).
//
// The `/rpc/apiKeys/*` namespace must ONLY be accessible via cookie auth.
// Bearer tokens (API keys) must be rejected in two layers:
//   1. The route-level `cookieOnlyGuard()` middleware
//   2. Defense-in-depth rejection inside the `dualAuth` bearer path

// plan share-links D12: every shares procedure is cookie-only too. SCOPE_MAP.shares is all
// COOKIE_ONLY (dualAuth refuses at the scope step) and `/rpc/shares/*` mounts the guard.
const SHARES_PROCEDURES = ['preview', 'create', 'list', 'revoke'];

describe('apiKeys namespace — bearer token rejection', () => {
  let store: SqliteApiKeyStore;
  let secret: string;
  let app: Hono;
  let cookieToken: string;

  beforeEach(async () => {
    store = new SqliteApiKeyStore(':memory:');
    const created = await store.create({ name: 'test-key', scopes: ['sessions:read'] });
    secret = created.secret;

    // Minimal Hono app that mirrors the production route wiring:
    // dualAuth on /rpc/*, then cookieOnlyGuard on /rpc/apiKeys/*
    app = new Hono();
    app.onError(errorHandler);

    const dir = mkdtempSync(join(tmpdir(), 'ethos-bypass-'));
    const tokens = new WebTokenRepository({ dataDir: dir, storage: new FsStorage() });
    cookieToken = await tokens.getOrCreate();

    const sessions = new WebSessionStore({ dataDir: dir, storage: new FsStorage() });
    const dual = dualAuth({
      verifyCookie: createCookieVerifier({ tokens, sessions }),
      apiKeys: store,
      scopeForPath: resolveScope,
    });

    app.use('/rpc/*', dual);
    app.use('/rpc/apiKeys/*', cookieOnlyGuard());
    app.use('/rpc/shares/*', cookieOnlyGuard());

    // Stub handlers that return 200 if middleware passes
    app.post('/rpc/apiKeys/create', (c) => c.json({ ok: true }));
    app.post('/rpc/apiKeys/list', (c) => c.json({ ok: true }));
    for (const proc of SHARES_PROCEDURES)
      app.post(`/rpc/shares/${proc}`, (c) => c.json({ ok: true }));
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
    const body = (await res.json()) as { code: string; error: string };
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
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('FORBIDDEN');
  });

  it('allows cookie auth on /rpc/apiKeys/create (not blocked by guard)', async () => {
    // dualAuth checks getCookie(c, 'ethos_auth') through the shared cookie
    // verifier; the raw stored token stays cookie-valid (D4).
    const res = await app.request('/rpc/apiKeys/create', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `ethos_auth=${cookieToken}`,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it.each(SHARES_PROCEDURES)(
    'rejects a bearer key on /rpc/shares/%s with FORBIDDEN',
    async (proc) => {
      const key = await store.create({
        name: 'wide',
        scopes: ['sessions:read', 'sessions:write', 'chat:send'],
      });
      const res = await app.request(`/rpc/shares/${proc}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key.secret}` },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe('FORBIDDEN');
    },
  );

  it('allows cookie auth on /rpc/shares/create', async () => {
    const res = await app.request('/rpc/shares/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ethos_auth=${cookieToken}` },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
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

// Real-mount check (plan share-links D12): the hand-built app above mirrors the wiring, this one
// is `createWebApi` itself, so a refactor of routes/index.ts that drops the guard fails here.
describe('shares namespace — bearer rejection on the real createWebApi mount', () => {
  it.each(SHARES_PROCEDURES)('POST /rpc/shares/%s with a bearer key is 403', async (proc) => {
    const dir = mkdtempSync(join(tmpdir(), 'ethos-bypass-real-'));
    const sessions = new SQLiteSessionStore(':memory:');
    const keys = new SqliteApiKeyStore(':memory:');
    try {
      const { secret } = await keys.create({
        name: 'wide',
        scopes: ['sessions:read', 'sessions:write', 'chat:send'],
      });
      const { app } = createWebApi({
        dataDir: dir,
        sessionStore: sessions,
        memoryBundle: makeStubMemoryBundle(),
        agentLoop: makeStubAgentLoop(),
        personalities: makeStubPersonalityRegistry(),
        chatDefaults: { model: 'm', provider: 'p' },
        apiKeys: keys,
      });
      const res = await app.request(`/rpc/shares/${proc}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe('FORBIDDEN');
    } finally {
      sessions.close();
      keys.close();
    }
  });
});
