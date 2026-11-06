import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCookieVerifier } from '../../middleware/cookie-verifier';
import { dualAuth, resolveScope, SCOPE_MAP } from '../../middleware/dual-auth';
import { errorHandler } from '../../middleware/error-envelope';
import { WebSessionStore } from '../../repositories/web-session.store';
import { WebTokenRepository } from '../../repositories/web-token.repository';

// unified-catalog D11: `catalog` is deliberately absent from SCOPE_MAP, so
// dualAuth's experimental branch refuses every bearer key.

describe('catalog namespace is cookie-only (D11)', () => {
  let store: SqliteApiKeyStore;
  let app: Hono;

  beforeEach(() => {
    store = new SqliteApiKeyStore(':memory:');
    app = new Hono();
    app.onError(errorHandler);
    const dir = mkdtempSync(join(tmpdir(), 'ethos-catalog-auth-'));
    const tokens = new WebTokenRepository({ dataDir: dir, storage: new FsStorage() });
    const sessions = new WebSessionStore({ dataDir: dir, storage: new FsStorage() });
    app.use(
      '/rpc/*',
      dualAuth({
        verifyCookie: createCookieVerifier({ tokens, sessions }),
        apiKeys: store,
        scopeForPath: resolveScope,
      }),
    );
    for (const proc of ['list', 'install', 'setSkillGrant']) {
      app.post(`/rpc/catalog/${proc}`, (c) => c.json({ ok: true }));
    }
  });

  afterEach(() => {
    store.close();
  });

  it('a bearer key on catalog.list is 403 FORBIDDEN', async () => {
    const { secret } = await store.create({
      name: 'broad',
      scopes: ['sessions:read', 'sessions:write', 'tools:approve'],
    });
    const res = await app.request('/rpc/catalog/list', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('FORBIDDEN');
    expect(body.error).toMatch(/experimental/);
  });

  it.each(['install', 'setSkillGrant'])(
    'a bearer key on catalog.%s is 403 FORBIDDEN',
    async (proc) => {
      const { secret } = await store.create({
        name: 'broad',
        scopes: ['sessions:read', 'sessions:write', 'tools:approve'],
      });
      const res = await app.request(`/rpc/catalog/${proc}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(403);
    },
  );

  it('catalog is not in SCOPE_MAP', () => {
    expect(Object.keys(SCOPE_MAP)).not.toContain('catalog');
  });
});
