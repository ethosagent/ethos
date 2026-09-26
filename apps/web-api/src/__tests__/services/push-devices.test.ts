import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type RegisterPushDeviceInput,
  SqliteApiKeyStore,
  SqlitePushDeviceStore,
} from '@ethosagent/session-sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PushDispatcher } from '../../services/push-dispatcher';
import { ExpoPushTransport } from '../../services/push-transport';

// S5 — the device rows and the Expo transport against a real sessions.db:
// a revoked key's devices drop out of the fan-out through the store's join
// (no cascade), `unregister` and the retention sweep remove rows,
// `DeviceNotRegistered` (ticket or receipt) removes the token, a 5xx reaches
// `push.test` as its failure row with no retry, and the access token rides
// every Expo request. `push.register` with a revoked key is pinned over HTTP in
// `__tests__/rpc/push-list-devices.test.ts`, where `dualAuth` refuses it.

const ALL_ON = {
  approvals: true,
  clarify: true,
  cronFailures: true,
  teamAttention: true,
  runFinished: true,
};

interface FetchCall {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

describe('push devices + Expo transport', () => {
  let dir: string;
  let keys: SqliteApiKeyStore;
  let devices: SqlitePushDeviceStore;
  let calls: FetchCall[];
  let reply: (url: string, body: unknown) => Response;

  const fetchFake = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as unknown;
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body });
    return reply(String(url), body);
  }) as typeof fetch;

  function transport(accessToken?: string): ExpoPushTransport {
    return new ExpoPushTransport({
      accessToken: async () => accessToken,
      onDeviceNotRegistered: (token) => devices.removeToken(token),
      fetch: fetchFake,
      receiptDelayMs: 0,
    });
  }

  function dispatcher(t = transport()): PushDispatcher {
    return new PushDispatcher({ devices, transport: t, personalityFor: async () => 'engineer' });
  }

  async function registerDevice(name: string, token: string): Promise<string> {
    const { record } = await keys.create({ name, scopes: ['push:register'] });
    const input: RegisterPushDeviceInput = {
      apiKeyId: record.id,
      expoPushToken: token,
      platform: 'ios',
      categories: ALL_ON,
      liveActivities: false,
      appVersion: '0.1.0',
    };
    devices.register(input);
    return record.prefix;
  }

  const approval = {
    approvalId: 'appr-1',
    sessionId: 'sess-1',
    toolCallId: 'tc-1',
    toolName: 'bash',
    args: { command: 'git push' },
    reason: null,
    alwaysAsk: false,
    hardline: false,
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ethos-push-devices-'));
    keys = new SqliteApiKeyStore(join(dir, 'sessions.db'));
    devices = new SqlitePushDeviceStore(join(dir, 'sessions.db'));
    calls = [];
    reply = (_url, body) =>
      Response.json({ data: (body as unknown[]).map((_, i) => ({ status: 'ok', id: `r${i}` })) });
  });

  afterEach(() => {
    devices.close();
    keys.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('revoked key → the dispatcher sends nothing for its device', async () => {
    const prefix = await registerDevice('iphone', 'ExponentPushToken[a]');
    await keys.revoke(prefix);
    await dispatcher().approvalPending('sess-1', approval, null);
    expect(calls).toEqual([]);
  });

  it('register upserts per (key, token); unregister removes only the caller’s row', async () => {
    const { record } = await keys.create({ name: 'iphone', scopes: ['push:register'] });
    const base = {
      apiKeyId: record.id,
      platform: 'ios' as const,
      categories: ALL_ON,
      liveActivities: false,
    };
    devices.register({ ...base, expoPushToken: 'ExponentPushToken[a]', appVersion: '0.1.0' });
    devices.register({ ...base, expoPushToken: 'ExponentPushToken[a]', appVersion: '0.2.0' });
    devices.register({ ...base, expoPushToken: 'ExponentPushToken[b]', appVersion: '0.1.0' });
    expect(devices.listForActiveKeys().map((d) => [d.expoPushToken, d.appVersion])).toEqual(
      expect.arrayContaining([
        ['ExponentPushToken[a]', '0.2.0'],
        ['ExponentPushToken[b]', '0.1.0'],
      ]),
    );
    expect(devices.listForActiveKeys()).toHaveLength(2);

    expect(devices.unregister('ExponentPushToken[a]', 'some-other-key')).toBe(false);
    expect(devices.unregister('ExponentPushToken[a]', record.id)).toBe(true);
    expect(devices.listForActiveKeys().map((d) => d.expoPushToken)).toEqual([
      'ExponentPushToken[b]',
    ]);
  });

  it('the retention sweep removes rows of revoked keys only', async () => {
    const revoked = await registerDevice('old-phone', 'ExponentPushToken[old]');
    await registerDevice('iphone', 'ExponentPushToken[new]');
    await keys.revoke(revoked);
    expect(devices.sweepRevoked()).toBe(1);
    expect(devices.unregister('ExponentPushToken[old]')).toBe(false);
    expect(devices.listForActiveKeys().map((d) => d.expoPushToken)).toEqual([
      'ExponentPushToken[new]',
    ]);
  });

  it('DeviceNotRegistered in a receipt → the device row is removed', async () => {
    await registerDevice('iphone', 'ExponentPushToken[a]');
    reply = (url, body) =>
      url.endsWith('/getReceipts')
        ? Response.json({
            data: { r0: { status: 'error', details: { error: 'DeviceNotRegistered' } } },
          })
        : Response.json({ data: (body as unknown[]).map(() => ({ status: 'ok', id: 'r0' })) });
    await dispatcher().approvalPending('sess-1', approval, null);
    await vi.waitFor(() => expect(devices.listForActiveKeys()).toEqual([]));
    expect(calls.map((c) => c.url)).toEqual([
      'https://exp.host/--/api/v2/push/send',
      'https://exp.host/--/api/v2/push/getReceipts',
    ]);
    expect(calls[1]?.body).toEqual({ ids: ['r0'] });
  });

  it('DeviceNotRegistered in a ticket → the device row is removed at once', async () => {
    await registerDevice('iphone', 'ExponentPushToken[a]');
    reply = () =>
      Response.json({
        data: [{ status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }],
      });
    await dispatcher().approvalPending('sess-1', approval, null);
    expect(devices.listForActiveKeys()).toEqual([]);
  });

  it('Expo 5xx → push.test returns the failure row, nothing retried', async () => {
    const prefix = await registerDevice('iphone', 'ExponentPushToken[a]');
    const keyId = (await keys.list()).find((k) => k.prefix === prefix)?.id;
    reply = () => new Response('upstream down', { status: 503 });
    expect(await dispatcher().test(keyId)).toEqual({
      ok: false,
      error: 'Expo · 503 · project mitesh',
    });
    expect(calls).toHaveLength(1);
  });

  it('the push access token rides every Expo request; without one, no Authorization', async () => {
    await registerDevice('iphone', 'ExponentPushToken[a]');
    await dispatcher(transport('expo-token-123')).approvalPending('sess-1', approval, null);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    for (const call of calls) expect(call.headers.authorization).toBe('Bearer expo-token-123');

    calls = [];
    await dispatcher(transport(undefined)).approvalPending('sess-1', approval, null);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    for (const call of calls) expect(call.headers.authorization).toBeUndefined();
  });

  it('no payload sent to Expo contains the tool args', async () => {
    await registerDevice('iphone', 'ExponentPushToken[a]');
    await dispatcher().approvalPending('sess-1', approval, null);
    const sent = JSON.stringify(calls[0]?.body);
    expect(sent).toContain('appr-1');
    expect(sent).not.toContain('git push');
    expect(sent).not.toContain('"args"');
  });
});
