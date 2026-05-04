import { randomUUID } from 'node:crypto';
import type {
  EventCategory,
  EventSeverity,
  ObsEvent,
  ObservabilityStore,
  ObservabilityWriter,
  PersonalityObservabilityConfig,
  PolicySnapshot,
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
  private readonly traceConfigs = new Map<string, PersonalityObservabilityConfig>();

  constructor(
    private readonly store: ObservabilityStore,
    private readonly blobStore: BlobStore,
  ) {}

  /** Start a new trace. Returns the traceId. */
  startTrace(opts: {
    sessionId?: string;
    kind: TraceKind;
    personalityId?: string;
    attrs?: Record<string, unknown>;
    obsConfig?: PersonalityObservabilityConfig;
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
    if (opts.obsConfig) {
      this.traceConfigs.set(traceId, opts.obsConfig);
    }
    return traceId;
  }

  /** Close a trace with a final status. */
  endTrace(traceId: string, status: 'ok' | 'error' | 'aborted'): void {
    this.store.closeTrace(traceId, status);
    this.traceConfigs.delete(traceId);
  }

  /** Start a span inside a trace. Returns the spanId. */
  startSpan(opts: {
    traceId: string;
    parentSpanId?: string;
    kind: SpanKind;
    name: string;
    attrs?: Record<string, unknown>;
    obsConfig?: PersonalityObservabilityConfig;
  }): string {
    const cfg = opts.obsConfig ?? this.traceConfigs.get(opts.traceId);
    const storeArgs = cfg?.storeToolArgs ?? 'redacted';
    const extraRedactPatterns = cfg?.redactPatterns;

    let finalAttrs = opts.attrs;
    // 'full' skips extra personality patterns but the 8 built-in floor patterns always apply.
    let effectiveExtraPatterns = extraRedactPatterns;
    if (opts.kind === 'tool_call' && finalAttrs?.args !== undefined) {
      if (storeArgs === 'none') {
        // Strip args entirely — keep everything else
        const { args: _dropped, ...rest } = finalAttrs;
        finalAttrs = rest;
      } else if (storeArgs === 'full') {
        // Built-in floor patterns still apply (spec: "even 'full' mode redacts these").
        // Only the personality's extra redactPatterns are skipped.
        effectiveExtraPatterns = undefined;
      }
      // 'redacted' — default: built-in patterns + personality extra patterns both apply
    }

    const spanId = randomUUID();
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
    const cfg = event.traceId ? this.traceConfigs.get(event.traceId) : undefined;
    this.store.insertEvent(obsEvent, cfg?.redactPatterns);
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
