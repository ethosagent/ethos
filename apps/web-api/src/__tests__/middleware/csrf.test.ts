// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${ETHOS_HOME}` /
// `${self}` are literal fs_reach substitution tokens, not JS template strings.
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import type { PersonalityConfig } from '@ethosagent/types';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebApi, WebTokenRepository } from '../../index';
import { type CsrfMiddlewareOptions, csrfMiddleware } from '../../middleware/csrf';
import { errorHandler } from '../../middleware/error-envelope';
import {
  makeStubAgentLoop,
  makeStubMemoryBundle,
  makeStubPersonalityRegistry,
} from '../test-helpers';

function makeApp(opts: CsrfMiddlewareOptions = {}): Hono {
  const app = new Hono();
  app.onError(errorHandler);
  app.use('*', csrfMiddleware(opts));
  app.post('/ping', (c) => c.json({ ok: true }));
  app.get('/ping', (c) => c.json({ ok: true }));
  return app;
}

function post(app: Hono, origin: string | undefined, host = 'localhost:3000') {
  return app.request('/ping', {
    method: 'POST',
    headers: { host, ...(origin ? { origin } : {}) },
  });
}

describe('csrfMiddleware isAllowed', () => {
  it('no allowedOrigins set, localhost origin is allowed (regression)', async () => {
    const app = makeApp();
    const res = await post(app, 'http://localhost:3000');
    expect(res.status).toBe(200);
  });

  it('no allowedOrigins set, non-localhost origin is blocked', async () => {
    const app = makeApp();
    const res = await post(app, 'https://evil.com');
    expect(res.status).toBe(401);
  });

  it('allowedOrigins exact match is allowed', async () => {
    const app = makeApp({ allowedOrigins: ['https://app.example.com'] });
    const res = await post(app, 'https://app.example.com');
    expect(res.status).toBe(200);
  });

  it('allowedOrigins with a different origin is blocked', async () => {
    const app = makeApp({ allowedOrigins: ['https://app.example.com'] });
    const res = await post(app, 'https://other.example.com');
    expect(res.status).toBe(401);
  });

  it('wildcard allowedOrigins matches a subdomain', async () => {
    const app = makeApp({ allowedOrigins: ['*.ethos.example.com'] });
    const res = await post(app, 'https://foo.ethos.example.com');
    expect(res.status).toBe(200);
  });

  it('wildcard allowedOrigins matches the bare apex domain', async () => {
    const app = makeApp({ allowedOrigins: ['*.ethos.example.com'] });
    const res = await post(app, 'https://ethos.example.com');
    expect(res.status).toBe(200);
  });

  it('wildcard allowedOrigins does not match an unrelated domain', async () => {
    const app = makeApp({ allowedOrigins: ['*.ethos.example.com'] });
    const res = await post(app, 'https://evil.com');
    expect(res.status).toBe(401);
  });

  // openclaw-advisory-fixes L-d: a localhost Origin passes only when its
  // host:port equals the request Host — true same-origin.
  it('localhost origin on the same port as Host is allowed', async () => {
    const res = await post(makeApp(), 'http://localhost:5173', 'localhost:5173');
    expect(res.status).toBe(200);
  });

  it('localhost origin on a different port from Host is blocked', async () => {
    const res = await post(makeApp(), 'http://localhost:8080', 'localhost:3000');
    expect(res.status).toBe(401);
  });

  it('127.0.0.1 origin against a localhost Host on the same port is blocked', async () => {
    const res = await post(makeApp(), 'http://127.0.0.1:3000', 'localhost:3000');
    expect(res.status).toBe(401);
  });

  it('[::1] origin on the same port as Host is allowed', async () => {
    const res = await post(makeApp(), 'http://[::1]:3000', '[::1]:3000');
    expect(res.status).toBe(200);
  });

  it('a Referer from another localhost port is blocked when Origin is absent', async () => {
    const res = await makeApp().request('/ping', {
      method: 'POST',
      headers: { host: 'localhost:3000', referer: 'http://localhost:8080/page' },
    });
    expect(res.status).toBe(401);
  });

  it('explicit allowedOrigins wins over the Host comparison', async () => {
    const app = makeApp({ allowedOrigins: ['http://localhost:8080'] });
    expect((await post(app, 'http://localhost:8080', 'localhost:3000')).status).toBe(200);
    // …and replaces the localhost rule: a same-origin localhost not listed fails.
    expect((await post(app, 'http://localhost:3000', 'localhost:3000')).status).toBe(401);
  });

  it('GET requests bypass the check regardless of origin (regression)', async () => {
    const app = makeApp({ allowedOrigins: ['https://app.example.com'] });
    const res = await app.request('/ping', {
      method: 'GET',
      headers: { origin: 'https://evil.com' },
    });
    expect(res.status).toBe(200);
  });
});

// S8 (plan openclaw-2026.9.6-gaps). The cookie-auth route modules (`/documents`,
// `/api/personalities` avatars, `/backup`) are not under `/rpc`, so the CSRF
// check never ran on them: a page on another localhost port is same-SITE (the
// port is not part of the site), so the `SameSite=Strict` cookie rides along
// and `POST /documents/upload` wrote into a workdir. The route-module mount
// loop in `createRoutes` (routes/index.ts) now runs `csrfMiddleware` after the
// cookie auth for every `auth: 'cookie'` module.
describe('csrf on cookie-auth route modules (S8)', () => {
  let dataDir: string;
  let workdir: string;
  let store: SQLiteSessionStore;
  let app: ReturnType<typeof createWebApi>['app'];
  let cookie: string;
  const crossOrigin = { origin: 'http://localhost:5999', host: 'localhost:3000' };
  const sameOrigin = { origin: 'http://localhost:3000', host: 'localhost:3000' };

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ethos-csrf-modules-'));
    workdir = join(dataDir, 'workspace', 'writer');
    await mkdir(workdir, { recursive: true });
    store = new SQLiteSessionStore(':memory:');
    const registry = makeStubPersonalityRegistry(
      [
        {
          id: 'writer',
          name: 'Writer',
          fs_reach: { workdir: ['${ETHOS_HOME}/workspace/${self}'] },
        } as PersonalityConfig,
      ],
      dataDir,
    );
    await registry.create({ id: 'nova', name: 'Nova', toolset: [], soulMd: '# Nova\n' });
    app = createWebApi({
      dataDir,
      sessionStore: store,
      memoryBundle: makeStubMemoryBundle(),
      agentLoop: makeStubAgentLoop(),
      personalities: registry,
      chatDefaults: { model: 'm', provider: 'p' },
    }).app;
    const token = await new WebTokenRepository({
      dataDir,
      storage: new FsStorage(),
    }).getOrCreate();
    const exchange = await app.request(`/auth/exchange?t=${token}`, { headers: sameOrigin });
    cookie = (exchange.headers.get('set-cookie') ?? '').split(/;\s*/)[0] ?? '';
    expect(cookie).toBeTruthy();
  });

  afterEach(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const upload = (headers: Record<string, string>) =>
    app.request('/documents/upload?personality=writer&root=0&path=planted.txt', {
      method: 'POST',
      headers: { cookie, ...headers },
      body: 'x',
    });

  it('refuses a cross-origin POST /documents/upload and writes nothing', async () => {
    const res = await upload(crossOrigin);
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).toMatch(/Cross-origin/);
    await expect(stat(join(workdir, 'planted.txt'))).rejects.toThrow();
  });

  it('refuses a POST /documents/upload with no Origin or Referer', async () => {
    const res = await upload({ host: 'localhost:3000' });
    expect(res.status).toBe(401);
    await expect(stat(join(workdir, 'planted.txt'))).rejects.toThrow();
  });

  it('accepts a same-origin POST /documents/upload', async () => {
    const res = await upload(sameOrigin);
    expect(res.status).toBe(200);
    expect((await stat(join(workdir, 'planted.txt'))).isFile()).toBe(true);
  });

  it('refuses a cross-origin avatar DELETE', async () => {
    const res = await app.request('/api/personalities/nova/avatar', {
      method: 'DELETE',
      headers: { cookie, ...crossOrigin },
    });
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).toMatch(/Cross-origin/);
  });
});
