import { mkdtempSync, rmSync } from 'node:fs';
import { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from '@ethosagent/sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createEventLoopLagSampler,
  createHealthServer,
  createReadinessCheck,
} from '../health-server';

describe('createHealthServer', () => {
  let server: Server | null = null;

  afterEach(() => {
    if (server) {
      server.close();
      server = null;
    }
  });

  // Regression: gateway/serve/boot rely on this server staying ref'd — it's
  // the only thing keeping the process alive once every other timer
  // (heartbeats, cron) is unref'd. unref'ing it too caused a crash-loop
  // (Node exit code 13, unfinished top-level await) whenever no platform
  // adapter held an open socket.
  it('does not unref the listening server', async () => {
    const unrefSpy = vi.spyOn(Server.prototype, 'unref');
    server = createHealthServer(0, '127.0.0.1', () => ({ status: 'ok', uptime: 0 }));
    const s = server;
    if (!s) throw new Error('no server');
    await new Promise<void>((resolve) => s.once('listening', resolve));
    expect(unrefSpy).not.toHaveBeenCalled();
    unrefSpy.mockRestore();
  });

  it('returns 200 with ok status', async () => {
    server = createHealthServer(0, '127.0.0.1', () => ({
      status: 'ok',
      uptime: 42,
    }));
    const s = server;
    if (!s) throw new Error('no server');
    await new Promise<void>((resolve) => s.once('listening', resolve));
    const addr = s.address();
    if (!addr || typeof addr === 'string') throw new Error('unexpected address');
    const res = await fetch(`http://127.0.0.1:${addr.port}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.uptime).toBe(42);
  });

  it('returns 503 with degraded status', async () => {
    server = createHealthServer(0, '127.0.0.1', () => ({
      status: 'degraded',
      uptime: 0,
    }));
    const s = server;
    if (!s) throw new Error('no server');
    await new Promise<void>((resolve) => s.once('listening', resolve));
    const addr = s.address();
    if (!addr || typeof addr === 'string') throw new Error('unexpected address');
    const res = await fetch(`http://127.0.0.1:${addr.port}/healthz`);
    expect(res.status).toBe(503);
  });

  it('returns 404 for unknown paths', async () => {
    server = createHealthServer(0, '127.0.0.1', () => ({
      status: 'ok',
      uptime: 0,
    }));
    const s = server;
    if (!s) throw new Error('no server');
    await new Promise<void>((resolve) => s.once('listening', resolve));
    const addr = s.address();
    if (!addr || typeof addr === 'string') throw new Error('unexpected address');
    const res = await fetch(`http://127.0.0.1:${addr.port}/other`);
    expect(res.status).toBe(404);
  });

  // P2-counters (D2/D16) — `/metrics` on the gateway health server.
  describe('/metrics', () => {
    it('404s when no getMetricsText is supplied (unchanged pre-P2 behavior)', async () => {
      server = createHealthServer(0, '127.0.0.1', () => ({ status: 'ok', uptime: 0 }));
      const s = server;
      if (!s) throw new Error('no server');
      await new Promise<void>((resolve) => s.once('listening', resolve));
      const addr = s.address();
      if (!addr || typeof addr === 'string') throw new Error('unexpected address');
      const res = await fetch(`http://127.0.0.1:${addr.port}/metrics`);
      expect(res.status).toBe(404);
    });

    it('serves OpenMetrics text with no auth check when none is wired', async () => {
      server = createHealthServer(
        0,
        '127.0.0.1',
        () => ({ status: 'ok', uptime: 0 }),
        async () => 'ethos_tool_calls_total{tool="bash",outcome="ok"} 1\n',
      );
      const s = server;
      if (!s) throw new Error('no server');
      await new Promise<void>((resolve) => s.once('listening', resolve));
      const addr = s.address();
      if (!addr || typeof addr === 'string') throw new Error('unexpected address');
      const res = await fetch(`http://127.0.0.1:${addr.port}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/plain; version=0.0.4');
      const body = await res.text();
      expect(body).toContain('ethos_tool_calls_total');
    });

    it('401s an unauthorized scrape when an auth check is wired', async () => {
      server = createHealthServer(
        0,
        '127.0.0.1',
        () => ({ status: 'ok', uptime: 0 }),
        async () => 'ok\n',
        (auth) => auth === 'Bearer sk-ethos-good',
      );
      const s = server;
      if (!s) throw new Error('no server');
      await new Promise<void>((resolve) => s.once('listening', resolve));
      const addr = s.address();
      if (!addr || typeof addr === 'string') throw new Error('unexpected address');

      const unauthorized = await fetch(`http://127.0.0.1:${addr.port}/metrics`);
      expect(unauthorized.status).toBe(401);

      const authorized = await fetch(`http://127.0.0.1:${addr.port}/metrics`, {
        headers: { authorization: 'Bearer sk-ethos-good' },
      });
      expect(authorized.status).toBe(200);
    });
  });

  async function listen(s: Server): Promise<number> {
    await new Promise<void>((resolve) => s.once('listening', resolve));
    const addr = s.address();
    if (!addr || typeof addr === 'string') throw new Error('unexpected address');
    return addr.port;
  }

  // R6 (plan/phases/openclaw-2026.9.6-gaps.md) — a readiness tier. `/healthz`
  // stays liveness; `/readyz` reports not-ready when an adapter is unhealthy,
  // a SQLite store will not open, or the event loop's p99 lag is over threshold.
  describe('/readyz', () => {
    const dirs: string[] = [];
    afterEach(() => {
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    function readinessServer(opts: Parameters<typeof createReadinessCheck>[0]): Server {
      return createHealthServer(
        0,
        '127.0.0.1',
        () => ({ status: 'ok', uptime: 0 }),
        undefined,
        undefined,
        { readiness: createReadinessCheck(opts) },
      );
    }

    it('404s when no readiness check is wired', async () => {
      server = createHealthServer(0, '127.0.0.1', () => ({ status: 'ok', uptime: 0 }));
      const port = await listen(server);
      expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(404);
    });

    it('returns 503 when the lag sampler reports over threshold, 200 otherwise', async () => {
      let lag = 5_000;
      server = readinessServer({
        adapters: async () => [],
        sqlitePaths: [],
        lagP99Ms: () => lag,
        lagThresholdMs: 1_000,
      });
      const port = await listen(server);

      const wedged = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(wedged.status).toBe(503);
      const body = await wedged.json();
      expect(body.status).toBe('not_ready');
      expect(body.checks).toContainEqual(
        expect.objectContaining({ name: 'event_loop', ok: false }),
      );

      lag = 12;
      expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200);
    });

    it('returns 503 when an adapter is unhealthy', async () => {
      server = readinessServer({
        adapters: async () => [
          { name: 'telegram:a', ok: true },
          { name: 'email:b', ok: false },
        ],
        sqlitePaths: [],
        lagP99Ms: () => 0,
      });
      const port = await listen(server);
      const res = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.checks).toContainEqual(
        expect.objectContaining({ name: 'adapter:email:b', ok: false }),
      );
    });

    it('returns 503 when a SQLite store will not open, 200 when every store opens', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ethos-readyz-'));
      dirs.push(dir);
      const good = join(dir, 'good.db');
      const db = new Database(good);
      db.exec('CREATE TABLE t (x INTEGER)');
      db.close();

      server = readinessServer({
        adapters: async () => [],
        sqlitePaths: [good, join(dir, 'missing.db')],
        lagP99Ms: () => 0,
      });
      const port = await listen(server);
      const res = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.checks).toContainEqual(
        expect.objectContaining({ name: 'sqlite:missing.db', ok: false }),
      );
      expect(body.checks).toContainEqual(
        expect.objectContaining({ name: 'sqlite:good.db', ok: true }),
      );

      server.close();
      server = readinessServer({
        adapters: async () => [],
        sqlitePaths: [good],
        lagP99Ms: () => 0,
      });
      const port2 = await listen(server);
      expect((await fetch(`http://127.0.0.1:${port2}/readyz`)).status).toBe(200);
    });

    it('leaves /healthz as liveness even when not ready', async () => {
      server = readinessServer({
        adapters: async () => [],
        sqlitePaths: [],
        lagP99Ms: () => 9_999,
      });
      const port = await listen(server);
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    });
  });

  // R6 + U9 — event-loop lag and process memory on `/metrics`.
  describe('/metrics process gauges', () => {
    it('carries ethos_process_rss_bytes and the event-loop lag p99', async () => {
      server = createHealthServer(
        0,
        '127.0.0.1',
        () => ({ status: 'ok', uptime: 0 }),
        async () => 'ethos_tool_calls_total{tool="bash",outcome="ok"} 1\n',
        undefined,
        { eventLoopLagP99Ms: () => 250 },
      );
      const port = await listen(server);
      const body = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
      expect(body).toContain('ethos_tool_calls_total');
      expect(body).toMatch(/^ethos_process_rss_bytes \d+$/m);
      expect(body).toMatch(/^ethos_process_heap_used_bytes \d+$/m);
      expect(body).toContain('ethos_event_loop_lag_p99_seconds 0.25');
    });
  });

  describe('createEventLoopLagSampler', () => {
    it('reports a non-negative p99 in milliseconds and stops cleanly', async () => {
      const sampler = createEventLoopLagSampler();
      await new Promise((r) => setTimeout(r, 50));
      const p99 = sampler.p99Ms();
      expect(Number.isFinite(p99)).toBe(true);
      expect(p99).toBeGreaterThanOrEqual(0);
      sampler.stop();
    });
  });
});
