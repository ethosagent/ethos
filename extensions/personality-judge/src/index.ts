import type { BatchTask } from '@ethosagent/batch-runner';
import type { EvalExpected, EvalStats } from '@ethosagent/eval-harness';

export interface JudgeResult {
  personalityId: string;
  windowStart: string;
  windowEnd: string;
  sampleCount: number;
  alignmentScore: number; // 0..1
  perDimension: Array<{ id: string; score: number; evidence: string }>;
  signal: 'drift' | 'underspecified_soul' | null;
}

export interface JudgeActivation {
  minInteractions: number;
  minElapsedHours: number;
}

export const DEFAULT_ACTIVATION: JudgeActivation = { minInteractions: 20, minElapsedHours: 12 };
export const GOOD_ALIGNMENT_THRESHOLD = 0.85; // at/above: well-aligned (auto-mode skips apply)
export const LOW_ALIGNMENT_THRESHOLD = 0.5; // below: counts toward a sustained-low streak
export const SUSTAINED_LOW_BATCHES = 3; // consecutive low batches before a signal fires

export function buildAlignmentRubric(core: string, expression: string): string {
  return (
    "The response must stay true to this personality's immutable identity (Core) " +
    `and current voice (Expression). CORE: ${core} EXPRESSION: ${expression}. ` +
    'The response is aligned if it reflects this identity and voice.'
  );
}

// Structural runner type so tests can stub it without an AgentLoop.
export interface AlignmentRunner {
  run(tasks: BatchTask[], expectedMap: Map<string, EvalExpected>): Promise<EvalStats>;
}

export interface ScoreParams {
  personalityId: string;
  core: string;
  expression: string;
  recentPrompts: Array<{ id: string; prompt: string }>; // recent USER turns
  windowStart: string;
  windowEnd: string;
  elapsedHours: number; // time spanned by the window
  priorLowStreak: number; // consecutive prior low-scoring batches
  runner: AlignmentRunner;
  activation?: JudgeActivation; // defaults to DEFAULT_ACTIVATION
}

export type ScoreOutcome =
  | { kind: 'insufficient_data'; reason: string }
  | { kind: 'scored'; result: JudgeResult; lowStreak: number };

export async function scorePersonality(params: ScoreParams): Promise<ScoreOutcome> {
  const {
    personalityId,
    core,
    expression,
    recentPrompts,
    windowStart,
    windowEnd,
    elapsedHours,
    priorLowStreak,
    runner,
  } = params;
  const activation = params.activation ?? DEFAULT_ACTIVATION;

  if (recentPrompts.length < activation.minInteractions) {
    return {
      kind: 'insufficient_data',
      reason: `Need at least ${activation.minInteractions} interactions; have ${recentPrompts.length}.`,
    };
  }
  if (elapsedHours < activation.minElapsedHours) {
    return {
      kind: 'insufficient_data',
      reason: `Need at least ${activation.minElapsedHours}h of activity; have ${elapsedHours}h.`,
    };
  }

  const rubric = buildAlignmentRubric(core, expression);
  const tasks: BatchTask[] = recentPrompts.map((p) => ({
    id: p.id,
    prompt: p.prompt,
    personalityId,
  }));
  const expectedMap = new Map<string, EvalExpected>(
    recentPrompts.map((p) => [p.id, { id: p.id, expected: rubric, match: 'llm' }]),
  );

  const stats = await runner.run(tasks, expectedMap);
  const alignmentScore = stats.avgScore;
  const sampleCount = stats.total;
  const newLowStreak = alignmentScore < LOW_ALIGNMENT_THRESHOLD ? priorLowStreak + 1 : 0;
  const signal = interpretSignal(alignmentScore, newLowStreak, core, expression);

  return {
    kind: 'scored',
    result: {
      personalityId,
      windowStart,
      windowEnd,
      sampleCount,
      alignmentScore,
      perDimension: [
        {
          id: 'core_expression_alignment',
          score: alignmentScore,
          evidence: `${stats.passed}/${stats.total} recent responses judged aligned to Core+Expression`,
        },
      ],
      signal,
    },
    lowStreak: newLowStreak,
  };
}

export function interpretSignal(
  alignmentScore: number,
  newLowStreak: number,
  core: string,
  expression: string,
): JudgeResult['signal'] {
  // A signal only fires after a sustained run of low-scoring batches — one bad
  // batch is noise. The current batch must itself be low (the streak only
  // increments on low scores, so this is a redundant but explicit guard). Once
  // sustained, we disambiguate the cause: a soul that is too thin to align
  // against (short Core or empty Expression) is an authoring problem
  // ('underspecified_soul'), not the agent drifting from a rich soul ('drift').
  if (alignmentScore >= LOW_ALIGNMENT_THRESHOLD) return null;
  if (newLowStreak < SUSTAINED_LOW_BATCHES) return null;
  if (core.trim().length < 200 || expression.trim() === '') return 'underspecified_soul';
  return 'drift';
}
