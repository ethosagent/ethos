/**
 * The cleanup half of a composition root (F06 — the assembler owns shutdown
 * too). An assembler pushes a resource's cleanup right after constructing it,
 * so construction and release sit side by side and a resource can never be
 * built without its release being known.
 *
 * `dispose()` runs the cleanups in REVERSE registration order: a worker built
 * on top of a store stops before the store it writes to closes. Every cleanup
 * is attempted even when an earlier one throws; the failures are collected and
 * rethrown together as one `AggregateError` once all have run. The call is
 * memoised, so a second `dispose()` returns the first one's promise and runs
 * nothing again.
 *
 * Each step is bounded by `stepTimeoutMs`: a cleanup that never settles (a
 * plugin whose `deactivate` hangs, a run that ignores its abort) is reported
 * as a failure and left behind, and the steps after it still run — they are
 * usually the store closes that matter most. Three bounded workers still fit
 * inside the 10 s a stopping host gives the whole disposal
 * (`DISPOSE_BEFORE_EXIT_GRACE_MS`, `DESKTOP_SHUTDOWN_GRACE_MS`). The timer is
 * referenced on purpose: a hung step that holds no handle of its own must not
 * let the process drain its event loop and exit mid-disposal.
 *
 * Pinned by packages/wiring/src/__tests__/disposer-stack.test.ts.
 */
export const DISPOSE_STEP_TIMEOUT_MS = 3_000;

export class DisposerStack {
  private readonly cleanups: Array<{ label: string; fn: () => unknown }> = [];
  private disposal: Promise<void> | undefined;
  private readonly stepTimeoutMs: number;

  constructor(opts: { stepTimeoutMs?: number } = {}) {
    this.stepTimeoutMs = opts.stepTimeoutMs ?? DISPOSE_STEP_TIMEOUT_MS;
  }

  /** Register the cleanup for a resource the caller just constructed. */
  push(label: string, fn: () => unknown): void {
    if (this.disposal) {
      throw new Error(`cannot register cleanup "${label}": this runtime is already disposed`);
    }
    this.cleanups.push({ label, fn });
  }

  /** Release everything registered so far, newest first. Idempotent. */
  dispose(): Promise<void> {
    this.disposal ??= this.run();
    return this.disposal;
  }

  private async run(): Promise<void> {
    const failures: Error[] = [];
    for (const { label, fn } of [...this.cleanups].reverse()) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timedOut = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), this.stepTimeoutMs);
        });
        const outcome = await Promise.race([Promise.resolve().then(fn), timedOut]);
        if (outcome === 'timeout') {
          failures.push(new Error(`${label}: did not finish within ${this.stepTimeoutMs}ms`));
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        failures.push(new Error(`${label}: ${detail}`, { cause: err }));
      } finally {
        clearTimeout(timer);
      }
    }
    this.cleanups.length = 0;
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `${failures.length} cleanup step(s) failed: ${failures.map((f) => f.message).join('; ')}`,
      );
    }
  }
}
