import type { BackgroundJob, BackgroundJobStatus, RunUpdateDigest } from '@ethosagent/types';

// The run card's liveness feed (G9/D11/D20), split out of the executor: one
// coalescing digest per running job, published to `onRunUpdate` subscribers.
// Pinned by `__tests__/run-digest.test.ts`.

/**
 * Minimum gap between two digests for the SAME run (D11's "≤1 Hz per run").
 * Per-run, not global: ten concurrent runs each get their own second.
 */
export const RUN_UPDATE_MIN_INTERVAL_MS = 1_000;

/**
 * Live digest state for one running job. `pending` is the trailing-edge timer:
 * a burst of tool events inside one second collapses into a single publish at
 * the end of it, which is the whole point of coalescing rather than throttling.
 */
interface RunDigest {
  parentSessionKey: string;
  runner: string;
  status: BackgroundJobStatus;
  now: string;
  startedAt: number;
  spendUsd: number;
  toolCount: number;
  lastPublishedAt: number;
  pending: ReturnType<typeof setTimeout> | undefined;
  /** The run that opened this digest; a later run on the same job id must not be torn down by an older one's cleanup. */
  run: AbortController;
}

export class RunDigestBoard {
  /** job.id -> its coalescing digest state, for the lifetime of the run. */
  private readonly digests = new Map<string, RunDigest>();
  private readonly handlers: Array<(update: RunUpdateDigest) => void> = [];

  constructor(
    private readonly defaultRunnerName: string,
    private readonly log: ((msg: string) => void) | undefined,
  ) {}

  /** Subscribe; returns an unsubscribe function. */
  subscribe(handler: (update: RunUpdateDigest) => void): () => void {
    this.handlers.push(handler);
    return () => {
      const idx = this.handlers.indexOf(handler);
      if (idx !== -1) this.handlers.splice(idx, 1);
    };
  }

  /** Open the digest for a run and publish its first sample immediately. */
  open(job: BackgroundJob, run: AbortController): void {
    this.discard(job.id);
    this.digests.set(job.id, {
      run,
      parentSessionKey: job.parentSessionKey,
      runner: job.runner ?? this.defaultRunnerName,
      status: 'running',
      now: '',
      startedAt: job.startedAt ?? Date.now(),
      spendUsd: job.spendUsd ?? 0,
      toolCount: 0,
      lastPublishedAt: 0,
      pending: undefined,
    });
    this.publish(job.id);
  }

  toolCount(jobId: string): number {
    return this.digests.get(jobId)?.toolCount ?? 0;
  }

  /**
   * Fold new facts into a run's digest and schedule its publication. A status
   * change publishes immediately; everything else coalesces.
   *
   * A no-op for a job with no open digest — `markJobBlocked` may be called for a
   * row this process is not running, and a completion write races the run's own
   * teardown — and for a `run` that is not the digest's owner, so a lost run's
   * late sample cannot overwrite its same-process successor's card. Pinned by
   * `__tests__/run-digest.test.ts` ('RunDigestBoard ownership').
   */
  update(
    jobId: string,
    patch: Partial<Pick<RunDigest, 'status' | 'now' | 'spendUsd' | 'toolCount'>>,
    run: AbortController,
  ): void {
    const digest = this.digests.get(jobId);
    if (!digest || digest.run !== run) return;
    const statusChanged = patch.status !== undefined && patch.status !== digest.status;
    Object.assign(digest, patch);
    if (statusChanged) {
      this.publish(jobId);
      return;
    }
    const wait = RUN_UPDATE_MIN_INTERVAL_MS - (Date.now() - digest.lastPublishedAt);
    if (wait <= 0) {
      this.publish(jobId);
      return;
    }
    // Trailing edge: one publish at the end of the window carrying the LATEST
    // state, not the sample that happened to arrive first.
    if (digest.pending) return;
    digest.pending = setTimeout(() => this.publish(jobId), wait);
    digest.pending.unref?.();
  }

  /** Emit the digest's current state and reset its coalescing window. */
  private publish(jobId: string): void {
    const digest = this.digests.get(jobId);
    if (!digest) return;
    if (digest.pending) {
      clearTimeout(digest.pending);
      digest.pending = undefined;
    }
    digest.lastPublishedAt = Date.now();
    const update: RunUpdateDigest = {
      parentSessionKey: digest.parentSessionKey,
      jobId,
      runner: digest.runner,
      status: digest.status,
      now: digest.now,
      elapsedMs: Math.max(0, Date.now() - digest.startedAt),
      spendUsd: digest.spendUsd,
      toolCount: digest.toolCount,
    };
    for (const handler of [...this.handlers]) {
      try {
        handler(update);
      } catch (err) {
        this.log?.(
          `onRunUpdate handler failed for ${jobId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /** Publish the terminal sample, then drop the digest and its timer. */
  close(jobId: string, status: BackgroundJobStatus): void {
    const digest = this.digests.get(jobId);
    if (!digest) return;
    digest.status = status;
    digest.now = '';
    this.publish(jobId);
    this.discard(jobId);
  }

  /** Drop `run`'s digest without a final sample; another run's digest on the same id stays. */
  dropOwnedBy(jobId: string, run: AbortController): void {
    const digest = this.digests.get(jobId);
    if (digest?.run !== run) return;
    this.discard(jobId);
  }

  /** Cancel the digest's pending timer and forget it. */
  private discard(jobId: string): void {
    const pending = this.digests.get(jobId)?.pending;
    if (pending) clearTimeout(pending);
    this.digests.delete(jobId);
  }

  /** Clear every timer; for shutdown. */
  clear(): void {
    for (const jobId of [...this.digests.keys()]) this.discard(jobId);
  }
}
