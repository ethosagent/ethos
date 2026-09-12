/** A runtime the `/model` switch can retire — `CreateAgentLoopResult`'s pair. */
export interface RetirableRuntime {
  /** Resolve once no background job or goal run is still running on it. */
  drain(): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * F06 — the `/model` switch's side of loop replacement: build the new runtime
 * and pair its loop with the retirement of the runtime it REPLACES, which the
 * TUI runs once the foreground turn still on the old loop has finished
 * (apps/tui/src/loop-switch.ts). Retiring drains first — the old loop's
 * background jobs and goal runs finish where they started instead of being
 * aborted by the dispose (a CLI-origin job is never announced, so an abort
 * would lose it silently) — then disposes. Tracks the current runtime so each
 * switch retires exactly the one before it; a rebuild that throws leaves the
 * current runtime current (`createAgentLoop` has already rolled its own half
 * back). Pinned by apps/ethos/src/lib/__tests__/loop-rebuilder.test.ts.
 */
export function createLoopRebuilder<TRuntime extends RetirableRuntime & { loop: unknown }>(
  initial: RetirableRuntime,
  build: (modelId: string) => Promise<TRuntime>,
): (modelId: string) => Promise<{
  loop: TRuntime['loop'];
  /** The whole new runtime — for the host's own rebinding (plugin slash commands). */
  runtime: TRuntime;
  retirePrevious: () => Promise<void>;
}> {
  let current: RetirableRuntime = initial;
  return async (modelId) => {
    const next = await build(modelId);
    const previous = current;
    current = next;
    return {
      loop: next.loop,
      runtime: next,
      retirePrevious: async () => {
        await previous.drain();
        await previous.dispose();
      },
    };
  };
}
