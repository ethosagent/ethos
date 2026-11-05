import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore, SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebApi, WebTokenRepository } from '../../index';
import {
  makeStubAgentLoop,
  makeStubMemoryBundle,
  makeStubPersonalityRegistry,
} from '../test-helpers';

// plan mcp-device-code-login §7.4 — the device RPCs are cookie-only (mcp has no
// SCOPE_MAP entry), rate-limited (routes/index.ts), and zod-validated.

describe('mcp device RPC routes', () => {
  let dir: string;
  let store: SQLiteSessionStore;
  let keys: SqliteApiKeyStore;
  let app: ReturnType<typeof createWebApi>['app'];
  let cookie: string;
  let secret: string;
  const sameOrigin = { origin: 'http://localhost:3000', host: 'localhost:3000' };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-mcp-device-'));
    store = new SQLiteSessionStore(':memory:');
    keys = new SqliteApiKeyStore(':memory:');
    app = createWebApi({
      dataDir: dir,
      sessionStore: store,
      memoryBundle: makeStubMemoryBundle(),
      agentLoop: makeStubAgentLoop(),
      personalities: makeStubPersonalityRegistry(),
      chatDefaults: { model: 'm', provider: 'p' },
      apiKeys: keys,
    }).app;
    const token = await new WebTokenRepository({
      dataDir: dir,
      storage: new FsStorage(),
    }).getOrCreate();
    const exchange = await app.request(`/auth/exchange?t=${token}`, { headers: sameOrigin });
    cookie = (exchange.headers.get('set-cookie') ?? '').split(/;\s*/)[0] ?? '';
    expect(cookie).toBeTruthy();
    secret = (await keys.create({ name: 'k', scopes: ['sessions:read'] })).secret;
  });

  afterEach(async () => {
    store.close();
    keys.close();
    await rm(dir, { recursive: true, force: true });
  });

  function post(path: string, json: unknown, auth: Record<string, string>) {
    return app.request(`/rpc/mcp/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...sameOrigin, ...auth },
      body: JSON.stringify({ json }),
    });
  }

  it('bearer auth is refused 403', async () => {
    const bearer = { authorization: `Bearer ${secret}` };
    for (const [path, body] of [
      ['deviceStart', { serverName: 'granola' }],
      ['deviceStatus', { flowId: 'f'.repeat(20) }],
      ['deviceCancel', { flowId: 'f'.repeat(20) }],
    ] as const) {
      const res = await post(path, body, bearer);
      expect(res.status).toBe(403);
    }
  });

  it('an unauthenticated call is 401', async () => {
    const res = await post('deviceStart', { serverName: 'granola' }, {});
    expect(res.status).toBe(401);
  });

  it('deviceStart for an unknown server returns ok:false not_found with cookie auth', async () => {
    const res = await post('deviceStart', { serverName: 'nope' }, { cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { json: { ok: boolean; code: string } };
    expect(body.json).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('deviceStatus of an unknown flow is expired', async () => {
    const res = await post('deviceStatus', { flowId: 'f'.repeat(20) }, { cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { json: { status: string } };
    expect(body.json.status).toBe('expired');
  });

  it('an invalid body is 400', async () => {
    const res = await post('deviceStart', { serverName: '' }, { cookie });
    expect(res.status).toBe(400);
  });

  it('deviceStart is rate-limited 429 on the sixth call in a minute', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await post('deviceStart', { serverName: 'nope' }, { cookie })).status);
    }
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
  });
});
