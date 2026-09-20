// D13 — never trust the stream alone; rehydrate before you reconnect.
//
// Every stream is closed on AppState `background` (iOS suspends the app and its
// sockets die, R6d). On `active`:
//   • backgrounded < FOREGROUND_REHYDRATE_MS → reopen the streams, resuming
//     after the last seq; the server's replay buffer covers the gap.
//   • backgrounded ≥ FOREGROUND_REHYDRATE_MS, or a resumed stream reported a
//     `gap` (the buffer's 1000 frames were spent) → read the newest history
//     page and apply it FIRST, then open the streams, then catch up on what
//     the stream cannot replay (tools.listPending, clarify.listPending,
//     tasks.list). Await-then-connect: the reducer's hydrate replaces messages,
//     so a replayed turn landing before it would be clobbered.
// Pinned by src/api/__tests__/foreground.test.ts (cases 1, 12, 20).

/** Well under the session buffer's 5-minute reap (SessionStreamBuffer). */
export const FOREGROUND_REHYDRATE_MS = 60_000;

export interface ForegroundDeps {
  now(): number;
  suspend(): void;
  resume(fresh: boolean): void;
  /** `sessions.messages` newest page → `history-loaded` / `history-newest-merged`. */
  rehydrate(): Promise<void>;
  /** `tools.listPending` → `clarify.listPending` → `tasks.list`. Best-effort:
   *  it must not reject (a failed read leaves the last state on screen). */
  catchUp(): Promise<void>;
}

export type AppStateName = 'active' | 'background' | 'inactive' | 'unknown' | 'extension';

export function createForegroundPolicy(deps: ForegroundDeps) {
  let backgroundedAt: number | null = null;

  const rehydrateThenConnect = async (): Promise<void> => {
    deps.suspend();
    try {
      await deps.rehydrate();
    } finally {
      // Offline now is not offline forever: the streams retry on their own.
      deps.resume(true);
    }
    await deps.catchUp();
  };

  return {
    async onAppState(state: AppStateName): Promise<void> {
      if (state === 'background') {
        backgroundedAt ??= deps.now();
        deps.suspend();
        return;
      }
      if (state !== 'active' || backgroundedAt === null) return;
      const away = deps.now() - backgroundedAt;
      backgroundedAt = null;
      if (away < FOREGROUND_REHYDRATE_MS) deps.resume(false);
      else await rehydrateThenConnect();
    },
    /** A resumed stream said its replay was truncated. */
    onGap: rehydrateThenConnect,
  };
}
