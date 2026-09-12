/**
 * The process-exit end of F06 (assembler-owned disposal): run each runtime's
 * `dispose()` in order — a surface that BORROWED a loop before the loop itself,
 * then the host's own stores — on the way to `process.exit`.
 *
 * Bounded on purpose. A dispose drains work (the background executor awaits
 * every aborted run's unwind, plugins run their own `deactivate`), and one that
 * never settles must not keep a stopping process alive: the exit that follows
 * releases whatever it did not. All steps share one `graceMs` budget; a step
 * still pending when the budget runs out is reported and LEFT BEHIND, and the
 * steps after it still run — the host's own sessions.db / observability.db
 * closes come last and are what leave no `-wal` file behind. A failing step is
 * reported the same way.
 *
 * The grace timer is referenced on purpose: while shutdown is in progress, a
 * hung step that holds no handle of its own must not let the event loop drain
 * and end the process before `process.exit` runs.
 *
 * The desktop's stop (`shutdownDesktopRuntime`,
 * apps/desktop/src/main/runtime-shutdown.ts) applies the same 10 s bound for
 * the same reason, without exiting afterwards.
 *
 * Pinned by apps/ethos/src/lib/__tests__/dispose-before-exit.test.ts.
 */
export const DISPOSE_BEFORE_EXIT_GRACE_MS = 10_000;

export async function disposeBeforeExit(
  steps: ReadonlyArray<readonly [label: string, dispose: (() => Promise<void>) | undefined]>,
  warn: (message: string) => void,
  graceMs: number = DISPOSE_BEFORE_EXIT_GRACE_MS,
): Promise<void> {
  const deadline = Date.now() + graceMs;
  for (const [label, dispose] of steps) {
    if (!dispose) continue;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), Math.max(0, deadline - Date.now()));
      });
      const outcome = await Promise.race([dispose(), timedOut]);
      if (outcome === 'timeout') {
        warn(`[shutdown] ${label}: did not finish within ${graceMs}ms — left behind`);
      }
    } catch (err) {
      warn(
        `[shutdown] ${label}: dispose failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
