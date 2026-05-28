export type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error';

export interface DiagnosticEvent {
  pluginId: string;
  level: DiagnosticLevel;
  message: string;
  timestamp: string;
  data?: Record<string, unknown>;
  sessionId?: string;
  turnId?: string;
}

export interface DiagnosticMetric {
  pluginId: string;
  name: string;
  value: number;
  labels?: Record<string, string>;
  timestamp: string;
}

export interface HealthCheckResult {
  status: 'ok' | 'warn' | 'error';
  message: string;
  details?: Record<string, unknown>;
  durationMs?: number;
}

export interface PluginHealthCheck {
  name: string;
  description: string;
  run(): Promise<HealthCheckResult>;
}

export interface DiagnosticsEmitter {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  metric(name: string, value: number, labels?: Record<string, string>): void;
}
