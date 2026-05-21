import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createHealthServer } from '../health-server';

describe('createHealthServer', () => {
  let server: Server | null = null;

  afterEach(() => {
    if (server) {
      server.close();
      server = null;
    }
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
});
