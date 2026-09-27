import { z } from 'zod';
import { m2eBarForTier, PHONE_VOICE_BAR, type VoiceTier } from '../bar';
import type { CallTraceEvent } from './call-trace';

// Grades a call trace (JSONL from `createCallTrace().toJsonl()`) against
// `PHONE_VOICE_BAR`. Pure: text in, report out.
//
// Definitions:
//
// - Mouth-to-ear, per turn: the latest `local_end` before the agent's next
//   utterance → that utterance's first `sched` start, mapped onto the monotonic
//   clock (`t + (startAt - ctxNow) * 1000`), plus half the last `calib`
//   round trip (the output-path latency the scheduled start does not include).
//   "Next utterance" is the first `sched` whose `utteranceId` has not been
//   scheduled before. A `local_end` followed by another `local_end` before any
//   reply collapses to the later one — the user was still talking.
// - Barge-in: a `local_onset` while agent audio is scheduled (a `sched` whose
//   mapped end is still ahead and no `stop` since) opens a trial; the next
//   `stop` closes it. Latency = stop − onset; a trial with no `stop` by the end
//   of the trace fails. PASS needs at least `bargeN` trials and a pass ratio of
//   at least `bargePass / bargeN`.
// - Gaps: `underrun` events longer than `gapMs`, divided by the minutes of
//   scheduled agent speech (the sum of `sched.dur`).
// - Percentiles use the NEAREST-RANK method: the p-th percentile of n sorted
//   samples is the value at 1-based rank ceil(p/100 · n). The median is p50 by
//   the same rule, so every reported number is a sample that actually occurred.

const header = z.object({
  ev: z.literal('header'),
  v: z.literal(1),
  tier: z.enum(['realtime', 'pipeline']),
  label: z.string().optional(),
});
const timed = <T extends z.ZodRawShape>(shape: T) => z.object({ t: z.number(), ...shape });

const EventSchema = z.discriminatedUnion('ev', [
  header,
  timed({ ev: z.literal('mic_frame'), rms: z.number(), n: z.number() }),
  timed({ ev: z.literal('local_onset') }),
  timed({ ev: z.literal('local_end') }),
  timed({ ev: z.literal('tx_audio'), seq: z.number() }),
  timed({
    ev: z.literal('rx'),
    frame: z.string(),
    utteranceId: z.string().optional(),
    segmentId: z.string().optional(),
    seq: z.number().optional(),
  }),
  timed({
    ev: z.literal('sched'),
    ctxNow: z.number(),
    startAt: z.number(),
    dur: z.number(),
    utteranceId: z.string(),
  }),
  timed({ ev: z.literal('underrun'), gapMs: z.number() }),
  timed({ ev: z.literal('stop'), reason: z.string() }),
  timed({
    ev: z.literal('link'),
    status: z.enum(['connecting', 'open', 'reconnecting', 'closed']),
  }),
  timed({ ev: z.literal('interruption'), phase: z.enum(['began', 'ended']) }),
  timed({ ev: z.literal('engine_error'), code: z.string(), message: z.string() }),
  z.object({ ev: z.literal('calib'), roundTripMs: z.number() }),
]);

export interface ParsedTrace {
  tier: VoiceTier | null;
  events: CallTraceEvent[];
  /** Non-blank lines that were not valid JSON or not a known event. */
  malformed: number;
}

export function parseTrace(jsonl: string): ParsedTrace {
  const events: CallTraceEvent[] = [];
  let tier: VoiceTier | null = null;
  let malformed = 0;
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      malformed++;
      continue;
    }
    const parsed = EventSchema.safeParse(raw);
    if (!parsed.success) {
      malformed++;
      continue;
    }
    const event: CallTraceEvent = parsed.data;
    if (event.ev === 'header') tier = tier ?? event.tier;
    events.push(event);
  }
  return { tier, events, malformed };
}

/** Nearest-rank percentile (see the module comment). `NaN` for no samples. */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return Number.NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? Number.NaN;
}

export type CriterionId = 'm2e_median' | 'm2e_p95' | 'barge' | 'gaps';

export interface Criterion {
  id: CriterionId;
  /** Human-readable measured value. */
  value: string;
  /** Human-readable limit. */
  limit: string;
  pass: boolean;
}

export interface TraceReport {
  tier: VoiceTier;
  m2e: { samplesMs: number[]; medianMs: number; p95Ms: number; calibOffsetMs: number };
  barge: { trials: number; passes: number; latenciesMs: Array<number | null> };
  gaps: { count: number; speechMinutes: number; perMin: number };
  malformed: number;
  criteria: Criterion[];
  pass: boolean;
}

const schedStartMs = (e: { t: number; ctxNow: number; startAt: number }): number =>
  e.t + (e.startAt - e.ctxNow) * 1000;

export function analyzeTrace(jsonl: string, opts: { tier?: VoiceTier } = {}): TraceReport {
  const parsed = parseTrace(jsonl);
  const tier = opts.tier ?? parsed.tier ?? 'realtime';
  const bar = PHONE_VOICE_BAR;
  const events = parsed.events;

  let calibOffsetMs = 0;
  for (const e of events) if (e.ev === 'calib') calibOffsetMs = e.roundTripMs / 2;

  // Mouth-to-ear.
  const m2eSamples: number[] = [];
  const seenUtterances = new Set<string>();
  let pendingEnd: number | null = null;
  // Barge-in.
  const bargeLatencies: Array<number | null> = [];
  let scheduledUntil = Number.NEGATIVE_INFINITY;
  let bargeOnset: number | null = null;
  // Gaps.
  let gapCount = 0;
  let speechSeconds = 0;

  for (const e of events) {
    switch (e.ev) {
      case 'local_end':
        pendingEnd = e.t;
        break;
      case 'local_onset':
        if (bargeOnset === null && e.t < scheduledUntil) bargeOnset = e.t;
        break;
      case 'sched': {
        const start = schedStartMs(e);
        scheduledUntil = Math.max(scheduledUntil, start + e.dur * 1000);
        speechSeconds += e.dur;
        if (!seenUtterances.has(e.utteranceId)) {
          seenUtterances.add(e.utteranceId);
          if (pendingEnd !== null) {
            m2eSamples.push(start - pendingEnd + calibOffsetMs);
            pendingEnd = null;
          }
        }
        break;
      }
      case 'stop':
        if (bargeOnset !== null) {
          bargeLatencies.push(e.t - bargeOnset);
          bargeOnset = null;
        }
        scheduledUntil = Number.NEGATIVE_INFINITY;
        break;
      case 'underrun':
        if (e.gapMs > bar.gapMs) gapCount++;
        break;
      default:
        break;
    }
  }
  if (bargeOnset !== null) bargeLatencies.push(null);

  const medianMs = percentile(m2eSamples, 50);
  const p95Ms = percentile(m2eSamples, 95);
  const m2eBar = m2eBarForTier(tier);
  const trials = bargeLatencies.length;
  const passes = bargeLatencies.filter((ms) => ms !== null && ms <= bar.bargeMs).length;
  const speechMinutes = speechSeconds / 60;
  const perMin =
    speechMinutes > 0 ? gapCount / speechMinutes : gapCount > 0 ? Number.POSITIVE_INFINITY : 0;

  const criteria: Criterion[] = [
    {
      id: 'm2e_median',
      value: fmtMs(medianMs),
      limit: `≤ ${m2eBar.medianMs} ms`,
      pass: medianMs <= m2eBar.medianMs,
    },
    {
      id: 'm2e_p95',
      value: fmtMs(p95Ms),
      limit: `≤ ${m2eBar.p95Ms} ms`,
      pass: p95Ms <= m2eBar.p95Ms,
    },
    {
      id: 'barge',
      value: `${passes}/${trials} ≤ ${bar.bargeMs} ms`,
      limit: `≥ ${bar.bargePass}/${bar.bargeN}`,
      pass: trials >= bar.bargeN && passes * bar.bargeN >= bar.bargePass * trials,
    },
    {
      id: 'gaps',
      value: `${perMin.toFixed(2)}/min (${gapCount} > ${bar.gapMs} ms)`,
      limit: `≤ ${bar.gapsPerMin}/min`,
      pass: perMin <= bar.gapsPerMin,
    },
  ];

  return {
    tier,
    m2e: { samplesMs: m2eSamples, medianMs, p95Ms, calibOffsetMs },
    barge: { trials, passes, latenciesMs: bargeLatencies },
    gaps: { count: gapCount, speechMinutes, perMin },
    malformed: parsed.malformed,
    criteria,
    pass: criteria.every((c) => c.pass),
  };
}

function fmtMs(ms: number): string {
  return Number.isNaN(ms) ? 'no samples' : `${Math.round(ms)} ms`;
}

/** Plain-text rendering of a report, for the CLI. */
export function formatTraceReport(report: TraceReport): string {
  const lines = [
    `tier: ${report.tier}`,
    `turns: ${report.m2e.samplesMs.length} (calibration offset ${report.m2e.calibOffsetMs} ms)`,
  ];
  for (const c of report.criteria) {
    lines.push(`${c.pass ? 'PASS' : 'FAIL'}  ${c.id.padEnd(10)} ${c.value}  (bar ${c.limit})`);
  }
  if (report.malformed > 0) lines.push(`skipped ${report.malformed} malformed line(s)`);
  lines.push(report.pass ? 'RESULT: PASS' : 'RESULT: FAIL');
  return lines.join('\n');
}
