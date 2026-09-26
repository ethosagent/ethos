// ---------------------------------------------------------------------------
// Backoff schedule (D11 of plan/phases/otlp-export.md). Per exporter, not
// per trace — an outage is a collector property. The poller owns the attempt
// counter and reset-on-2xx; this function is pure given an injected RNG.
// ---------------------------------------------------------------------------

export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 300_000;

/**
 * Full-jitter exponential backoff: uniform over `[0, min(cap, base·2^n))`,
 * with `Retry-After` honored when it asks for MORE than the jittered delay
 * (a collector's explicit ask is a floor, never a reason to hammer sooner).
 *
 * `rng` returns a float in `[0, 1)`; injectable so tests can seed it.
 */
export function nextDelay(
  attempt: number,
  retryAfterMs?: number,
  rng: () => number = Math.random,
): number {
  const exponent = Math.max(0, Math.floor(attempt));
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** exponent);
  const jittered = Math.floor(rng() * ceiling);
  if (retryAfterMs !== undefined && retryAfterMs > jittered) return retryAfterMs;
  return jittered;
}
