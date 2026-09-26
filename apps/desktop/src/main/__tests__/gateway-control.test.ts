import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/home' } }));
vi.mock('../store', () => ({ store: { get: () => undefined } }));

import {
  type CliGatewayStatus,
  GATEWAY_LOCK_HELD_EXIT_CODE,
  type GatewayStatus,
  parseCliGatewayStatus,
  startGatewayWith,
  statusFromCli,
} from '../gateway-control';

describe('gateway-control', () => {
  // Compile-time type guard: if GatewayStatus changes shape, tsc fails here
  it('GatewayStatus covers expected states', () => {
    const states: GatewayStatus['state'][] = ['running', 'stopped', 'crashed', 'starting'];
    expect(states).toHaveLength(4);
  });

  it('GatewayStatus includes serviceInstalled flag', () => {
    const status: GatewayStatus = { state: 'running', serviceInstalled: true };
    expect(status.serviceInstalled).toBe(true);
  });

  it('GatewayStatus accepts all valid state values', () => {
    const running: GatewayStatus = { state: 'running', serviceInstalled: true };
    const stopped: GatewayStatus = { state: 'stopped', serviceInstalled: false };
    const crashed: GatewayStatus = { state: 'crashed', serviceInstalled: true };
    const starting: GatewayStatus = { state: 'starting', serviceInstalled: false };

    expect([running, stopped, crashed, starting]).toHaveLength(4);
    expect(running.state).toBe('running');
    expect(stopped.state).toBe('stopped');
    expect(crashed.state).toBe('crashed');
    expect(starting.state).toBe('starting');
  });
});

// Attach to a running gateway (plan reach-and-containment D2-13).
describe('gateway-control — attach instead of a second gateway', () => {
  function deps(statuses: Array<CliGatewayStatus | null>, spawnCode: number | null = null) {
    const queue = [...statuses];
    return {
      cliStatus: vi.fn(async () => queue.shift() ?? null),
      startService: vi.fn(async () => false),
      spawnDetached: vi.fn(async () => spawnCode),
    };
  }

  it('a running gateway → attach, no spawn', async () => {
    const d = deps([{ state: 'running', pid: 4242 }]);
    expect(await startGatewayWith(d)).toEqual({ attached: true, pid: 4242 });
    expect(d.spawnDetached).not.toHaveBeenCalled();
    expect(d.startService).not.toHaveBeenCalled();
  });

  it('an unhealthy gateway is attached to, not restarted', async () => {
    const d = deps([{ state: 'unhealthy', pid: 7 }]);
    expect(await startGatewayWith(d)).toEqual({ attached: true, pid: 7 });
    expect(d.spawnDetached).not.toHaveBeenCalled();
  });

  it('a spawn that exits 3 lost the race → attach, reporting the winner', async () => {
    const d = deps(
      [
        { state: 'stopped', pid: null },
        { state: 'running', pid: 99 },
      ],
      GATEWAY_LOCK_HELD_EXIT_CODE,
    );
    expect(await startGatewayWith(d)).toEqual({ attached: true, pid: 99 });
    expect(d.spawnDetached).toHaveBeenCalledTimes(1);
  });

  it('stopped (or a stale lock) → spawn; a still-running child is a fresh start', async () => {
    const d = deps([{ state: 'stale', pid: 3 }], null);
    expect(await startGatewayWith(d)).toEqual({ attached: false, pid: null });
    expect(d.spawnDetached).toHaveBeenCalledTimes(1);
  });

  it('parses the CLI JSON defensively and maps its states', () => {
    expect(parseCliGatewayStatus('{"state":"running","pid":5,"lockPath":"x"}')).toEqual({
      state: 'running',
      pid: 5,
    });
    expect(parseCliGatewayStatus('not json')).toBeNull();
    expect(parseCliGatewayStatus('{"state":"exploded"}')).toBeNull();
    expect(statusFromCli({ state: 'unhealthy', pid: 5 }, false)).toEqual({
      state: 'running',
      serviceInstalled: false,
      pid: 5,
      unhealthy: true,
    });
    expect(statusFromCli({ state: 'stale', pid: 5 }, true).state).toBe('crashed');
    expect(statusFromCli({ state: 'stopped', pid: null }, true).state).toBe('stopped');
  });
});
