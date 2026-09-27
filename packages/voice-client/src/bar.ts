// The phone voice pass/fail bar (mobile-app Phase 3, T7). Written BEFORE any
// engine code so the engine is graded against a number nobody picked after
// seeing the results.

/** Which voice tier a call ran on. Picks the mouth-to-ear bar. */
export type VoiceTier = 'realtime' | 'pipeline';

/**
 * The phone voice bar.
 *
 * - `m2eMedianMs` / `m2eP95Ms` — mouth-to-ear (the user stops talking → the
 *   agent's first audio reaches the speaker). This bar is graded on the
 *   REALTIME tier. It equals the repo's own realtime budget
 *   (`VOICE_REALTIME_LATENCY_BUDGET_MS.pipeline` in
 *   `extensions/voice-session/src/latency-budget.ts`, pinned by
 *   `__tests__/bar.test.ts`).
 * - The PIPELINE tier is graded against the repo's own pipeline budget instead
 *   — see {@link PIPELINE_M2E_BUDGET_MS} and {@link m2eBarForTier}.
 * - `bargeMs` / `bargePass` / `bargeN` — barge-in: the user starts talking over
 *   the agent → its playout stops, within `bargeMs`, in at least `bargePass`
 *   of `bargeN` trials.
 * - `gapMs` / `gapsPerMin` — playout underruns longer than `gapMs`, at most
 *   `gapsPerMin` per minute of scheduled agent speech.
 *
 * Every number is measured under {@link LTE_LOSSY_PROFILE}: 150 ms RTT, 3 %
 * packet loss, 100 ms jitter. A result measured on a clean link does not
 * count against this bar.
 */
export const PHONE_VOICE_BAR = {
  m2eMedianMs: 800,
  m2eP95Ms: 1500,
  bargeMs: 200,
  bargePass: 19,
  bargeN: 20,
  gapMs: 80,
  gapsPerMin: 1,
} as const;

export type PhoneVoiceBar = typeof PHONE_VOICE_BAR;

/** The "LTE, lossy" network profile every bar measurement is taken under. */
export const LTE_LOSSY_PROFILE = { rttMs: 150, lossPct: 3, jitterMs: 100 } as const;

/**
 * The pipeline tier's mouth-to-ear budget, restated from
 * `VOICE_LATENCY_BUDGET_MS.pipeline` in
 * `extensions/voice-session/src/latency-budget.ts`. Restated, not imported:
 * this package sits in the `support` layer, which may not import an
 * extension (archcheck `support-packages`). `__tests__/bar.test.ts` pins the
 * two equal, so the copy cannot drift silently.
 */
export const PIPELINE_M2E_BUDGET_MS = 1_600;

/**
 * The mouth-to-ear median/p95 limits a trace is graded against.
 *
 * Realtime: {@link PHONE_VOICE_BAR} as written. Pipeline: the median is the
 * repo's pipeline budget, and the p95 keeps the realtime bar's ABSOLUTE
 * headroom over its median (700 ms). The tail between median and p95 is what
 * the lossy link adds — jitter, loss, retransmit — and that is the same link
 * on both tiers, so the allowance does not scale with the tier's median.
 */
export function m2eBarForTier(tier: VoiceTier): { medianMs: number; p95Ms: number } {
  if (tier === 'realtime') {
    return { medianMs: PHONE_VOICE_BAR.m2eMedianMs, p95Ms: PHONE_VOICE_BAR.m2eP95Ms };
  }
  const headroom = PHONE_VOICE_BAR.m2eP95Ms - PHONE_VOICE_BAR.m2eMedianMs;
  return { medianMs: PIPELINE_M2E_BUDGET_MS, p95Ms: PIPELINE_M2E_BUDGET_MS + headroom };
}
