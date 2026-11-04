import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EthosPluginApi } from '@ethosagent/plugin-sdk';
import { FsStorage } from '@ethosagent/storage-fs';
import type { ToolContext } from '@ethosagent/types';
import { afterEach, describe, expect, it } from 'vitest';
import type { HandlerTable } from '../connection';
import { RpcError } from '../connection';
import { CallHandleTable } from '../handles';
import type { HostStats } from '../host-types';
import { createParentHandlers, ParentApis } from '../parent-handlers';
import { RPC_ERROR } from '../protocol';
import type { RecordedEvent } from './helpers/harness';
import { makeCtx } from './helpers/harness';

let scratch: string | undefined;
afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

interface Rig {
  table: HandlerTable;
  handles: CallHandleTable;
  events: RecordedEvent[];
  secretReads: string[];
  stats: HostStats;
  hostHome: string;
}

async function rig(
  extra: Partial<Parameters<typeof createParentHandlers>[0]> = {},
  handles = new CallHandleTable(),
): Promise<Rig> {
  scratch = await mkdtemp(join(tmpdir(), 'plugin-host-handlers-'));
  const events: RecordedEvent[] = [];
  const secretReads: string[] = [];
  const apis = new ParentApis();
  const api = {
    getSecret: async (key: string) => {
      secretReads.push(key);
      return `value-of-${key}`;
    },
    setSecret: async () => undefined,
  } as unknown as EthosPluginApi;
  apis.bind('acme', api);
  const hostHome = join(scratch, 'plugin-hosts', 'acme', 'home');
  const stats: HostStats = { droppedVoid: 0, timeouts: 0, restarts: 0, droppedBus: 0 };
  const table = createParentHandlers({
    storage: new FsStorage(),
    hostHome: () => hostHome,
    apis,
    onEvent: (category, payload) => events.push({ category, payload }),
    ...extra,
  })({ pluginId: 'acme', handles, stats, notifyHost: () => undefined });
  return { table, handles, events, secretReads, stats, hostHome };
}

const call = (r: Rig, method: string, params: unknown): Promise<unknown> => {
  const handler = r.table[method];
  if (!handler) throw new Error(`no handler ${method}`);
  return Promise.resolve(handler(params, { id: 1 }));
};

async function rejection(p: Promise<unknown>): Promise<RpcError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof RpcError) return err;
    throw err;
  }
  throw new Error('expected a rejection');
}

describe('call handles', () => {
  it('serves a live handle and refuses it once revoked, recording plugin_host.denied', async () => {
    const r = await rig();
    const ctx: ToolContext = { ...makeCtx(), storage: new FsStorage() };
    const handle = r.handles.open(ctx);
    await mkdirp(r.hostHome);
    expect(
      await call(r, 'ethos/capability.storage', { call: handle, op: 'exists', args: [r.hostHome] }),
    ).toBe(true);

    r.handles.revoke(handle);
    const err = await rejection(
      call(r, 'ethos/capability.storage', { call: handle, op: 'exists', args: ['/'] }),
    );
    expect(err.code).toBe(RPC_ERROR.denied);
    expect(err.message).toMatch(/PLUGIN_HOST_HANDLE_REVOKED/);
    expect(r.events).toEqual([
      {
        category: 'plugin_host.denied',
        payload: { plugin_id: 'acme', kind: 'handle', ref: 'ethos/capability.storage' },
      },
    ]);
  });

  it('refuses a handle issued to another host', async () => {
    const r = await rig();
    const other = new CallHandleTable();
    const foreign = other.open({ ...makeCtx(), storage: new FsStorage() });
    const err = await rejection(
      call(r, 'ethos/capability.storage', { call: foreign, op: 'exists', args: ['/'] }),
    );
    expect(err.message).toMatch(/PLUGIN_HOST_HANDLE_REVOKED/);
    expect(
      await rejection(call(r, 'ethos/capability.kv', { call: 42, op: 'get', args: ['k'] })),
    ).toBeInstanceOf(RpcError);
  });

  it('answers a call without the requested handle as unavailable, not as a crash', async () => {
    const r = await rig();
    const handle = r.handles.open(makeCtx());
    const err = await rejection(
      call(r, 'ethos/capability.kv', { call: handle, op: 'get', args: ['k'] }),
    );
    expect(err.message).toMatch(/PLUGIN_HOST_CAPABILITY_UNAVAILABLE/);
  });
});

describe('secrets go through authorizeSecretRef, then the parent own api', () => {
  it('serves plugins/<id>/ and denies everything else with PLUGIN_HOST_SECRET_DENIED + an event naming the ref', async () => {
    const r = await rig();
    expect(await call(r, 'ethos/secrets.get', { ref: 'plugins/acme/token' })).toBe(
      'value-of-token',
    );
    for (const ref of [
      'providers/anthropic/apiKey',
      'personalities/other/mcp/linear/access_token',
      'plugins/victim/token',
      'plugins/acme/../victim/token',
      'plugins/acme/',
    ]) {
      const err = await rejection(call(r, 'ethos/secrets.get', { ref }));
      expect(err.message, ref).toMatch(/PLUGIN_HOST_SECRET_DENIED/);
    }
    expect(r.secretReads).toEqual(['token']);
    const denied = r.events.filter((e) => e.category === 'plugin_host.denied');
    expect(denied).toHaveLength(5);
    expect(denied.map((e) => e.payload.ref)).toContain('providers/anthropic/apiKey');
    expect(JSON.stringify(denied)).not.toContain('value-of');
  });

  it('set and list follow the same rule', async () => {
    const r = await rig({ listSecretKeys: () => ['token', 'other'] });
    expect(await call(r, 'ethos/secrets.list', {})).toEqual([
      'plugins/acme/token',
      'plugins/acme/other',
    ]);
    expect(await rejection(call(r, 'ethos/secrets.list', { prefix: 'providers/' }))).toBeInstanceOf(
      RpcError,
    );
    expect(
      await rejection(call(r, 'ethos/secrets.set', { ref: 'providers/x/y', value: 'v' })),
    ).toBeInstanceOf(RpcError);
    expect(await call(r, 'ethos/secrets.set', { ref: 'plugins/acme/new', value: 'v' })).toBeNull();
  });

  it('the injected authorizer is consulted for secrets.* and capability.secret (lane C seam)', async () => {
    const asked: string[] = [];
    const r = await rig({
      authorizeSecretRef: (_id, ref, op) => {
        asked.push(`${op}:${ref}`);
        return ref === 'providers/exa/key' || ref === 'plugins/acme/token';
      },
    });
    const handle = r.handles.open({
      ...makeCtx(),
      secretsResolver: { get: async (ref) => `resolved:${ref}` },
    });
    expect(
      await call(r, 'ethos/capability.secret', {
        call: handle,
        op: 'get',
        args: ['providers/exa/key'],
      }),
    ).toBe('resolved:providers/exa/key');
    // The parent api only serves plugins/<id>/, so an allowed foreign ref is still refused on secrets.get.
    expect(
      (await rejection(call(r, 'ethos/secrets.get', { ref: 'providers/exa/key' }))).message,
    ).toMatch(/DENIED/);
    expect(await call(r, 'ethos/secrets.get', { ref: 'plugins/acme/token' })).toBe(
      'value-of-token',
    );
    expect(asked).toContain('capability:providers/exa/key');
  });

  it('capability.secret denies by default outside the plugin prefix', async () => {
    const r = await rig();
    const handle = r.handles.open({ ...makeCtx(), secretsResolver: { get: async () => 'leak' } });
    const err = await rejection(
      call(r, 'ethos/capability.secret', {
        call: handle,
        op: 'get',
        args: ['providers/anthropic/apiKey'],
      }),
    );
    expect(err.message).toMatch(/PLUGIN_HOST_SECRET_DENIED/);
  });
});

describe('capabilities with limits', () => {
  it('scopedFetch answers { status, headers, bodyBase64 } and refuses a body past the frame limit', async () => {
    const r = await rig();
    const small = r.handles.open({
      ...makeCtx(),
      scopedFetch: {
        fetch: async () => new Response('hi', { status: 201, headers: { 'x-a': 'b' } }),
      },
    });
    expect(
      await call(r, 'ethos/capability.fetch', { call: small, args: ['https://x.test/'] }),
    ).toEqual({
      status: 201,
      headers: { 'content-type': 'text/plain;charset=UTF-8', 'x-a': 'b' },
      bodyBase64: Buffer.from('hi').toString('base64'),
    });
    const big = r.handles.open({
      ...makeCtx(),
      scopedFetch: { fetch: async () => new Response(new Uint8Array(7 * 1024 * 1024)) },
    });
    const err = await rejection(
      call(r, 'ethos/capability.fetch', { call: big, args: ['https://x.test/'] }),
    );
    expect(err.message).toMatch(/frame limit/);
  });

  it('attachments.open copies into <hostHome>/attachments/<callId>/ and removes the copy when the call ends', async () => {
    const r = await rig();
    const source = join(scratch ?? '', 'cache.bin');
    await new FsStorage().write(source, 'bytes');
    const handle = r.handles.open({
      ...makeCtx(),
      attachments: {
        list: () => [],
        open: async () => ({ path: source }),
        openByRef: async () => ({ path: source }),
      },
    });
    const out = await call(r, 'ethos/capability.attachments', {
      call: handle,
      op: 'openByRef',
      args: ['ref'],
    });
    const copy = join(r.hostHome, 'attachments', handle, 'cache.bin');
    expect(out).toEqual({ path: copy });
    expect(await readFile(copy, 'utf8')).toBe('bytes');
    r.handles.revoke(handle);
    for (
      let i = 0;
      i < 50 && (await readdir(join(r.hostHome, 'attachments')).catch(() => ['x'])).length > 0;
      i++
    ) {
      await new Promise((res) => setTimeout(res, 20));
    }
    expect(await readdir(join(r.hostHome, 'attachments'))).toEqual([]);
  });
});

async function mkdirp(dir: string): Promise<void> {
  await new FsStorage().mkdir(dir);
}
