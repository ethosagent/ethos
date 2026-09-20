import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteApiKeyStore, SqlitePushDeviceStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dualAuth, resolveScope } from '../../middleware/dual-auth';
import { errorHandler } from '../../middleware/error-envelope';
import { WebTokenRepository } from '../../repositories/web-token.repository';
import type { ServiceContainer } from '../../routes/index';
import { rpcRoutes } from '../../routes/rpc';
import { PushDispatcher } from '../../services/push-dispatcher';
import { ExpoPushTransport } from '../../services/push-transport';

// S13(c) + S5 over the real `/rpc` stack — `dualAuth` in front of the real
// `push` handlers — so the auth rules are pinned where they are enforced:
// `listDevices` is COOKIE_ONLY in SCOPE_MAP, a bearer `push.test` ignores the
// `apiKeyId` it sends (`rpc/push.ts`), and a revoked key never reaches
// `push.register` (`dualAuth` refuses it with UNAUTHORIZED before any handler).

const ALL_ON = {
  approvals: true,
  clarify: true,
  cronFailures: true,
  teamAttention: true,
  runFinished: true,
};

describe('push namespace over /rpc', () => {
  let dir: string;
  let keys: SqliteApiKeyStore;
  let devices: SqlitePushDeviceStore;
  let app: Hono;
  let cookie: string;
  let sentTo: string[][];
  let phone: { id: string; secret: string };
  let tablet: { id: string; secret: string };

  async function mint(name: string): Promise<{ id: string; secret: string }> {
    const created = await keys.create({ name, scopes: ['push:register'] });
    return { id: created.record.id, secret: created.secret };
  }

  function rpc(path: string, auth: { bearer?: string; cookie?: string }, input: object = {}) {
    return app.request(`/rpc/push/${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(auth.bearer ? { authorization: `Bearer ${auth.bearer}` } : {}),
        ...(auth.cookie ? { cookie: `ethos_auth=${auth.cookie}` } : {}),
      },
      body: JSON.stringify({ json: input }),
    });
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ethos-push-rpc-'));
    keys = new SqliteApiKeyStore(join(dir, 'sessions.db'));
    devices = new SqlitePushDeviceStore(join(dir, 'sessions.db'));
    sentTo = [];
    const fetchFake = (async (_url: string | URL | Request, init?: RequestInit) => {
      const messages = JSON.parse(String(init?.body)) as Array<{ to: string }>;
      sentTo.push(messages.map((m) => m.to));
      return Response.json({ data: messages.map(() => ({ status: 'ok' })) });
    }) as typeof fetch;
    const dispatcher = new PushDispatcher({
      devices,
      transport: new ExpoPushTransport({
        accessToken: async () => undefined,
        onDeviceNotRegistered: (token) => devices.removeToken(token),
        fetch: fetchFake,
      }),
      personalityFor: async () => undefined,
    });

    const tokens = new WebTokenRepository({ dataDir: dir, storage: new FsStorage() });
    cookie = await tokens.getOrCreate();
    app = new Hono();
    app.onError(errorHandler);
    app.use('/rpc/*', dualAuth({ tokens, apiKeys: keys, scopeForPath: resolveScope }));
    app.route(
      '/rpc',
      rpcRoutes({ services: { push: { devices, dispatcher } } as unknown as ServiceContainer }),
    );

    phone = await mint('iphone');
    tablet = await mint('ipad');
    for (const [key, token] of [
      [phone, 'ExponentPushToken[phone-aaaaaa]'],
      [tablet, 'ExponentPushToken[ipad-bbbbbb]'],
    ] as const) {
      const res = await rpc(
        'register',
        { bearer: key.secret },
        {
          expoPushToken: token,
          platform: 'ios',
          categories: ALL_ON,
          liveActivities: false,
          appVersion: '0.1.0',
        },
      );
      expect(res.status).toBe(200);
    }
  });

  afterEach(() => {
    devices.close();
    keys.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('cookie → every non-revoked key’s device, token reduced to its tail', async () => {
    await keys.revoke(tablet.secret.slice(0, 17));
    const res = await rpc('listDevices', { cookie });
    expect(res.status).toBe(200);
    const { json } = (await res.json()) as { json: Array<Record<string, unknown>> };
    expect(json).toEqual([
      {
        apiKeyId: phone.id,
        keyName: 'iphone',
        keyPrefix: phone.secret.slice(0, 17),
        platform: 'ios',
        appVersion: '0.1.0',
        tokenTail: 'aaaaa]',
        lastRegisteredAt: expect.any(String),
      },
    ]);
    expect(JSON.stringify(json)).not.toContain('ExponentPushToken');
  });

  it('bearer → FORBIDDEN on listDevices', async () => {
    const res = await rpc('listDevices', { bearer: phone.secret });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('FORBIDDEN');
  });

  it('push.test under bearer ignores apiKeyId and sends only to the caller’s own device', async () => {
    const res = await rpc('test', { bearer: phone.secret }, { apiKeyId: tablet.id });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { json: unknown }).json).toEqual({ ok: true, sent: 1 });
    expect(sentTo).toEqual([['ExponentPushToken[phone-aaaaaa]']]);
  });

  it('push.test under cookie honours apiKeyId', async () => {
    const res = await rpc('test', { cookie }, { apiKeyId: tablet.id });
    expect(res.status).toBe(200);
    expect(sentTo).toEqual([['ExponentPushToken[ipad-bbbbbb]']]);
  });

  it('push.register with a revoked key is refused before the handler', async () => {
    await keys.revoke(phone.secret.slice(0, 17));
    const res = await rpc(
      'register',
      { bearer: phone.secret },
      {
        expoPushToken: 'ExponentPushToken[new]',
        platform: 'ios',
        categories: ALL_ON,
        liveActivities: false,
        appVersion: '0.1.0',
      },
    );
    expect(res.status).toBe(401);
    // Nothing was stored: removing the token finds no row.
    expect(devices.unregister('ExponentPushToken[new]')).toBe(false);
  });

  it('push.register under cookie is FORBIDDEN — there is no key to bind the device to', async () => {
    const res = await rpc(
      'register',
      { cookie },
      {
        expoPushToken: 'ExponentPushToken[web]',
        platform: 'ios',
        categories: ALL_ON,
        liveActivities: false,
        appVersion: '0.1.0',
      },
    );
    expect(res.status).toBe(403);
  });
});
