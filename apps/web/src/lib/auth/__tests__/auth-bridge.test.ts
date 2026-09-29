import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearUnauthorized,
  getAuthBridgeState,
  reportAuthNetworkError,
  reportAuthResponse,
  resetAuthBridgeForTests,
  subscribeAuthBridge,
} from '../auth-bridge';

describe('auth-bridge (transport → AuthGate signals)', () => {
  beforeEach(() => {
    resetAuthBridgeForTests();
  });

  it('a 401 raises unauthorized and clears unreachable — never both at once', () => {
    reportAuthNetworkError();
    expect(getAuthBridgeState()).toEqual({ unauthorized: false, unreachable: true });
    reportAuthResponse(401);
    expect(getAuthBridgeState()).toEqual({ unauthorized: true, unreachable: false });
  });

  it('a non-401 response clears unreachable but never unauthorized', () => {
    reportAuthResponse(401);
    reportAuthNetworkError();
    reportAuthResponse(200);
    expect(getAuthBridgeState()).toEqual({ unauthorized: true, unreachable: false });
  });

  it('clearUnauthorized lifts the 401 gate', () => {
    reportAuthResponse(401);
    clearUnauthorized();
    expect(getAuthBridgeState()).toEqual({ unauthorized: false, unreachable: false });
  });

  it('notifies subscribers on change only, with a fresh snapshot identity', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAuthBridge(listener);
    const before = getAuthBridgeState();
    reportAuthResponse(200); // no state change — nothing was set
    expect(listener).not.toHaveBeenCalled();
    reportAuthResponse(401);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getAuthBridgeState()).not.toBe(before);
    reportAuthResponse(401); // already unauthorized — no change, no notify
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    reportAuthNetworkError();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
