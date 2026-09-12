import { DISPOSE_BEFORE_EXIT_GRACE_MS, disposeBeforeExit } from './dispose-before-exit';

/**
 * How long a one-shot command waits for work it already started (background
 * jobs, goal runs, a memory capture) before it disposes anyway.
 *
 * A one-shot command does not get to abandon what it spawned: the turn that
 * queued a background job has already told the user it started, and the
 * executor's rows outlive the process. So the command drains first and only
 * then disposes — but bounded, because a drain that never settles would hang a
 * CLI invocation that has already printed its answer. What is still running at
 * the bound is left in the store for the next process to claim (job affinity,
 * `JobStore.claimNextQueued`'s `adopt`), not silently dropped.
 */
export const COMMAND_DRAIN_MS = 5_000;

/** The pieces of an agent-loop runtime this helper needs. Structural on purpose:
 *  `CreateAgentLoopResult` and `ActiveLoop` (apps/ethos/src/wiring.ts) both fit. */
export interface ReleasableRuntime {
  dispose: () => Promise<void>;
  drain?: () => Promise<void>;
}

/**
 * The one way a non-daemon command releases the agent loop it built (F06 / the
 * lifecycle audit's G4).
 *
 * Every `ethos` command that is not `serve` / `boot` / `gateway` builds a loop,
 * does one thing and returns — and used to return without disposing anything,
 * so the process exited on top of live SQLite handles (a `-wal` file left on
 * disk), a ticking mesh reconciler and whatever the background executor was
 * mid-way through. There is ONE helper rather than a `dispose()` call per
 * command so an eleventh command cannot forget: the shape it accepts is the
 * shape both loop builders already return.
 *
 * Order: drain (bounded by `drainMs`) → dispose (bounded by
 * `disposeBeforeExit`'s shared grace). Never throws — a command's exit code
 * belongs to the command's work, not to its cleanup; failures and timeouts are
 * reported through `warn`.
 *
 * Pinned by apps/ethos/src/lib/__tests__/release-command-runtime.test.ts.
 */
export async function releaseCommandRuntime(
  runtime: ReleasableRuntime,
  opts: {
    /** Label used in the shutdown warnings. Defaults to `'agent loop'`. */
    label?: string;
    /** Bound on the drain. 0 skips it (nothing was started worth waiting for). */
    drainMs?: number;
    /** Bound on disposal. Defaults to `DISPOSE_BEFORE_EXIT_GRACE_MS`. */
    graceMs?: number;
    warn?: (message: string) => void;
    /** Host-owned stores this command opened itself, disposed AFTER the loop. */
    also?: ReadonlyArray<readonly [label: string, dispose: (() => Promise<void>) | undefined]>;
  } = {},
): Promise<void> {
  const {
    label = 'agent loop',
    drainMs = COMMAND_DRAIN_MS,
    graceMs = DISPOSE_BEFORE_EXIT_GRACE_MS,
    warn = (message: string) => process.stderr.write(`${message}\n`),
    also = [],
  } = opts;

  const drain = drainMs > 0 ? runtime.drain : undefined;
  await disposeBeforeExit(
    [
      [
        `${label} drain`,
        drain
          ? async () => {
              // The drain's own bound, inside the step: `disposeBeforeExit`
              // shares one budget across steps, and a drain that uses all of it
              // would leave nothing for the closes that follow.
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                await Promise.race([
                  drain(),
                  new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, drainMs);
                  }),
                ]);
              } finally {
                if (timer) clearTimeout(timer);
              }
            }
          : undefined,
      ],
      [label, () => runtime.dispose()],
      ...also,
      // Last, and for every command: the process-wide observability store
      // (`getObservabilityService` in apps/ethos/src/wiring.ts) is opened lazily
      // by the host, not by the loop, so no `dispose()` reaches it — a one-shot
      // command left `observability.db-wal` behind even once the loop's own
      // handles were closed. A no-op when nothing opened it.
      [
        'observability.db',
        async () => {
          const { closeObservabilityStore } = await import('../wiring');
          closeObservabilityStore();
        },
      ],
    ],
    warn,
    graceMs + (drain ? drainMs : 0),
  );
}
