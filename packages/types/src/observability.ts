export type TraceKind =
  | 'turn'
  | 'mesh.handshake'
  | 'cron.tick'
  | 'channel.inbound'
  | 'system'
  | 'support.bundle';

export type SpanKind = 'tool_call' | 'llm_call' | 'hook' | 'mcp_call';

export type EventCategory =
  | 'error'
  | 'audit.transition'
  | 'audit.approval'
  | 'audit.block'
  | 'audit.watcher'
  | 'audit.injection_flag'
  | 'audit.redacted'
  | 'channel.pairing'
  | 'channel.allow'
  | 'channel.deny'
  | 'install.scan'
  | 'install.event';

export type EventSeverity = 'info' | 'warn' | 'error' | 'critical';

export interface Trace {
  traceId: string;
  sessionId?: string;
  kind: TraceKind;
  startTs: number;
  endTs?: number;
  status?: 'ok' | 'error' | 'aborted';
  personalityId?: string;
  snapshotId?: string;
  attrs?: Record<string, unknown>;
}

export interface Span {
  spanId: string;
  traceId: string;
  parentSpanId?: string;
  kind: SpanKind;
  name: string;
  startTs: number;
  endTs?: number;
  status?: 'ok' | 'error' | 'blocked';
  attrs?: Record<string, unknown>;
}

export interface ObsEvent {
  eventId: string;
  traceId?: string;
  spanId?: string;
  ts: number;
  category: EventCategory;
  severity: EventSeverity;
  code?: string;
  cause?: string;
  details?: Record<string, unknown>;
}

export interface PolicySnapshot {
  snapshotId: string;
  takenAt: number;
  personalityId: string;
  body: string;
}

export interface ObservabilityStore {
  insertTrace(trace: Trace): void;
  closeTrace(traceId: string, status: 'ok' | 'error' | 'aborted'): void;
  insertSpan(span: Span): void;
  closeSpan(spanId: string, status: 'ok' | 'error' | 'blocked'): void;
  insertEvent(event: ObsEvent): void;
  insertSnapshot(snapshot: PolicySnapshot): void;
  getTrace(traceId: string): Trace | null;
  getSpans(traceId: string): Span[];
  getEvents(filter: {
    traceId?: string;
    category?: string;
    since?: number;
    limit?: number;
  }): ObsEvent[];
  getRecentTraces(limit: number): Trace[];
  close(): void;
}
