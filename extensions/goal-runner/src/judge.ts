import type { AcceptanceSpec, CriterionResult, Verdict } from '@ethosagent/types';

export interface JudgeInput {
  output: string;
  spec: AcceptanceSpec;
}

/**
 * Run mechanical checks and score rubric items.
 * Phase 1: checks run deterministically; rubric items get placeholder scores.
 * The eval-harness integration (plan phase 2) replaces the rubric scoring.
 */
export async function judge(input: JudgeInput): Promise<Verdict> {
  const results: CriterionResult[] = [];

  for (const check of input.spec.checks) {
    const pass = input.output.toLowerCase().includes(check.description.toLowerCase());
    results.push({
      id: check.id,
      pass,
      evidence: pass ? `check passed: ${check.description}` : `check failed: ${check.description}`,
      gap: pass ? undefined : check.description,
    });
  }

  for (const rubric of input.spec.rubric) {
    const score = input.output.length > 0 ? 0.5 : 0;
    results.push({
      id: rubric.id,
      score,
      evidence: `rubric placeholder score: ${score}`,
      gap: score < input.spec.threshold ? rubric.description : undefined,
    });
  }

  const totalWeight = input.spec.rubric.reduce((sum, r) => sum + r.weight, 0);
  const weightedSum = input.spec.rubric.reduce((sum, r) => {
    const result = results.find((cr) => cr.id === r.id);
    return sum + (result?.score ?? 0) * r.weight;
  }, 0);
  const score = totalWeight > 0 ? weightedSum / totalWeight : 1;

  const allChecksPassed = input.spec.checks.every((c) => {
    const result = results.find((cr) => cr.id === c.id);
    return result?.pass === true;
  });

  return {
    score: allChecksPassed ? score : 0,
    perCriterion: results,
  };
}

export function isConverged(verdict: Verdict, threshold: number): boolean {
  const allChecksPassed = verdict.perCriterion
    .filter((c) => c.pass !== undefined)
    .every((c) => c.pass === true);
  return allChecksPassed && verdict.score >= threshold;
}
