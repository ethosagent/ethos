export interface NotifyOptions {
  sessionKey: string;
  message: string;
  startTurn?: boolean;
  payload?: Record<string, unknown>;
}

export interface MonitorRunContext {
  pluginId: string;
  notify(opts: NotifyOptions): Promise<void>;
  getSecret(key: string): Promise<string | null>;
  kvStore: import('./tool-capabilities').KeyValueStore;
  signal: AbortSignal;
  emit(event: string, payload: unknown): void;
  diagnostics?: import('./diagnostics').DiagnosticsEmitter;
  llm?: import('./plugin-llm').SimpleCompletion;
}

export interface PluginMonitorDef {
  name: string;
  run(params: Record<string, unknown>, ctx: MonitorRunContext): Promise<void>;
}
