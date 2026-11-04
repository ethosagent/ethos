export type HostEventCategory =
  | 'plugin_host.spawned'
  | 'plugin_host.crashed'
  | 'plugin_host.restarted'
  | 'plugin_host.circuit_open'
  | 'plugin_host.registration_drift'
  | 'plugin_host.stopped'
  | 'plugin_host.denied'
  | 'plugin_host.capability_clamped'
  | 'plugin_host.stats';

/** Sink the observability lane wires later; payloads never carry secret values. */
export type HostEventSink = (category: HostEventCategory, payload: Record<string, unknown>) => void;

export type HostSpanOutcome = 'ok' | 'error' | 'timeout' | 'aborted' | 'unavailable';

export interface HostSpanStart {
  /** The IPC method: `tool.execute:<tool>`, `hook.fire:<name>`, `injector.inject`, ... */
  name: string;
  pluginId: string;
  toolCallId?: string;
  sessionId?: string;
}

export interface HostSpanEnd {
  outcome: HostSpanOutcome;
  reqBytes: number;
  resBytes: number;
  /** Parent-observed round trip. */
  ipcMs: number;
  /** Time the host spent in the handler, as it reported it; absent when the call never got an answer. */
  hostMs?: number;
}

/**
 * Per-call span recorder the composition root injects (plugin-host must not
 * import wiring). `start` returns the closer. Must not throw; the pool also
 * guards it.
 */
export type HostSpanSink = (start: HostSpanStart) => (end: HostSpanEnd) => void;
