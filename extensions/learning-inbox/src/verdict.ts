// The promotion rule (plan `trust-before-reach.md` Part 4, Design section 5,
// L-T4).
//
// Pure: a verdict is a function of the per-case scores and whether the run
// stayed within budget, nothing else. `replay.ts` produces the input; this
// module is the one owner of what the input means. Pinned table-driven by
// `__tests__/verdict.test.ts`.

import type { CandidateVerdict } from './store';

/** Fewest cases a run can pass with; 3 is the smallest set where rule (d) means anything (L-D6). */
export const MIN_REPLAY_CASES = 3;
/** Most cases replayed per candidate (L-D6). */
export const MAX_REPLAY_CASES = 8;
/** Most of those that may be target cases; the rest are regression cases (L-D6). */
export const MAX_TARGET_CASES = 3;

/**
 * Tolerance for the mean-Δ comparisons. Scores are fractions (2/3, 1/4), and a
 * mean of their differences can land a float-rounding hair above zero — which
 * rule (c) would otherwise read as an improvement nobody measured.
 */
const EPSILON = 1e-9;

/** A target case is one the candidate should improve; a regression case one it must not break. */
export type CaseRole = 'target' | 'regression';

/** One arm of one case, as the verdict needs it. */
export interface ArmOutcome {
  /** Assertions passed ÷ total, the implicit `completed` check included. In [0, 1]. */
  score: number;
  /** No `error` event and no `halt`. */
  completed: boolean;
}

export interface VerdictCase {
  caseId: string;
  role: CaseRole;
  /** `null` when the arm did not run (budget stop, a thrown case, never reached). */
  baseline: ArmOutcome | null;
  candidate: ArmOutcome | null;
}

export interface VerdictInput {
  /** Every case SELECTED for the run, ran or not. */
  cases: readonly VerdictCase[];
  /** False once the summed replay-loop cost exceeded `maxCostUsd` (L-D7). */
  withinBudget: boolean;
}

export interface VerdictRules {
  /**
   * At least 3 cases, at least 1 target AND at least 1 regression case, every
   * case ran in both arms, within budget.
   */
  a: boolean;
  /** No case where the candidate failed `completed` and the baseline passed it. */
  b: boolean;
  /** Mean Δ over target cases > 0. */
  c: boolean;
  /** Mean Δ over regression cases ≥ 0, with at most one regression case below 0. */
  d: boolean;
}

export interface VerdictResult {
  verdict: CandidateVerdict;
  rules: VerdictRules;
  /** Mean candidate − baseline over target cases that ran both arms; null when none did. */
  targetMeanDelta: number | null;
  /** The same over regression cases; null when none did. */
  regressionMeanDelta: number | null;
  /** Regression cases with Δ < 0. */
  regressionsWorse: number;
  /** Regression cases that ran both arms. */
  regressionCount: number;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * `pass` iff rules (a)–(d) all hold. If (a) fails the run could not be scored
 * and the verdict is `incomplete`; otherwise any failed rule is `regress`.
 *
 * Rule (a) requires at least one REGRESSION case, not only a target. Rule (d)
 * is the harm check — "did this make anything worse" — and over zero regression
 * cases it holds vacuously: a run of 3 target cases would pass (d) having
 * measured nothing but the improvement, and could be auto-promoted with no
 * evidence either way about what it broke. So a run without a regression case
 * is `incomplete`, and the gate fails closed. `selectReplayCases` keeps one slot
 * for a regression case so a full set of targets cannot crowd it out; the
 * `verdict.test.ts` "all-target" row pins this rule.
 */
export function computeVerdict(input: VerdictInput): VerdictResult {
  const { cases } = input;
  const ran = cases.filter(
    (c): c is VerdictCase & { baseline: ArmOutcome; candidate: ArmOutcome } =>
      c.baseline !== null && c.candidate !== null,
  );

  const a =
    input.withinBudget &&
    cases.length >= MIN_REPLAY_CASES &&
    cases.some((c) => c.role === 'target') &&
    cases.some((c) => c.role === 'regression') &&
    ran.length === cases.length;

  const b = !ran.some((c) => c.baseline.completed && !c.candidate.completed);

  const delta = (c: (typeof ran)[number]) => c.candidate.score - c.baseline.score;
  const targetDeltas = ran.filter((c) => c.role === 'target').map(delta);
  const regressionDeltas = ran.filter((c) => c.role === 'regression').map(delta);

  const targetMeanDelta = mean(targetDeltas);
  const regressionMeanDelta = mean(regressionDeltas);
  const regressionsWorse = regressionDeltas.filter((d) => d < -EPSILON).length;

  const c = targetMeanDelta !== null && targetMeanDelta > EPSILON;
  const d = (regressionMeanDelta ?? 0) >= -EPSILON && regressionsWorse <= 1;

  const verdict: CandidateVerdict = !a ? 'incomplete' : b && c && d ? 'pass' : 'regress';
  return {
    verdict,
    rules: { a, b, c, d },
    targetMeanDelta,
    regressionMeanDelta,
    regressionsWorse,
    regressionCount: regressionDeltas.length,
  };
}
