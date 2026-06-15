import { describe, expect, it } from 'vitest';
import type { GatewayStatus } from '../gateway-control';

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
