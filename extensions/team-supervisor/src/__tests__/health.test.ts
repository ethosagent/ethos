import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { probeHealth, startHealthProbeLoop } from '../health';

// ---------------------------------------------------------------------------
// probeHealth — real HTTP server
// ---------------------------------------------------------------------------

describe('probeHealth', () => {
  let server: Server;
  let port: number;

  beforeEach(
    () =>
      new Promise<void>((resolve) => {
        server = createServer((_req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              status: 'ok',
              uptime_s: 42,
              active_sessions: 1,
              last_turn_at: '2024-01-01T00:00:00.000Z',
            }),
          );
        });
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          port = typeof addr === 'object' && addr !== null ? addr.port : 0;
          resolve();
        });
      }),
  );

  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('returns HealthResponse on a healthy server', async () => {
    const result = await probeHealth(port);
    expect(result).not.toBeNull();
    expect(result?.status).toBe('ok');
    expect(result?.uptime_s).toBe(42);
    expect(result?.active_sessions).toBe(1);
    expect(result?.last_turn_at).toBe('2024-01-01T00:00:00.000Z');
  });

  it('returns null when nothing is listening on the port', async () => {
    const result = await probeHealth(1); // port 1 is never open
    expect(result).toBeNull();
  });

  it('returns null when server responds with non-200', async () => {
    server.removeAllListeners('request');
    server.on('request', (_req, res) => {
      res.writeHead(503);
      res.end();
    });
    const result = await probeHealth(port);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// startHealthProbeLoop — injectable probe function
// ---------------------------------------------------------------------------

describe('startHealthProbeLoop', () => {
  const okResponse = {
    status: 'ok' as const,
    uptime_s: 10,
    active_sessions: 0,
    last_turn_at: null,
  };

  it('calls onDegraded when probe fails once for a running member', async () => {
    const onDegraded = vi.fn();
    const onRecovered = vi.fn();
    const onHung = vi.fn();

    const stop = startHealthProbeLoop({
      intervalMs: 20,
      maxConsecutiveFails: 3,
      getMembers: () => [{ personality: 'worker', port: 9999, status: 'running', pid: 1234 }],
      onDegraded,
      onRecovered,
      onHung,
      probe: async () => null, // always fail
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    stop();

    // After 2 ticks (40ms / 20ms interval), we should have 2 failures.
    // At failure 1: onDegraded called (status was 'running').
    // At failure 2: member is already 'degraded' so onDegraded not called again,
    //   but we pass 'degraded' status in getMembers — probe loop only calls onDegraded
    //   when status === 'running'. So exactly 1 call.
    expect(onDegraded).toHaveBeenCalledWith('worker');
    expect(onHung).not.toHaveBeenCalled();
    expect(onRecovered).not.toHaveBeenCalled();
  });

  it('calls onHung when consecutive fails reach maxConsecutiveFails', async () => {
    const onDegraded = vi.fn();
    const onHung = vi.fn();

    let tickCount = 0;
    let memberStatus = 'running';
    const stop = startHealthProbeLoop({
      intervalMs: 20,
      maxConsecutiveFails: 3,
      getMembers: () => [{ personality: 'worker', port: 9999, status: memberStatus, pid: 1234 }],
      onDegraded: (p) => {
        onDegraded(p);
        memberStatus = 'degraded';
      },
      onRecovered: vi.fn(),
      onHung,
      probe: async () => {
        tickCount++;
        return null;
      },
    });

    // Wait for 3 ticks (60ms with 20ms interval)
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    stop();

    expect(tickCount).toBeGreaterThanOrEqual(3);
    expect(onHung).toHaveBeenCalledWith('worker');
  });

  it('calls onRecovered when probe succeeds after degraded', async () => {
    const onRecovered = vi.fn();
    let failNext = true;

    const stop = startHealthProbeLoop({
      intervalMs: 20,
      maxConsecutiveFails: 5,
      getMembers: () => [
        { personality: 'worker', port: 9999, status: failNext ? 'running' : 'degraded', pid: 1 },
      ],
      onDegraded: () => {
        failNext = false; // next probe will succeed
      },
      onRecovered,
      onHung: vi.fn(),
      probe: async () => (failNext ? null : okResponse),
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    stop();

    expect(onRecovered).toHaveBeenCalledWith('worker');
  });

  it('skips members whose status is not running or degraded', async () => {
    const probe = vi.fn(async () => null);

    const stop = startHealthProbeLoop({
      intervalMs: 20,
      maxConsecutiveFails: 3,
      getMembers: () => [
        { personality: 'a', port: 1, status: 'failed', pid: null },
        { personality: 'b', port: 2, status: 'stopped', pid: null },
        { personality: 'c', port: 3, status: 'starting', pid: 123 },
      ],
      onDegraded: vi.fn(),
      onRecovered: vi.fn(),
      onHung: vi.fn(),
      probe,
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    stop();

    expect(probe).not.toHaveBeenCalled();
  });

  it('stop() prevents further ticks', async () => {
    let callCount = 0;
    const stop = startHealthProbeLoop({
      intervalMs: 20,
      maxConsecutiveFails: 10,
      getMembers: () => [{ personality: 'w', port: 9, status: 'running', pid: 1 }],
      onDegraded: vi.fn(),
      onRecovered: vi.fn(),
      onHung: vi.fn(),
      probe: async () => {
        callCount++;
        return okResponse;
      },
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    const countAtStop = callCount;
    stop();
    await new Promise<void>((resolve) => setTimeout(resolve, 60));

    expect(callCount).toBe(countAtStop);
  });
});
