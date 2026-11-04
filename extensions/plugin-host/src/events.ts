export type HostEventCategory =
  | 'plugin_host.spawned'
  | 'plugin_host.crashed'
  | 'plugin_host.restarted'
  | 'plugin_host.circuit_open'
  | 'plugin_host.registration_drift'
  | 'plugin_host.stopped'
  | 'plugin_host.denied'
  | 'plugin_host.capability_clamped';

/** Sink the observability lane wires later; payloads never carry secret values. */
export type HostEventSink = (category: HostEventCategory, payload: Record<string, unknown>) => void;
