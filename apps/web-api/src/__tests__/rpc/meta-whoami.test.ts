import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dualAuth, resolveScope } from '../../middleware/dual-auth';
import { errorHandler } from '../../middleware/error-envelope';
import { WebTokenRepository } from '../../repositories/web-token.repository';
import type { ServiceContainer } from '../../routes/index';
import { rpcRoutes } from '../../routes/rpc';

// mobile-app plan S12 — `meta.whoami` over the real `/rpc` stack, so the
// `ANY_KEY` sentinel (a bearer key needs no scope to reach it) and the
// never-the-secret-or-hash contract are pinned where they are enforced.

describe('meta.whoami over /rpc', () => {
  let dir: string;
  let keys: SqliteApiKeyStore;
  let app: Hono;
  let cookie: string;

  function buildApp(version?: string) {
    app = new Hono();
    app.onError(errorHandler);
    app.use('/rpc/*', dualAuth({ tokens, apiKeys: keys, scopeForPath: resolveScope }));
    app.route(
      '/rpc',
      rpcRoutes({
        services: { ...(version ? { version } : {}) } as unknown as ServiceContainer,
      }),
    );
  }

  let tokens: WebTokenRepository;

  function whoami(auth: { bearer?: string; cookie?: string }) {
    return app.request('/rpc/meta/whoami', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(auth.bearer ? { authorization: `Bearer ${auth.bearer}` } : {}),
        ...(auth.cookie ? { cookie: `ethos_auth=${auth.cookie}` } : {}),
      },
      body: JSON.stringify({ json: {} }),
    });
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ethos-whoami-rpc-'));
    keys = new SqliteApiKeyStore(join(dir, 'sessions.db'));
    tokens = new WebTokenRepository({ dataDir: dir, storage: new FsStorage() });
    cookie = await tokens.getOrCreate();
    buildApp();
  });

  afterEach(() => {
    keys.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('bearer → authMethod bearer and the key’s name/prefix/scopes/createdAt/lastUsed', async () => {
    const { secret, record } = await keys.create({ name: 'iphone', scopes: ['sessions:read'] });
    const res = await whoami({ bearer: secret });
    expect(res.status).toBe(200);
    const { json } = (await res.json()) as { json: Record<string, unknown> };
    expect(json).toEqual({
      authMethod: 'bearer',
      key: {
        name: 'iphone',
        prefix: record.prefix,
        scopes: ['sessions:read'],
        createdAt: expect.any(String),
        lastUsed: null,
      },
    });
    expect(JSON.stringify(json)).not.toContain(secret);
  });

  it('a key with zero scopes → 200', async () => {
    const { secret } = await keys.create({ name: 'no-scopes', scopes: [] });
    const res = await whoami({ bearer: secret });
    expect(res.status).toBe(200);
    const { json } = (await res.json()) as { json: { key: { scopes: string[] } } };
    expect(json.key.scopes).toEqual([]);
  });

  it('a revoked key → UNAUTHORIZED (refused before the handler)', async () => {
    const { secret } = await keys.create({ name: 'revoked', scopes: ['sessions:read'] });
    await keys.revoke(secret.slice(0, 17));
    const res = await whoami({ bearer: secret });
    expect(res.status).toBe(401);
  });

  it('cookie → { authMethod: "cookie" }', async () => {
    const res = await whoami({ cookie });
    expect(res.status).toBe(200);
    const { json } = (await res.json()) as { json: Record<string, unknown> };
    expect(json).toEqual({ authMethod: 'cookie' });
  });

  it('version present in both shapes when configured', async () => {
    buildApp('0.8.0');
    const { secret } = await keys.create({ name: 'iphone', scopes: [] });
    const bearerRes = await whoami({ bearer: secret });
    const cookieRes = await whoami({ cookie });
    expect(((await bearerRes.json()) as { json: { version?: string } }).json.version).toBe('0.8.0');
    expect(((await cookieRes.json()) as { json: { version?: string } }).json.version).toBe('0.8.0');
  });

  it('version absent when not configured', async () => {
    const res = await whoami({ cookie });
    const { json } = (await res.json()) as { json: Record<string, unknown> };
    expect('version' in json).toBe(false);
  });
});
