// @vitest-environment jsdom
//
// Drives the real hook through a real render (createElement — the root vitest
// glob is *.test.ts only, so a .tsx test would never run).

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseMcpDeviceLoginOptions, UseMcpDeviceLoginResult } from '../useMcpDeviceLogin';

const startFn = vi.fn();
const statusFn = vi.fn();
const cancelFn = vi.fn();

vi.mock('../../../rpc', () => ({
  rpc: {
    mcp: {
      deviceStart: (...a: unknown[]) => startFn(...a),
      deviceStatus: (...a: unknown[]) => statusFn(...a),
      deviceCancel: (...a: unknown[]) => cancelFn(...a),
    },
  },
}));

const { useMcpDeviceLogin, DEVICE_POLL_INTERVAL_MS } = await import('../useMcpDeviceLogin');

let container: HTMLDivElement;
let root: Root;
let latest: UseMcpDeviceLoginResult | null = null;

function Harness(props: UseMcpDeviceLoginOptions) {
  latest = useMcpDeviceLogin(props);
  return null;
}

const FLOW_ID = 'flow-0123456789abcdef';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  latest = null;
  startFn.mockResolvedValue({
    ok: true,
    flowId: FLOW_ID,
    userCode: 'ABCD-EFGH',
    verificationUri: 'https://auth.example/device',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    serverName: 'granola',
    serverHost: 'mcp.example',
    authHost: 'auth.example',
  });
  cancelFn.mockResolvedValue({ ok: true });
  vi.stubGlobal('open', vi.fn());
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function startHook(props: UseMcpDeviceLoginOptions): Promise<void> {
  act(() => root.render(createElement(Harness, props)));
  await act(async () => {
    await latest?.start();
  });
}

describe('useMcpDeviceLogin', () => {
  it('polls until connected and stops', async () => {
    const onConnected = vi.fn();
    await startHook({ serverName: 'granola', onConnected });
    expect(latest?.phase.kind).toBe('waiting');

    statusFn.mockResolvedValueOnce({ status: 'pending' });
    statusFn.mockResolvedValueOnce({ status: 'connected', serverName: 'granola' });
    await tick(DEVICE_POLL_INTERVAL_MS);
    expect(latest?.phase.kind).toBe('waiting');
    await tick(DEVICE_POLL_INTERVAL_MS);
    expect(latest?.phase).toEqual({ kind: 'done', status: 'connected' });
    expect(onConnected).toHaveBeenCalledWith('granola');

    const calls = statusFn.mock.calls.length;
    await tick(DEVICE_POLL_INTERVAL_MS * 3);
    expect(statusFn.mock.calls.length).toBe(calls);
  });

  it('never calls window.open', async () => {
    await startHook({ serverName: 'granola' });
    statusFn.mockResolvedValue({ status: 'denied' });
    await tick(DEVICE_POLL_INTERVAL_MS);
    expect(window.open).not.toHaveBeenCalled();
  });

  it('close cancels', async () => {
    statusFn.mockResolvedValue({ status: 'pending' });
    await startHook({ serverName: 'granola' });
    act(() => latest?.cancel());
    expect(cancelFn).toHaveBeenCalledWith({ flowId: FLOW_ID });
    const calls = statusFn.mock.calls.length;
    await tick(DEVICE_POLL_INTERVAL_MS * 2);
    expect(statusFn.mock.calls.length).toBe(calls);
  });

  it('surfaces a refusal code without polling', async () => {
    startFn.mockResolvedValueOnce({ ok: false, code: 'device_unavailable' });
    await startHook({ serverName: 'linear' });
    expect(latest?.phase).toEqual({ kind: 'refused', code: 'device_unavailable' });
    await tick(DEVICE_POLL_INTERVAL_MS * 2);
    expect(statusFn).not.toHaveBeenCalled();
  });
});
