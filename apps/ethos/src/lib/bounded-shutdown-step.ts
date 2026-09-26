/**
 * One await on a host's SIGINT/SIGTERM path that has no deadline of its own —
 * an adapter's `stop()`, an outbox review drain, a lock release, a listener
 * close — run under a bound, so the process always reaches the store closes,
 * the gateway lock release and `process.exit` that follow it.
 *
 * A step still pending at `timeoutMs` is LEFT BEHIND (the exit that follows
 * releases whatever it holds); a step that throws is reported the same way.
 * Neither ever rejects out of here, so one step cannot skip the rest of the
 * sequence. Both are recorded as a `shutdown.step_timeout` /
 * `shutdown.step_failed` safety block naming the step, and warned.
 *
 * The timer is referenced on purpose, like `disposeBeforeExit`'s: a hung step
 * that holds no handle of its own must not let the event loop drain and end
 * the process before the rest of the shutdown runs.
 *
 * Callers: `ethos gateway start`, `ethos boot`, `ethos serve`. `ethos run-all`
 * sizes its SIGKILL grace from `SHUTDOWN_STEP_TIMEOUT_MS` times the number of
 * these steps on the gateway's path (commands/run-all.ts,
 * `CHILD_PRE_DISPOSE_DRAIN_MS`). Pinned by
 * apps/ethos/src/lib/__tests__/bounded-shutdown-step.test.ts.
 */

/** The per-step bound — the same 3s one step of a runtime's dispose gets
 *  (`DISPOSE_STEP_TIMEOUT_MS`, packages/wiring/src/disposer-stack.ts). */
export const SHUTDOWN_STEP_TIMEOUT_MS = 3_000;

export interface ShutdownStepSink {
  recordSafetyBlock(opts: {
    code?: string;
    cause?: string;
    details?: Record<string, unknown>;
  }): void;
}

export interface ShutdownStepReporting {
  /** Resolved lazily and fail-open: the observability store may be unusable. */
  sink: () => ShutdownStepSink;
  warn: (message: string) => void;
}

export async function boundedShutdownStep(
  step: string,
  run: () => unknown,
  reporting: ShutdownStepReporting,
  timeoutMs: number = SHUTDOWN_STEP_TIMEOUT_MS,
): Promise<void> {
  const report = (code: string, cause: string, details: Record<string, unknown>): void => {
    try {
      reporting.warn(`[shutdown] ${step}: ${cause}`);
      reporting.sink().recordSafetyBlock({ code, cause, details: { step, ...details } });
    } catch {
      // Fail-open: reporting must not cost the rest of the shutdown.
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      Promise.resolve()
        .then(run)
        .then(() => 'done' as const),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      }),
    ]);
    if (outcome === 'timeout') {
      report('shutdown.step_timeout', `did not finish within ${timeoutMs}ms — left behind`, {
        timeoutMs,
      });
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    report('shutdown.step_failed', `failed: ${error}`, { error });
  } finally {
    clearTimeout(timer);
  }
}
