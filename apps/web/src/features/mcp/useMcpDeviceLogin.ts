import { useCallback, useEffect, useRef, useState } from 'react';
import { rpc } from '../../rpc';

// "Sign in with a code" (RFC 8628) for an existing MCP entry — plan
// mcp-device-code-login §7.2. The hook never opens a window: the verification
// URI is a link the user clicks (D13). It polls `deviceStatus` every 3 s and
// stops on any terminal state. `cancel` tells the server to drop the flow.

export const DEVICE_POLL_INTERVAL_MS = 3000;

type DeviceStartOutput = Awaited<ReturnType<typeof rpc.mcp.deviceStart>>;
export type McpDeviceFlow = Extract<DeviceStartOutput, { ok: true }>;
export type McpDeviceTerminal = 'connected' | 'denied' | 'expired' | 'cancelled' | 'error';

export type McpDevicePhase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'waiting'; flow: McpDeviceFlow }
  | { kind: 'refused'; code: string; detail?: string }
  | { kind: 'done'; status: McpDeviceTerminal; reason?: string };

export interface UseMcpDeviceLoginOptions {
  serverName: string;
  personalityId?: string;
  onConnected?: (serverName: string) => void;
}

export interface UseMcpDeviceLoginResult {
  phase: McpDevicePhase;
  start: () => Promise<void>;
  /** Stops polling and best-effort cancels the server-side flow. */
  cancel: () => void;
}

export function useMcpDeviceLogin({
  serverName,
  personalityId,
  onConnected,
}: UseMcpDeviceLoginOptions): UseMcpDeviceLoginResult {
  const [phase, setPhase] = useState<McpDevicePhase>({ kind: 'idle' });
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const flowIdRef = useRef<string | null>(null);
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;

  const stopPolling = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const poll = useCallback(
    (flowId: string) => {
      stopPolling();
      timerRef.current = setInterval(async () => {
        try {
          const r = await rpc.mcp.deviceStatus({ flowId });
          if (flowIdRef.current !== flowId || r.status === 'pending') return;
          stopPolling();
          flowIdRef.current = null;
          setPhase({
            kind: 'done',
            status: r.status,
            ...(r.reason ? { reason: r.reason } : {}),
          });
          if (r.status === 'connected') onConnectedRef.current?.(r.serverName ?? serverName);
        } catch {
          // Transient (rate limit, network): keep polling.
        }
      }, DEVICE_POLL_INTERVAL_MS);
    },
    [stopPolling, serverName],
  );

  const start = useCallback(async () => {
    setPhase({ kind: 'starting' });
    try {
      const r = await rpc.mcp.deviceStart({
        serverName,
        ...(personalityId ? { personalityId } : {}),
      });
      if (!r.ok) {
        setPhase({ kind: 'refused', code: r.code, ...(r.detail ? { detail: r.detail } : {}) });
        return;
      }
      flowIdRef.current = r.flowId;
      setPhase({ kind: 'waiting', flow: r });
      poll(r.flowId);
    } catch (err) {
      setPhase({
        kind: 'refused',
        code: 'error',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }, [serverName, personalityId, poll]);

  const cancel = useCallback(() => {
    stopPolling();
    const flowId = flowIdRef.current;
    flowIdRef.current = null;
    if (flowId) rpc.mcp.deviceCancel({ flowId }).catch(() => {});
    setPhase({ kind: 'idle' });
  }, [stopPolling]);

  // Unmount: stop polling and drop any outstanding flow.
  useEffect(
    () => () => {
      stopPolling();
      const flowId = flowIdRef.current;
      flowIdRef.current = null;
      if (flowId) rpc.mcp.deviceCancel({ flowId }).catch(() => {});
    },
    [stopPolling],
  );

  return { phase, start, cancel };
}
