import { randomUUID } from 'node:crypto';
import type {
  EventCategory,
  EventSeverity,
  ObsEvent,
  ObservabilityStore,
  ObservabilityWriter,
  RedactionPolicy,
  Snapshot,
  Span,
  SpanKind,
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
export class ObservabilityService implements ObservabilityWriter {
  private readonly tracePolicies = new Map<string, RedactionPolicy>();

  constructor(
    private readonly store: ObservabilityStore,
    private readonly blobStore: BlobStore,
    /** Returns true when writes should be suppressed (e.g. during a data reset). */
    private readonly isDisabled?: () => boolean,
  ) {}

  /** Start a new trace. Returns the traceId. */
  startTrace(opts: {
    sessionId?: string;
    kind: TraceKind;
    subjectId?: string;
    snapshotId?: string;
    attrs?: Record<string, unknown>;
    redaction?: RedactionPolicy;
  }): string {
    const traceId = randomUUID();
    if (this.isDisabled?.()) return traceId; // suppress writes during reset window
    const trace: Trace = {
      traceId,
      sessionId: opts.sessionId,
      kind: opts.kind,
      startTs: Date.now(),
      subjectId: opts.subjectId,
      snapshotId: opts.snapshotId,
      attrs: opts.attrs,
    };
    this.store.insertTrace(trace);
    if (opts.redaction) {
      this.tracePolicies.set(traceId, opts.redaction);
    }
    return traceId;
  }

  /** Close a trace with a final status. */
  endTrace(traceId: string, status: 'ok' | 'error' | 'aborted'): void {
    if (this.isDisabled?.()) return;
    this.store.closeTrace(traceId, status);
    this.tracePolicies.delete(traceId);
  }

  /** Start a span inside a trace. Returns the spanId. */
  startSpan(opts: {
    traceId: string;
    parentSpanId?: string;
    kind: SpanKind;
    name: string;
    attrs?: Record<string, unknown>;
    redaction?: RedactionPolicy;
  }): string {
    const policy = opts.redaction ?? this.tracePolicies.get(opts.traceId);
    const level = policy?.level ?? 'redacted';
    const extraPatterns = policy?.extraPatterns;

    let finalAttrs = opts.attrs;
    // 'full' skips the consumer-supplied extra patterns; the built-in floor
    // patterns still apply.
    let effectiveExtraPatterns = extraPatterns;
    if (opts.kind === 'tool_call' && finalAttrs?.args !== undefined) {
      if (level === 'none') {
        // Strip args entirely — keep everything else
        const { args: _dropped, ...rest } = finalAttrs;
        finalAttrs = rest;
      } else if (level === 'full') {
        // Built-in floor patterns still apply; consumer extras are skipped.
        effectiveExtraPatterns = undefined;
      }
      // 'redacted' — default: built-in patterns + consumer extras both apply.
    }

    const spanId = randomUUID();
    if (this.isDisabled?.()) return spanId; // suppress writes during reset window
    const span: Span = {
      spanId,
      traceId: opts.traceId,
      parentSpanId: opts.parentSpanId,
      kind: opts.kind,
      name: opts.name,
      startTs: Date.now(),
      attrs: finalAttrs,
    };
    this.store.insertSpan(span, effectiveExtraPatterns);
    return spanId;
  }

  /** Close a span with a final status and optional extra attrs. */
  endSpan(
    spanId: string,
    status: 'ok' | 'error' | 'blocked',
    attrs?: Record<string, unknown>,
  ): void {
    if (this.isDisabled?.()) return;
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
    if (this.isDisabled?.()) return;
    const obsEvent: ObsEvent = {
      ...event,
      eventId: randomUUID(),
      ts: Date.now(),
    };
    const policy = event.traceId ? this.tracePolicies.get(event.traceId) : undefined;
    this.store.insertEvent(obsEvent, policy?.extraPatterns);
  }

  /** Store a snapshot blob and register it in the snapshots table. */
  async recordSnapshot(opts: { subjectId: string; body: string }): Promise<string> {
    if (this.isDisabled?.()) return randomUUID(); // suppress writes during reset window
    const snapshotId = await this.blobStore.put(opts.body);
    const snapshot: Snapshot = {
      snapshotId,
      takenAt: Date.now(),
      subjectId: opts.subjectId,
      body: opts.body,
    };
    this.store.insertSnapshot(snapshot);
    return snapshotId;
  }

  /**
   * Flush all pending writes.
   * Currently a no-op (all writes are synchronous via @ethosagent/sqlite).
   * Reserved as a hook for future batching.
   */
  flush(): void {
    // No-op in Wave A — @ethosagent/sqlite is synchronous.
  }
}
