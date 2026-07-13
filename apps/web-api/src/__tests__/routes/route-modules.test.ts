import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebApi, WebTokenRepository } from '../../index';
import type { RouteModule } from '../../routes/route-module';
import {
  makeStubAgentLoop,
  makeStubMemoryProvider,
  makeStubPersonalityRegistry,
} from '../test-helpers';

// Phase 2 proof (plan §17): a trivial route module exercises the seam before
// A2A exists. Asserts the four behaviours the seam promises — public reaches
// without auth, a declared auth posture gates the module, a disabled module is
// not mounted, and the built-in routes are unchanged.

function pingRouter(): Hono {
  const router = new Hono();
  router.get('/ping', (c) => c.json({ ok: true }));
  return router;
}

describe('createWebApi — route-module seam', () => {
  let dir: string;
  let store: SQLiteSessionStore;
  let app: ReturnType<typeof createWebApi>['app'];
  let token: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-webapi-routemod-'));
    store = new SQLiteSessionStore(':memory:');

    const routeModules: RouteModule[] = [
      {
        basePath: '/_probe',
        router: pingRouter(),
        auth: 'public',
        description: 'Trivial public probe (Phase 2 seam proof).',
      },
      {
        basePath: '/_bearer',
        router: pingRouter(),
        auth: 'bearer',
        description: 'Trivial auth-gated probe (Phase 2 seam proof).',
      },
      {
        basePath: '/_disabled',
        router: pingRouter(),
        auth: 'public',
        description: 'Disabled probe — must NOT be mounted.',
        enabled: false,
      },
    ];

    app = createWebApi({
      dataDir: dir,
      sessionStore: store,
      memoryProvider: makeStubMemoryProvider(),
      agentLoop: makeStubAgentLoop(),
      personalities: makeStubPersonalityRegistry(),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
      routeModules,
    }).app;

    const tokens = new WebTokenRepository({ dataDir: dir, storage: new FsStorage() });
    token = await tokens.getOrCreate();
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('public module route is reachable without auth', async () => {
    const res = await app.request('/_probe/ping');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('auth-gated module returns 401 without a credential', async () => {
    const res = await app.request('/_bearer/ping');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UNAUTHORIZED');
  });

  it('auth-gated module passes with a valid credential', async () => {
    const exchange = await app.request(`/auth/exchange?t=${token}`, {
      headers: { origin: 'http://localhost:3000' },
    });
    const cookieHeader = parseSetCookieValue(exchange.headers.get('set-cookie'));
    expect(cookieHeader).toBeTruthy();

    const res = await app.request('/_bearer/ping', {
      headers: { cookie: cookieHeader as string },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('disabled module is NOT mounted (404)', async () => {
    const res = await app.request('/_disabled/ping');
    expect(res.status).toBe(404);
  });

  it('built-in routes still work unchanged (rpc still 401 without auth)', async () => {
    const res = await app.request('/rpc/sessions/list', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UNAUTHORIZED');
  });
});

// Stage 1c: `enabledCheck` is a LIVE per-request gate — distinct from the
// mount-time static `enabled?`. A module stays mounted but 404s while the gate
// returns false, and starts serving the moment it flips true, WITHOUT a restart.
describe('createWebApi — route-module live enabledCheck gate', () => {
  let dir: string;
  let store: SQLiteSessionStore;
  let app: ReturnType<typeof createWebApi>['app'];
  const state = { enabled: false };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-webapi-livegate-'));
    store = new SQLiteSessionStore(':memory:');
    state.enabled = false;

    const routeModules: RouteModule[] = [
      {
        basePath: '/_live',
        router: pingRouter(),
        auth: 'public',
        description: 'Live-gated public probe (Stage 1c).',
        enabledCheck: () => state.enabled,
      },
    ];

    app = createWebApi({
      dataDir: dir,
      sessionStore: store,
      memoryProvider: makeStubMemoryProvider(),
      agentLoop: makeStubAgentLoop(),
      personalities: makeStubPersonalityRegistry(),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
      routeModules,
    }).app;
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('404s (DISABLED) while the gate is false and serves when flipped true — live, between requests', async () => {
    const disabled = await app.request('/_live/ping');
    expect(disabled.status).toBe(404);
    expect((await disabled.json()) as { error: string }).toEqual({ error: 'DISABLED' });

    // Flip live — no restart, no re-mount.
    state.enabled = true;
    const enabled = await app.request('/_live/ping');
    expect(enabled.status).toBe(200);
    expect((await enabled.json()) as { ok: boolean }).toEqual({ ok: true });

    // And back off again.
    state.enabled = false;
    const reDisabled = await app.request('/_live/ping');
    expect(reDisabled.status).toBe(404);
  });
});

// `set-cookie` from Hono's test client is a single joined header; we only ever
// set one auth cookie, so extracting the value before the first attribute is
// enough (mirrors auth-and-rpc.test.ts).
function parseSetCookieValue(raw: string | null): string | null {
  if (!raw) return null;
  const first = raw.split(/;\s*/)[0];
  return first ?? null;
}
