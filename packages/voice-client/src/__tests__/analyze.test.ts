import { describe, expect, it } from 'vitest';
import { analyzeTrace, formatTraceReport, parseTrace, percentile } from '../trace/analyze';
import { type CallTrace, createCallTrace } from '../trace/call-trace';

// Synthetic traces: a fake monotonic clock and no audio clock, so a `sched`
// startAt is monotonic seconds and every latency below is exact.
function harness(tier: 'realtime' | 'pipeline' = 'realtime') {
  let now = 0;
  const trace = createCallTrace({ tier, clock: { now: () => now } });
  return {
    trace,
    at(t: number, fn: (trace: CallTrace) => void): void {
      now = t;
      fn(trace);
    },
  };
}

interface Plan {
  m2e?: number[];
  barge?: number[];
  underruns?: number[];
  calib?: number;
  tier?: 'realtime' | 'pipeline';
}

function build(plan: Plan): string {
  const h = harness(plan.tier);
  if (plan.calib !== undefined) h.trace.calib(plan.calib);
  let base = 0;
  (plan.m2e ?? []).forEach((ms, i) => {
    h.at(base, (t) => t.localEnd());
    h.at(base + 10, (t) => t.sched((base + ms) / 1000, 2, `u${i}`));
    h.at(base + 3000, (t) => t.stop('drained'));
    base += 10_000;
  });
  (plan.barge ?? []).forEach((ms, i) => {
    h.at(base, (t) => t.sched(base / 1000, 3, `b${i}`));
    h.at(base + 500, (t) => t.localOnset());
    h.at(base + 500 + ms, (t) => t.stop('barge'));
    base += 10_000;
  });
  for (const gap of plan.underruns ?? []) h.at(base++, (t) => t.underrun(gap));
  return h.trace.toJsonl();
}

const PASSING_BARGE = Array.from({ length: 20 }, () => 150);
const flat = (n: number, ms: number) => Array.from({ length: n }, () => ms);

describe('percentile (nearest rank)', () => {
  it('returns a sample that occurred', () => {
    const xs = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(xs, 50)).toBe(10);
    expect(percentile(xs, 95)).toBe(19);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNaN();
  });
});

describe('analyzeTrace', () => {
  it('passes a run inside every bar', () => {
    const report = analyzeTrace(build({ m2e: flat(20, 600), barge: PASSING_BARGE }));
    expect(report.m2e.samplesMs).toHaveLength(20);
    expect(report.m2e.medianMs).toBe(600);
    expect(report.criteria.map((c) => [c.id, c.pass])).toEqual([
      ['m2e_median', true],
      ['m2e_p95', true],
      ['barge', true],
      ['gaps', true],
    ]);
    expect(report.pass).toBe(true);
    expect(formatTraceReport(report)).toContain('RESULT: PASS');
  });

  it('fails the median', () => {
    const report = analyzeTrace(build({ m2e: flat(20, 900), barge: PASSING_BARGE }));
    const byId = Object.fromEntries(report.criteria.map((c) => [c.id, c.pass]));
    expect(byId).toMatchObject({ m2e_median: false, m2e_p95: true });
    expect(report.pass).toBe(false);
  });

  it('fails the p95 on a tail the median does not see', () => {
    const m2e = [...flat(18, 600), 1600, 1700];
    const report = analyzeTrace(build({ m2e, barge: PASSING_BARGE }));
    expect(report.m2e.medianMs).toBe(600);
    expect(report.m2e.p95Ms).toBe(1600);
    const byId = Object.fromEntries(report.criteria.map((c) => [c.id, c.pass]));
    expect(byId).toMatchObject({ m2e_median: true, m2e_p95: false });
  });

  it('grades the pipeline tier against the pipeline budget', () => {
    const report = analyzeTrace(
      build({ tier: 'pipeline', m2e: flat(20, 1200), barge: PASSING_BARGE }),
    );
    expect(report.tier).toBe('pipeline');
    expect(report.pass).toBe(true);
  });

  it('passes barge-in at 19/20 and fails at 18/20', () => {
    const at19 = analyzeTrace(build({ m2e: [600], barge: [...flat(19, 150), 250] }));
    expect(at19.barge).toMatchObject({ trials: 20, passes: 19 });
    expect(at19.criteria.find((c) => c.id === 'barge')?.pass).toBe(true);

    const at18 = analyzeTrace(build({ m2e: [600], barge: [...flat(18, 150), 250, 300] }));
    expect(at18.barge).toMatchObject({ trials: 20, passes: 18 });
    expect(at18.criteria.find((c) => c.id === 'barge')?.pass).toBe(false);
  });

  it('fails barge-in with too few trials, and counts an unanswered onset as a failure', () => {
    const few = analyzeTrace(build({ m2e: [600], barge: flat(5, 100) }));
    expect(few.criteria.find((c) => c.id === 'barge')?.pass).toBe(false);

    const h = harness();
    h.at(0, (t) => t.sched(0, 3, 'x'));
    h.at(100, (t) => t.localOnset());
    expect(analyzeTrace(h.trace.toJsonl()).barge.latenciesMs).toEqual([null]);
  });

  it('ignores an onset while nothing is scheduled', () => {
    const h = harness();
    h.at(0, (t) => t.sched(0, 1, 'x'));
    h.at(5000, (t) => t.localOnset());
    h.at(5100, (t) => t.stop('manual'));
    expect(analyzeTrace(h.trace.toJsonl()).barge.trials).toBe(0);
  });

  it('counts only underruns longer than gapMs, per minute of scheduled speech', () => {
    // 60 turns × 2 s of speech = 2 minutes.
    const ok = analyzeTrace(build({ m2e: flat(60, 600), underruns: [120, 81, 80, 10] }));
    expect(ok.gaps).toMatchObject({ count: 2, speechMinutes: 2, perMin: 1 });
    expect(ok.criteria.find((c) => c.id === 'gaps')?.pass).toBe(true);

    const bad = analyzeTrace(build({ m2e: flat(60, 600), underruns: [120, 81, 90] }));
    expect(bad.gaps.perMin).toBe(1.5);
    expect(bad.criteria.find((c) => c.id === 'gaps')?.pass).toBe(false);
  });

  it('adds half the calibration round trip to every turn', () => {
    const report = analyzeTrace(build({ m2e: flat(20, 700), barge: PASSING_BARGE, calib: 300 }));
    expect(report.m2e.calibOffsetMs).toBe(150);
    expect(report.m2e.medianMs).toBe(850);
    expect(report.criteria.find((c) => c.id === 'm2e_median')?.pass).toBe(false);
  });

  it('maps an audio-clock start onto the monotonic clock', () => {
    const lines = [
      { ev: 'header', v: 1, tier: 'realtime' },
      { ev: 'local_end', t: 1000 },
      // Scheduled at t=1200 when the audio clock read 50 s, to start at 50.4 s.
      { ev: 'sched', t: 1200, ctxNow: 50, startAt: 50.4, dur: 1, utteranceId: 'u' },
    ];
    const report = analyzeTrace(lines.map((l) => JSON.stringify(l)).join('\n'));
    expect(report.m2e.samplesMs[0]).toBeCloseTo(600, 6);
  });

  it('measures from the latest local_end and only on a new utterance', () => {
    const h = harness();
    h.at(0, (t) => t.localEnd());
    h.at(400, (t) => t.localEnd());
    h.at(500, (t) => t.sched(1.0, 1, 'u'));
    h.at(700, (t) => t.sched(2.0, 1, 'u'));
    expect(analyzeTrace(h.trace.toJsonl()).m2e.samplesMs).toEqual([600]);
  });

  it('skips malformed lines and counts them', () => {
    const jsonl = [
      JSON.stringify({ ev: 'header', v: 1, tier: 'realtime' }),
      '{not json',
      JSON.stringify({ ev: 'local_end' }),
      JSON.stringify({ ev: 'mystery', t: 1 }),
      '',
      JSON.stringify({ ev: 'local_end', t: 0 }),
      JSON.stringify({ ev: 'sched', t: 0, ctxNow: 0, startAt: 0.5, dur: 1, utteranceId: 'u' }),
    ].join('\n');
    const parsed = parseTrace(jsonl);
    expect(parsed.malformed).toBe(3);
    expect(parsed.tier).toBe('realtime');
    const report = analyzeTrace(jsonl);
    expect(report.malformed).toBe(3);
    expect(report.m2e.samplesMs).toEqual([500]);
    expect(formatTraceReport(report)).toContain('skipped 3 malformed');
  });
});
