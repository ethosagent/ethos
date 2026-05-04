import { randomUUID } from 'node:crypto';
import type {
  EventCategory,
  EventSeverity,
  ObsEvent,
  ObservabilityStore,
  PolicySnapshot,
  Span,
  SpanKind,
  Storage,
  Trace,
  TraceKind,
} from '@ethosagent/types';
import type { BlobStore } from './blob-store';

/**
 * ObservabilityService — thin coordinator over ObservabilityStore + BlobStore.
 *
 * Responsibilities:
 *  - Generates IDs for traces, spans, and events
 *  - Records timestamps automatically
 *  - Delegates storage to the injected ObservabilityStore
 *  - Provides blob storage via BlobStore
 *
 * No batching buffer in Wave A — every call writes immediately via the
 * synchronous SQLite store. The flush() method is a no-op hook for
 * future batching.
 */
export class ObservabilityService {
  constructor(
    private readonly store: ObservabilityStore,
    private readonly blobStore: BlobStore,
    // Storage is accepted to satisfy the interface contract and may be used
    // by future snapshot/blob helpers that need Storage access.
    private readonly _storage: Storage,
  ) {}

  /** Start a new trace. Returns the traceId. */
  startTrace(opts: {
    sessionId?: string;
    kind: TraceKind;
    personalityId?: string;
    attrs?: Record<string, unknown>;
  }): string {
    const traceId = randomUUID();
    const trace: Trace = {
      traceId,
      sessionId: opts.sessionId,
      kind: opts.kind,
      startTs: Date.now(),
      personalityId: opts.personalityId,
      attrs: opts.attrs,
    };
    this.store.insertTrace(trace);
    return traceId;
  }

  /** Close a trace with a final status. */
  endTrace(traceId: string, status: 'ok' | 'error' | 'aborted'): void {
    this.store.closeTrace(traceId, status);
  }

  /** Start a span inside a trace. Returns the spanId. */
  startSpan(opts: {
    traceId: string;
    parentSpanId?: string;
    kind: SpanKind;
    name: string;
    attrs?: Record<string, unknown>;
  }): string {
    const spanId = randomUUID();
    const span: Span = {
      spanId,
      traceId: opts.traceId,
      parentSpanId: opts.parentSpanId,
      kind: opts.kind,
      name: opts.name,
      startTs: Date.now(),
      attrs: opts.attrs,
    };
    this.store.insertSpan(span);
    return spanId;
  }

  /** Close a span with a final status and optional extra attrs. */
  endSpan(
    spanId: string,
    status: 'ok' | 'error' | 'blocked',
    attrs?: Record<string, unknown>,
  ): void {
    // Close the span (sets end_ts + status).
    this.store.closeSpan(spanId, status);
    // If extra attrs provided, we'd update — but the store interface only supports closeSpan.
    // attrs parameter is reserved for future use.
    void attrs;
  }

  /** Record a timestamped event. */
  recordEvent(
    event: Omit<ObsEvent, 'eventId' | 'ts'> & {
      category: EventCategory;
      severity: EventSeverity;
    },
  ): void {
    const obsEvent: ObsEvent = {
      ...event,
      eventId: randomUUID(),
      ts: Date.now(),
    };
    this.store.insertEvent(obsEvent);
  }

  /** Store a snapshot blob and register it in the snapshots table. */
  async recordSnapshot(opts: { personalityId: string; body: string }): Promise<string> {
    const snapshotId = await this.blobStore.put(opts.body);
    const snapshot: PolicySnapshot = {
      snapshotId,
      takenAt: Date.now(),
      personalityId: opts.personalityId,
      body: opts.body,
    };
    this.store.insertSnapshot(snapshot);
    return snapshotId;
  }

  /**
   * Flush all pending writes.
   * Currently a no-op (all writes are synchronous via better-sqlite3).
   * Reserved as a hook for future batching.
   */
  flush(): void {
    // No-op in Wave A — better-sqlite3 is synchronous.
  }
}
