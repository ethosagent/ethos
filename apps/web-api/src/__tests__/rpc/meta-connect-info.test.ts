import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dualAuth, resolveScope } from '../../middleware/dual-auth';
import { errorHandler } from '../../middleware/error-envelope';
import { WebTokenRepository } from '../../repositories/web-token.repository';
import type { ServiceContainer } from '../../routes/index';
import { rpcRoutes } from '../../routes/rpc';

// mobile-app plan S13(b) — `meta.connectInfo` over the real `/rpc` stack.
// `configWebBaseUrl` is read from a stub `ConfigService` (only `.get()` is
// used by the handler); precedence is `ETHOS_PUBLIC_URL` env > `webBaseUrl`
// config > `web.host`/port bind (`rpc/connect-info.ts`).

describe('meta.connectInfo over /rpc', () => {
  let dir: string;
  let keys: SqliteApiKeyStore;
  let tokens: WebTokenRepository;
  let cookie: string;

  function buildApp(opts: {
    configWebBaseUrl?: string | null;
    webHost?: string;
    webPort?: number;
  }): Hono {
    const app = new Hono();
    app.onError(errorHandler);
    app.use('/rpc/*', dualAuth({ tokens, apiKeys: keys, scopeForPath: resolveScope }));
    app.route(
      '/rpc',
      rpcRoutes({
        services: {
          config: { get: async () => ({ webBaseUrl: opts.configWebBaseUrl ?? null }) },
          webHost: opts.webHost,
          webPort: opts.webPort,
        } as unknown as ServiceContainer,
      }),
    );
    return app;
  }

  function connectInfo(app: Hono, auth: { bearer?: string; cookie?: string }) {
    return app.request('/rpc/meta/connectInfo', {
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
    dir = mkdtempSync(join(tmpdir(), 'ethos-connect-info-rpc-'));
    keys = new SqliteApiKeyStore(join(dir, 'sessions.db'));
    tokens = new WebTokenRepository({ dataDir: dir, storage: new FsStorage() });
    cookie = await tokens.getOrCreate();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    keys.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('source ETHOS_PUBLIC_URL when the env var is set', async () => {
    vi.stubEnv('ETHOS_PUBLIC_URL', 'https://ethos.example.com');
    const app = buildApp({ webHost: '127.0.0.1', webPort: 3000 });
    const res = await connectInfo(app, { cookie });
    const { json } = (await res.json()) as { json: Record<string, unknown> };
    expect(json).toEqual({
      url: 'https://ethos.example.com',
      source: 'ETHOS_PUBLIC_URL',
      loopback: false,
    });
  });

  it('source webBaseUrl when only the config value is set', async () => {
    const app = buildApp({ configWebBaseUrl: 'https://tailnet.example.com', webHost: '127.0.0.1' });
    const res = await connectInfo(app, { cookie });
    const { json } = (await res.json()) as { json: Record<string, unknown> };
    expect(json).toEqual({
      url: 'https://tailnet.example.com',
      source: 'webBaseUrl',
      loopback: false,
    });
  });

  it('source web.host when neither env nor config is set', async () => {
    const app = buildApp({ webHost: '127.0.0.1', webPort: 3000 });
    const res = await connectInfo(app, { cookie });
    const { json } = (await res.json()) as { json: Record<string, unknown> };
    expect(json).toEqual({ url: 'http://127.0.0.1:3000', source: 'web.host', loopback: true });
  });

  it('a loopback bind with no public URL → loopback: true', async () => {
    const app = buildApp({ webHost: 'localhost', webPort: 3000 });
    const res = await connectInfo(app, { cookie });
    const { json } = (await res.json()) as { json: { loopback: boolean } };
    expect(json.loopback).toBe(true);
  });

  it('a loopback bind with webBaseUrl set → loopback: false', async () => {
    const app = buildApp({ configWebBaseUrl: 'https://ethos.example.com', webHost: '127.0.0.1' });
    const res = await connectInfo(app, { cookie });
    const { json } = (await res.json()) as { json: { loopback: boolean } };
    expect(json.loopback).toBe(false);
  });

  it('bearer → FORBIDDEN — connectInfo is cookie-only', async () => {
    const { secret } = await keys.create({ name: 'iphone', scopes: [] });
    const app = buildApp({ webHost: '127.0.0.1', webPort: 3000 });
    const res = await connectInfo(app, { bearer: secret });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('FORBIDDEN');
  });
});
