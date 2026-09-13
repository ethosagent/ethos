// L-T4 — the promotion rule (Design section 5), table-driven over rules (a)–(d).

import { describe, expect, it } from 'vitest';
import type { CandidateVerdict } from '../store';
import {
  type ArmOutcome,
  type CaseRole,
  computeVerdict,
  type VerdictCase,
  type VerdictRules,
} from '../verdict';

const ok = (score: number): ArmOutcome => ({ score, completed: true });
const failed = (score: number): ArmOutcome => ({ score, completed: false });

let seq = 0;
function kase(role: CaseRole, baseline: ArmOutcome | null, candidate: ArmOutcome | null) {
  seq += 1;
  return { caseId: `case-${seq}`, role, baseline, candidate } satisfies VerdictCase;
}
const target = (b: number, c: number) => kase('target', ok(b), ok(c));
const regression = (b: number, c: number) => kase('regression', ok(b), ok(c));

interface Row {
  name: string;
  cases: VerdictCase[];
  withinBudget?: boolean;
  verdict: CandidateVerdict;
  rules: Partial<VerdictRules>;
}

const rows: Row[] = [
  // --- pass ---------------------------------------------------------------
  {
    name: 'exactly 3 cases, 1 target improved, regressions flat → pass',
    cases: [target(0.5, 1), regression(1, 1), regression(0.5, 0.5)],
    verdict: 'pass',
    rules: { a: true, b: true, c: true, d: true },
  },
  {
    name: 'exactly one regression case with Δ<0, mean still ≥ 0 → pass',
    cases: [target(0, 1), regression(1, 0.5), regression(0.5, 1), regression(1, 1)],
    verdict: 'pass',
    rules: { d: true },
  },

  // --- (a) → incomplete --------------------------------------------------
  {
    name: '(a) 2 cases → incomplete',
    cases: [target(0, 1), regression(1, 1)],
    verdict: 'incomplete',
    rules: { a: false },
  },
  {
    name: '(a) zero target cases → incomplete',
    cases: [regression(0, 1), regression(1, 1), regression(1, 1)],
    verdict: 'incomplete',
    rules: { a: false },
  },
  {
    name: '(a) all target cases, zero regression cases → incomplete, not a vacuous (d) pass',
    cases: [target(0, 1), target(0, 1), target(0.5, 1)],
    verdict: 'incomplete',
    rules: { a: false, b: true, c: true, d: true },
  },
  {
    name: '(a) all target cases, even with more than the minimum → incomplete',
    cases: [target(0, 1), target(0, 1), target(0, 1), target(0, 1)],
    verdict: 'incomplete',
    rules: { a: false },
  },
  {
    name: '(a) one regression case present → rules evaluate normally (pass)',
    cases: [target(0, 1), target(0, 1), regression(1, 1)],
    verdict: 'pass',
    rules: { a: true, b: true, c: true, d: true },
  },
  {
    name: '(a) one regression case present → rules evaluate normally (its Δ<0 drags (d) → regress)',
    cases: [target(0, 1), target(0, 1), regression(1, 0.5)],
    verdict: 'regress',
    rules: { a: true, d: false },
  },
  {
    name: '(a) a case missing its candidate arm → incomplete',
    cases: [target(0, 1), regression(1, 1), kase('regression', ok(1), null)],
    verdict: 'incomplete',
    rules: { a: false },
  },
  {
    name: '(a) a case missing its baseline arm → incomplete',
    cases: [target(0, 1), regression(1, 1), kase('regression', null, ok(1))],
    verdict: 'incomplete',
    rules: { a: false },
  },
  {
    name: '(a) over budget, every other rule passing → incomplete',
    cases: [target(0, 1), regression(1, 1), regression(1, 1)],
    withinBudget: false,
    verdict: 'incomplete',
    rules: { a: false, b: true, c: true, d: true },
  },

  // --- (b) → regress -----------------------------------------------------
  {
    name: '(b) candidate fails completed where baseline passed → regress',
    cases: [target(0, 1), kase('regression', ok(1), failed(1)), regression(1, 1)],
    verdict: 'regress',
    rules: { a: true, b: false, c: true, d: true },
  },
  {
    name: '(b) both arms failing completed is not a regression of (b)',
    cases: [target(0, 1), kase('regression', failed(0.5), failed(0.5)), regression(1, 1)],
    verdict: 'pass',
    rules: { b: true },
  },

  // --- (c) → regress -----------------------------------------------------
  {
    name: '(c) target mean Δ exactly 0 → regress',
    cases: [target(0.5, 0.5), regression(1, 1), regression(1, 1)],
    verdict: 'regress',
    rules: { a: true, b: true, c: false, d: true },
  },
  {
    name: '(c) target mean Δ 0 from +/− deltas that cancel → regress',
    cases: [target(1 / 3, 2 / 3), target(2 / 3, 1 / 3), regression(1, 1)],
    verdict: 'regress',
    rules: { c: false },
  },
  {
    name: '(c) target mean Δ negative → regress',
    cases: [target(1, 0.5), regression(1, 1), regression(1, 1)],
    verdict: 'regress',
    rules: { c: false },
  },

  // --- (d) → regress -----------------------------------------------------
  {
    name: '(d) two regression cases with Δ<0 → regress, even with mean ≥ 0',
    cases: [
      target(0, 1),
      regression(1, 0.75),
      regression(1, 0.75),
      regression(0, 1),
      regression(1, 1),
    ],
    verdict: 'regress',
    rules: { a: true, b: true, c: true, d: false },
  },
  {
    name: '(d) one regression case with Δ<0 dragging the mean below 0 → regress',
    cases: [target(0, 1), regression(1, 0), regression(1, 1)],
    verdict: 'regress',
    rules: { d: false },
  },
];

describe('computeVerdict — rules (a)–(d)', () => {
  it.each(rows)('$name', (row) => {
    const result = computeVerdict({ cases: row.cases, withinBudget: row.withinBudget ?? true });
    expect(result.verdict).toBe(row.verdict);
    expect(result.rules).toMatchObject(row.rules);
  });

  it('reports the deltas the scorecard header prints', () => {
    const result = computeVerdict({
      cases: [target(0.25, 0.75), regression(1, 0.5), regression(0.5, 1), regression(1, 1)],
      withinBudget: true,
    });
    expect(result.targetMeanDelta).toBeCloseTo(0.5);
    expect(result.regressionMeanDelta).toBeCloseTo(0);
    expect(result.regressionsWorse).toBe(1);
    expect(result.regressionCount).toBe(3);
  });
});
