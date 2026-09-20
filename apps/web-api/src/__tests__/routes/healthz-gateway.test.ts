import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebApi } from '../../index';
import {
  makeStubAgentLoop,
  makeStubMemoryBundle,
  makeStubPersonalityRegistry,
} from '../test-helpers';

describe('GET /healthz — gateway heartbeat', () => {
  let dir: string;
  // Lives under the per-test `dataDir`, not the real `~/.ethos` — `/healthz`
  // reads `gateway-health.json` from `CreateRoutesOptions.dataDir` (threaded
  // from `createWebApi`'s `dataDir`), so a heartbeat written anywhere else
  // must not be visible to it.
  let healthPath: string;
  let store: SQLiteSessionStore;
  let app: ReturnType<typeof createWebApi>['app'];

  beforeEach(async () => {
    dir = await mkdtemp(join(homedir(), '.ethos', 'test-webapi-'));
    healthPath = join(dir, 'gateway-health.json');
    store = new SQLiteSessionStore(':memory:');
    app = createWebApi({
      dataDir: dir,
      sessionStore: store,
      memoryBundle: makeStubMemoryBundle(),
      agentLoop: makeStubAgentLoop(),
      personalities: makeStubPersonalityRegistry(),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
    }).app;
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('returns 200 + ok when heartbeat is fresh and all adapters ok', async () => {
    const hb = {
      pid: 1234,
      startedAt: '2026-05-20T08:00:00Z',
      updatedAt: new Date().toISOString(),
      adapters: [{ name: 'telegram:bot-1', ok: true }],
    };
    await writeFile(healthPath, JSON.stringify(hb), 'utf-8');

    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.uptime).toBeGreaterThan(0);

    const gw = body.gateway as {
      status: string;
      adapters: Array<{ name: string; ok: boolean }>;
      lastHeartbeatAgeSec: number;
    };
    expect(gw.status).toBe('ok');
    expect(gw.adapters).toEqual([{ name: 'telegram:bot-1', ok: true }]);
    expect(gw.lastHeartbeatAgeSec).toBeLessThan(5);
  });

  it('returns 503 + degraded when heartbeat is stale (>30s)', async () => {
    const staleDate = new Date(Date.now() - 60_000).toISOString();
    const hb = {
      pid: 1234,
      startedAt: '2026-05-20T08:00:00Z',
      updatedAt: staleDate,
      adapters: [{ name: 'telegram:bot-1', ok: true }],
    };
    await writeFile(healthPath, JSON.stringify(hb), 'utf-8');

    const res = await app.request('/healthz');
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('degraded');

    const gw = body.gateway as { status: string; lastHeartbeatAgeSec: number };
    expect(gw.status).toBe('stale');
    expect(gw.lastHeartbeatAgeSec).toBeGreaterThan(29);
  });

  it('returns 503 + degraded when heartbeat file is missing', async () => {
    const res = await app.request('/healthz');
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('degraded');

    const gw = body.gateway as {
      status: string;
      adapters: unknown[];
      lastHeartbeatAgeSec: null;
    };
    expect(gw.status).toBe('down');
    expect(gw.adapters).toEqual([]);
    expect(gw.lastHeartbeatAgeSec).toBeNull();
  });

  it('returns 503 + degraded when heartbeat has a malformed updatedAt', async () => {
    const hb = {
      pid: 1234,
      startedAt: '2026-05-20T08:00:00Z',
      updatedAt: 'not-a-date',
      adapters: [{ name: 'telegram:bot-1', ok: true }],
    };
    await writeFile(healthPath, JSON.stringify(hb), 'utf-8');

    const res = await app.request('/healthz');
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('degraded');

    const gw = body.gateway as { status: string };
    expect(gw.status).toBe('stale');
  });

  it('returns 200 + ok when the gateway is fresh and no adapters are configured', async () => {
    // A headless deployment with no Slack/Telegram/Discord bot attached is a
    // normal configuration — an empty adapter list is not a failure.
    const hb = {
      pid: 1234,
      startedAt: '2026-05-20T08:00:00Z',
      updatedAt: new Date().toISOString(),
      adapters: [],
    };
    await writeFile(healthPath, JSON.stringify(hb), 'utf-8');

    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');

    const gw = body.gateway as { status: string; adapters: unknown[] };
    expect(gw.status).toBe('ok');
    expect(gw.adapters).toEqual([]);
  });

  it('returns 503 + degraded when an adapter reports not-ok', async () => {
    const hb = {
      pid: 1234,
      startedAt: '2026-05-20T08:00:00Z',
      updatedAt: new Date().toISOString(),
      adapters: [
        { name: 'telegram:bot-1', ok: true },
        { name: 'slack:app-1', ok: false },
      ],
    };
    await writeFile(healthPath, JSON.stringify(hb), 'utf-8');

    const res = await app.request('/healthz');
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('degraded');

    const gw = body.gateway as { status: string };
    expect(gw.status).toBe('ok'); // gateway itself is fresh
  });

  // `/healthz` used to build its heartbeat path from the real home
  // directory unconditionally (`join(homedir(), '.ethos', 'gateway-health.json')`),
  // so a server booted against an isolated `dataDir` (what `ETHOS_STATE_DIR`
  // resolves to) still reported the operator's REAL gateway. A stale/foreign
  // heartbeat at the real path must not leak into this deployment's result.
  it('reads the heartbeat from the configured dataDir, not the real home directory', async () => {
    const realHealthPath = join(homedir(), '.ethos', 'gateway-health.json');
    let realSaved: string | null = null;
    try {
      realSaved = await readFile(realHealthPath, 'utf-8');
    } catch {
      realSaved = null;
    }

    try {
      await mkdir(join(homedir(), '.ethos'), { recursive: true });
      await writeFile(
        realHealthPath,
        JSON.stringify({
          pid: 1,
          startedAt: '2020-01-01T00:00:00Z',
          updatedAt: new Date(Date.now() - 60_000).toISOString(),
          adapters: [{ name: 'telegram:foreign', ok: false }],
        }),
        'utf-8',
      );

      const freshHb = {
        pid: 5678,
        startedAt: '2026-05-20T08:00:00Z',
        updatedAt: new Date().toISOString(),
        adapters: [{ name: 'telegram:bot-1', ok: true }],
      };
      await writeFile(healthPath, JSON.stringify(freshHb), 'utf-8');

      const res = await app.request('/healthz');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        gateway: { status: string; adapters: Array<{ name: string; ok: boolean }> };
      };
      expect(body.gateway.status).toBe('ok');
      expect(body.gateway.adapters).toEqual([{ name: 'telegram:bot-1', ok: true }]);
    } finally {
      if (realSaved !== null) await writeFile(realHealthPath, realSaved, 'utf-8');
      else await rm(realHealthPath, { force: true }).catch(() => {});
    }
  });
});
