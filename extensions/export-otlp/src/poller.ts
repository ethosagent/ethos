import type { ClaimedTrace, SQLiteObservabilityStore } from '@ethosagent/observability-sqlite';
import { nextDelay } from './backoff';
import { postOtlp } from './client';
import type { TraceBundle } from './mapping';
import { toExportRequest } from './mapping';
import type { OtlpSettings } from './settings';

// ---------------------------------------------------------------------------
// The poll tick of §4.2 (plan/phases/otlp-export.md): claim → map → POST →
// stamp-or-release, mirroring `LangfusePollLoop`
// (extensions/export-langfuse/src/poller.ts) with three additions the plan
// asks for — a bounded backlog (D11), per-exporter backoff (D11), and the
// per-personality opt-out (D12). No `console.*`: failures are reported
// through `onError` only, and nothing from the request (headers above all —
// they carry collector credentials, D7) may reach an `onError` message.
// ---------------------------------------------------------------------------

const SINK = 'otlp';
const BATCH_SIZE = 50;
/** See `LangfusePollLoop`'s constant of the same value: a claim outliving
 *  this is a crashed poller's, and the request timeout (10s default) is far
 *  inside it, so a live exporter is never reclaimed mid-POST (D10). */
const STALE_CLAIM_CUTOFF_MS = 120_000;
/** §4.2 step 5 — one request stays under this; a bigger batch is split by
 *  trace into several requests, each under the cap. */
const MAX_BODY_BYTES = 1024 * 1024;

export interface OtlpPollConfig {
  store: SQLiteObservabilityStore;
  settings: OtlpSettings;
  /** D12 — the per-personality `safety.observability.exportTraces` gate,
   *  built by the wiring host from the personality registry. `false` stamps
   *  the trace `opted_out`; it is never POSTed. */
  isExportAllowed: (subjectId: string | undefined) => boolean;
  onError?: (err: Error) => void;
  /** Injected fetch — tests never hit the network. */
  fetchImpl?: typeof globalThis.fetch;
  /** Jitter source for `nextDelay`; injectable so tests can seed it. */
  rng?: () => number;
  /** Clock; injectable so tests can drive the backoff window. */
  now?: () => number;
}

/** One tick's outcome tally, for tests and callers that tick manually. */
export interface OtlpTickResult {
  exported: number;
  rejected: number;
  optedOut: number;
  pruned: number;
  droppedBacklog: number;
  /** Claims put back for a retryable failure (or a mid-tick `stop()`). */
  released: number;
  /** True when the tick returned without claiming: still inside backoff. */
  inBackoff: boolean;
}

/** A claimed trace paired with everything the store holds for it. */
interface ClaimedBundle {
  claim: ClaimedTrace;
  bundle: TraceBundle;
}

/**
 * Self-rescheduling claim → export → stamp-or-release poller — the
 * `LangfusePollLoop` shape: `setTimeout` (unref'd) reschedules only after the
 * previous tick fully finishes, never an overlapping `setInterval`. Runs
 * wherever wired (gateway and/or serve); `claimTracesForSink`'s atomic claim
 * keeps concurrent pollers' batches disjoint (D10).
 */
export class OtlpPollLoop {
  private readonly store: SQLiteObservabilityStore;
  private readonly settings: OtlpSettings;
  private readonly isExportAllowed: (subjectId: string | undefined) => boolean;
  private readonly onError?: (err: Error) => void;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly rng: () => number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;
  /** Backoff state (D11) — per exporter, not per trace. */
  private attempt = 0;
  private backoffUntil = 0;

  constructor(config: OtlpPollConfig) {
    this.store = config.store;
    this.settings = config.settings;
    this.isExportAllowed = config.isExportAllowed;
    this.onError = config.onError;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.rng = config.rng ?? Math.random;
    this.now = config.now ?? Date.now;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    const loop = async () => {
      if (!this.running) return;
      try {
        await this.tick();
      } catch (err) {
        this.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
      if (this.running) {
        this.timer = setTimeout(loop, this.settings.intervalMs);
        this.timer.unref?.();
      }
    };
    void loop();
  }

  /** Clears the timer; a tick in flight releases every claim it still holds
   *  before its next POST and returns (pinned by poller.test.ts). */
  stop(): void {
    this.running = false;
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** One §4.2 pass. Any throw releases every claim this tick still holds —
   *  the Langfuse catch-releases rule — and is reported via `onError`. */
  async tick(): Promise<OtlpTickResult> {
    const result: OtlpTickResult = {
      exported: 0,
      rejected: 0,
      optedOut: 0,
      pruned: 0,
      droppedBacklog: 0,
      released: 0,
      inBackoff: false,
    };
    // 1. Inside a backoff window → nothing this tick.
    if (this.now() < this.backoffUntil) {
      result.inBackoff = true;
      return result;
    }
    const minStartTs = this.now() - this.settings.backlogMaxAgeMs;
    // The claims this tick holds and has not yet stamped or released.
    const held = new Map<string, ClaimedTrace>();
    try {
      // 2. Bounded backlog (D11): traces older than the bound are stamped
      //    terminal, counted, and never claimed.
      const dropped = this.store.markStaleForSink(SINK, minStartTs);
      if (dropped > 0) {
        this.store.countSinkExportOutcome(SINK, 'dropped_backlog', dropped);
        result.droppedBacklog = dropped;
      }
      // 3. Claim.
      const claimed = this.store.claimTracesForSink(
        SINK,
        BATCH_SIZE,
        STALE_CLAIM_CUTOFF_MS,
        minStartTs,
      );
      for (const claim of claimed) held.set(claim.trace.traceId, claim);
      // 4. Opt-out (D12) and pruned-under-us traces are stamped, never POSTed.
      const bundles: ClaimedBundle[] = [];
      for (const claim of claimed) {
        const traceId = claim.trace.traceId;
        if (!this.isExportAllowed(claim.trace.subjectId)) {
          this.store.markSinkExported(SINK, traceId, claim.claimedAt, 'opted_out');
          held.delete(traceId);
          result.optedOut++;
          continue;
        }
        const spans = this.store.getSpans(traceId);
        if (spans.length === 0) {
          // Retention outran export (or the trace closed with no spans) —
          // nothing left to ship; stamp so it stops being re-claimed forever.
          this.store.markSinkExported(SINK, traceId, claim.claimedAt, 'pruned');
          held.delete(traceId);
          result.pruned++;
          continue;
        }
        const events = this.store.getEventsByTraceIds([traceId]);
        bundles.push({ claim, bundle: { trace: claim.trace, spans, events } });
      }
      if (bundles.length === 0) return result;
      // 5. Map into ONE request; split by trace when the body is over the cap.
      const requests = this.serializeRequests(bundles);
      // 6. POST each.
      for (const request of requests) {
        // A mid-tick stop() must leave no held claim: release whatever this
        // tick still holds and hand the traces to the next process's claim.
        if (this.stopped) {
          result.released += this.releaseHeld(held);
          return result;
        }
        const res = await postOtlp(
          this.settings.tracesUrl,
          this.settings.headers,
          request.body,
          this.settings.timeoutMs,
          this.fetchImpl,
        );
        if (res.ok) {
          for (const { claim } of request.bundles) {
            this.store.markSinkExported(SINK, claim.trace.traceId, claim.claimedAt, 'exported');
            held.delete(claim.trace.traceId);
            result.exported++;
          }
          // A partial success is still an accepted export — counted, never
          // retried (the collector kept what it kept).
          if (res.partialRejectedSpans !== undefined && res.partialRejectedSpans > 0) {
            this.store.countSinkExportOutcome(SINK, 'partial', res.partialRejectedSpans);
          }
          // First 2xx resets the backoff attempt counter (D11).
          this.attempt = 0;
        } else if (res.retryable) {
          // An outage is a collector property: release the WHOLE batch —
          // every claim this tick still holds — and enter backoff, honoring
          // `Retry-After` when it asks for more than the jittered delay.
          const released = this.releaseHeld(held);
          result.released += released;
          const delayMs = nextDelay(this.attempt, res.retryAfterMs, this.rng);
          this.backoffUntil = this.now() + delayMs;
          this.attempt++;
          // One warning per backoff step (success criterion 3); ticks inside
          // the window return above and stay silent. Status + response-body
          // snippet only, as in the rejected branch below.
          const cause = res.status !== undefined ? `HTTP ${res.status}` : 'network error';
          const snippet = res.bodySnippet !== undefined ? `: ${res.bodySnippet}` : '';
          this.onError?.(
            new Error(
              `OTLP collector unavailable (${cause})${snippet}; released ${released} trace(s), ` +
                `retrying in ${(delayMs / 1000).toFixed(1)}s (attempt ${this.attempt})`,
            ),
          );
          return result;
        } else {
          // Non-retryable (D13): terminal. Stamp, count, surface — no backoff.
          for (const { claim } of request.bundles) {
            this.store.markSinkExported(SINK, claim.trace.traceId, claim.claimedAt, 'rejected');
            held.delete(claim.trace.traceId);
            result.rejected++;
          }
          this.store.countSinkExportOutcome(SINK, 'rejected', request.bundles.length);
          // Status + response-body snippet only — postOtlp guarantees nothing
          // from the request (headers included) reaches these fields.
          const snippet = res.bodySnippet !== undefined ? `: ${res.bodySnippet}` : '';
          this.onError?.(
            new Error(`OTLP export rejected (HTTP ${res.status ?? 'unknown'})${snippet}`),
          );
        }
      }
      return result;
    } catch (err) {
      // 7. The Langfuse catch-releases rule: a throw anywhere above never
      //    leaves a trace stuck claimed for the stale-claim window.
      result.released += this.releaseHeld(held);
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
      return result;
    }
  }

  private releaseHeld(held: Map<string, ClaimedTrace>): number {
    let released = 0;
    for (const claim of held.values()) {
      this.store.releaseSinkClaim(SINK, claim.trace.traceId, claim.claimedAt);
      released++;
    }
    held.clear();
    return released;
  }

  /**
   * Serialize the batch as ONE `ExportTraceServiceRequest`; when the body
   * exceeds 1 MiB, split the traces in half recursively until every request
   * is under the cap (a SINGLE trace over the cap cannot be split further and
   * ships as its own request — the collector's limit, if any, answers it).
   */
  private serializeRequests(bundles: ClaimedBundle[]): Array<{
    body: string;
    bundles: ClaimedBundle[];
  }> {
    const body = JSON.stringify(
      toExportRequest(
        bundles.map((b) => b.bundle),
        { resource: this.settings.resource, includeContent: this.settings.includeContent },
      ),
    );
    if (Buffer.byteLength(body, 'utf8') <= MAX_BODY_BYTES || bundles.length === 1) {
      return [{ body, bundles }];
    }
    const mid = Math.ceil(bundles.length / 2);
    return [
      ...this.serializeRequests(bundles.slice(0, mid)),
      ...this.serializeRequests(bundles.slice(mid)),
    ];
  }
}
