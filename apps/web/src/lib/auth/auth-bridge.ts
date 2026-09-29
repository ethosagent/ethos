// The transport → AuthGate signal bridge (plan/phases/web-auth-bootstrap.md
// Phase 2, D9). rpc.ts wraps every /rpc fetch and reports here; AuthGate
// subscribes via useSyncExternalStore and swaps the app for the full-page
// gate when a signal is up.
//
// The two signals are set from mutually exclusive transport facts, which is
// what keeps D9's "401 is never offline, offline is never 401" honest:
//   - `unauthorized` — a request got an HTTP 401. A 401 IS a response, so the
//     same report also proves the backend reachable and clears `unreachable`.
//   - `unreachable`  — a fetch rejected without any response at all.

export interface AuthBridgeState {
  /** A request answered 401 — the session cookie is missing or dead. */
  readonly unauthorized: boolean;
  /** The last request got no response at all — the backend is unreachable. */
  readonly unreachable: boolean;
}

let state: AuthBridgeState = { unauthorized: false, unreachable: false };
const listeners = new Set<() => void>();

function update(next: AuthBridgeState): void {
  if (next.unauthorized === state.unauthorized && next.unreachable === state.unreachable) return;
  state = next;
  for (const listener of [...listeners]) listener();
}

export function getAuthBridgeState(): AuthBridgeState {
  return state;
}

export function subscribeAuthBridge(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Any HTTP response proves the backend reachable; a 401 additionally gates. */
export function reportAuthResponse(status: number): void {
  update({ unauthorized: state.unauthorized || status === 401, unreachable: false });
}

/** A fetch that rejected without a response — the backend is unreachable. */
export function reportAuthNetworkError(): void {
  update({ ...state, unreachable: true });
}

/** Called after a successful login / claim / reset so the gate lifts. */
export function clearUnauthorized(): void {
  update({ ...state, unauthorized: false });
}

/** Test seam — module-local state must not leak between tests. */
export function resetAuthBridgeForTests(): void {
  update({ unauthorized: false, unreachable: false });
}
