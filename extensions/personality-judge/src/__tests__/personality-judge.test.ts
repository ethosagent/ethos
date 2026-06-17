import type { BatchTask } from '@ethosagent/batch-runner';
import type { EvalExpected, EvalStats } from '@ethosagent/eval-harness';
import { describe, expect, it } from 'vitest';
import {
  type AlignmentRunner,
  buildAlignmentRubric,
  type ScoreParams,
  scorePersonality,
} from '../index';

function stubRunner(stats: EvalStats): AlignmentRunner {
  return {
    run(_tasks: BatchTask[], _expectedMap: Map<string, EvalExpected>): Promise<EvalStats> {
      return Promise.resolve(stats);
    },
  };
}

function prompts(n: number): Array<{ id: string; prompt: string }> {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, prompt: `prompt ${i}` }));
}

const RICH_CORE = 'a'.repeat(250);
const RICH_EXPRESSION = 'speaks warmly and precisely';

function baseParams(overrides: Partial<ScoreParams> = {}): ScoreParams {
  return {
    personalityId: 'sage',
    core: RICH_CORE,
    expression: RICH_EXPRESSION,
    recentPrompts: prompts(25),
    windowStart: '2026-06-01T00:00:00Z',
    windowEnd: '2026-06-02T00:00:00Z',
    elapsedHours: 24,
    priorLowStreak: 0,
    runner: stubRunner({ total: 25, passed: 25, failed: 0, avgScore: 1 }),
    ...overrides,
  };
}

describe('buildAlignmentRubric', () => {
  it('embeds core and expression in a single criteria block', () => {
    const rubric = buildAlignmentRubric('my core', 'my voice');
    expect(rubric).toContain('CORE: my core');
    expect(rubric).toContain('EXPRESSION: my voice');
  });
});

describe('scorePersonality activation gate', () => {
  it('returns insufficient_data below minInteractions', async () => {
    const outcome = await scorePersonality(baseParams({ recentPrompts: prompts(19) }));
    expect(outcome.kind).toBe('insufficient_data');
    if (outcome.kind === 'insufficient_data') {
      expect(outcome.reason).toContain('interactions');
    }
  });

  it('returns insufficient_data below minElapsedHours', async () => {
    const outcome = await scorePersonality(baseParams({ elapsedHours: 6 }));
    expect(outcome.kind).toBe('insufficient_data');
    if (outcome.kind === 'insufficient_data') {
      expect(outcome.reason).toContain('h of activity');
    }
  });
});

describe('scorePersonality scoring', () => {
  it('scores with sufficient data and no signal when streak below threshold', async () => {
    const outcome = await scorePersonality(
      baseParams({ runner: stubRunner({ total: 25, passed: 20, failed: 5, avgScore: 0.8 }) }),
    );
    expect(outcome.kind).toBe('scored');
    if (outcome.kind === 'scored') {
      expect(outcome.result.alignmentScore).toBe(0.8);
      expect(outcome.result.sampleCount).toBe(25);
      expect(outcome.result.perDimension).toHaveLength(1);
      expect(outcome.result.perDimension[0]?.id).toBe('core_expression_alignment');
      expect(outcome.result.perDimension[0]?.evidence).toBe(
        '20/25 recent responses judged aligned to Core+Expression',
      );
      expect(outcome.result.signal).toBeNull();
      expect(outcome.lowStreak).toBe(0);
    }
  });

  it('fires a drift signal on sustained low with a rich soul', async () => {
    const outcome = await scorePersonality(
      baseParams({
        priorLowStreak: 2,
        runner: stubRunner({ total: 25, passed: 5, failed: 20, avgScore: 0.2 }),
      }),
    );
    expect(outcome.kind).toBe('scored');
    if (outcome.kind === 'scored') {
      expect(outcome.lowStreak).toBe(3);
      expect(outcome.result.signal).toBe('drift');
    }
  });

  it('fires an underspecified_soul signal on sustained low with an empty expression', async () => {
    const outcome = await scorePersonality(
      baseParams({
        expression: '',
        priorLowStreak: 2,
        runner: stubRunner({ total: 25, passed: 5, failed: 20, avgScore: 0.2 }),
      }),
    );
    expect(outcome.kind).toBe('scored');
    if (outcome.kind === 'scored') {
      expect(outcome.lowStreak).toBe(3);
      expect(outcome.result.signal).toBe('underspecified_soul');
    }
  });

  it('fires an underspecified_soul signal on sustained low with a short core', async () => {
    const outcome = await scorePersonality(
      baseParams({
        core: 'too short',
        priorLowStreak: 2,
        runner: stubRunner({ total: 25, passed: 5, failed: 20, avgScore: 0.2 }),
      }),
    );
    expect(outcome.kind).toBe('scored');
    if (outcome.kind === 'scored') {
      expect(outcome.result.signal).toBe('underspecified_soul');
    }
  });

  it('resets the streak and clears the signal on a non-low score', async () => {
    const outcome = await scorePersonality(
      baseParams({
        priorLowStreak: 2,
        runner: stubRunner({ total: 25, passed: 18, failed: 7, avgScore: 0.72 }),
      }),
    );
    expect(outcome.kind).toBe('scored');
    if (outcome.kind === 'scored') {
      expect(outcome.lowStreak).toBe(0);
      expect(outcome.result.signal).toBeNull();
    }
  });
});
