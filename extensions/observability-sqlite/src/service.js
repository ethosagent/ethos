import { randomUUID } from 'node:crypto';
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
  store;
  blobStore;
  isDisabled;
  tracePolicies = new Map();
  constructor(
    store,
    blobStore,
    /** Returns true when writes should be suppressed (e.g. during a data reset). */
    isDisabled,
  ) {
    this.store = store;
    this.blobStore = blobStore;
    this.isDisabled = isDisabled;
  }
  /** Start a new trace. Returns the traceId. */
  startTrace(opts) {
    const traceId = randomUUID();
    if (this.isDisabled?.()) return traceId; // suppress writes during reset window
    const trace = {
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
  endTrace(traceId, status) {
    if (this.isDisabled?.()) return;
    this.store.closeTrace(traceId, status);
    this.tracePolicies.delete(traceId);
  }
  /** Start a span inside a trace. Returns the spanId. */
  startSpan(opts) {
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
    const span = {
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
  endSpan(spanId, status, attrs) {
    if (this.isDisabled?.()) return;
    // Close the span (sets end_ts + status).
    this.store.closeSpan(spanId, status);
    // If extra attrs provided, we'd update — but the store interface only supports closeSpan.
    // attrs parameter is reserved for future use.
    void attrs;
  }
  /** Record a timestamped event. */
  recordEvent(event) {
    if (this.isDisabled?.()) return;
    const obsEvent = {
      ...event,
      eventId: randomUUID(),
      ts: Date.now(),
    };
    const policy = event.traceId ? this.tracePolicies.get(event.traceId) : undefined;
    this.store.insertEvent(obsEvent, policy?.extraPatterns);
  }
  /** Store a snapshot blob and register it in the snapshots table. */
  async recordSnapshot(opts) {
    if (this.isDisabled?.()) return randomUUID(); // suppress writes during reset window
    const snapshotId = await this.blobStore.put(opts.body);
    const snapshot = {
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
   * Currently a no-op (all writes are synchronous via better-sqlite3).
   * Reserved as a hook for future batching.
   */
  flush() {
    // No-op in Wave A — better-sqlite3 is synchronous.
  }
}
