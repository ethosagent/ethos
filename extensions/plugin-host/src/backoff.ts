/** Restart schedule and circuit-breaker constants (plan §5.4.2, D15). */
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 60_000;
export const BACKOFF_JITTER = 0.2;
export const CIRCUIT_CRASH_LIMIT = 5;
export const CIRCUIT_WINDOW_MS = 10 * 60_000;
export const CIRCUIT_OPEN_MS = 30 * 60_000;
/** A host that ran this long before crashing starts the backoff over. */
export const HEALTHY_UPTIME_MS = 60_000;

/**
 * Delay before restart number `consecutive` (1-based): 1 s, 2 s, 4 s ... capped
 * at 60 s, then +/-20% jitter. `random` is injected so tests pin the bounds.
 */
export function backoffDelay(consecutive: number, random: () => number): number {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, consecutive - 1), BACKOFF_CAP_MS);
  const jitter = (random() * 2 - 1) * BACKOFF_JITTER;
  return Math.round(base * (1 + jitter));
}

/** Crash timestamps still inside the circuit window. */
export function recentCrashes(crashes: number[], now: number): number[] {
  return crashes.filter((t) => now - t < CIRCUIT_WINDOW_MS);
}
