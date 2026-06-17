import type { JudgeResult, ScoreOutcome } from '@ethosagent/personality-judge';
import { GOOD_ALIGNMENT_THRESHOLD } from '@ethosagent/personality-judge';
import { describe, expect, it, vi } from 'vitest';
import {
  type NightlyEvidence,
  type NightlyPassDeps,
  type NightlyState,
  runNightlyPass,
} from '../orchestrator';

const EVIDENCE: NightlyEvidence = {
  recentPrompts: [{ id: 'p1', prompt: 'hello' }],
  evidenceDigest: 'user: hi\nassistant: hello',
  windowStart: '2026-06-16T00:00:00.000Z',
  windowEnd: '2026-06-17T00:00:00.000Z',
  elapsedHours: 24,
};

function scoredOutcome(alignmentScore: number, signal: JudgeResult['signal'] = null): ScoreOutcome {
  return {
    kind: 'scored',
    lowStreak: 0,
    result: {
      personalityId: 'sage',
      windowStart: EVIDENCE.windowStart,
      windowEnd: EVIDENCE.windowEnd,
      sampleCount: 20,
      alignmentScore,
      perDimension: [{ id: 'core_expression_alignment', score: alignmentScore, evidence: 'e' }],
      signal,
    },
  };
}

// A mutable state store the orchestrator reads/writes through, so we can assert
// idempotency across runs and feed a pre-completed checkpoint.
function makeDeps(overrides: Partial<NightlyPassDeps> = {}): {
  deps: NightlyPassDeps;
  spies: {
    applyExpression: ReturnType<typeof vi.fn>;
    applyMemoryUpdates: ReturnType<typeof vi.fn>;
    draftExpression: ReturnType<typeof vi.fn>;
    scoreAlignment: ReturnType<typeof vi.fn>;
  };
  getState: () => NightlyState | null;
} {
  let state: NightlyState | null = null;

  const applyExpression = vi.fn(async () => ({ revisionId: 'rev-1' }));
  const applyMemoryUpdates = vi.fn(async () => {});
  const draftExpression = vi.fn(async () => ({
    newExpression: 'new expression',
    rationale: 'because evidence shows X',
  }));
  const scoreAlignment = vi.fn(async () => scoredOutcome(0.6));

  const base: NightlyPassDeps = {
    readLivingSoul: async () => ({ core: 'core text', expression: 'expression text' }),
    gatherEvidence: async () => EVIDENCE,
    scoreAlignment,
    readJudgeStreak: async () => 0,
    writeJudgeStreak: async () => {},
    draftExpression,
    applyExpression,
    readMemory: async () => ({ memory: 'old memory', user: 'old user' }),
    consolidate: async () => ({ memory: 'new memory', user: 'new user' }),
    applyMemoryUpdates,
    readState: async () => state,
    writeState: async (_id, s) => {
      state = { windowEnd: s.windowEnd, completed: [...s.completed] };
    },
    ...overrides,
  };

  return {
    deps: base,
    spies: { applyExpression, applyMemoryUpdates, draftExpression, scoreAlignment },
    getState: () => state,
  };
}

function stepStatus(steps: { step: string; status: string }[], name: string): string | undefined {
  return steps.find((s) => s.step === name)?.status;
}

describe('runNightlyPass', () => {
  it('happy path: below GOOD threshold applies Expression and consolidates memory', async () => {
    const { deps, spies, getState } = makeDeps();
    const res = await runNightlyPass('sage', deps);

    expect(stepStatus(res.steps, 'judge')).toBe('ran');
    expect(stepStatus(res.steps, 'expression')).toBe('ran');
    expect(stepStatus(res.steps, 'memory')).toBe('ran');
    expect(spies.applyExpression).toHaveBeenCalledTimes(1);
    expect(spies.applyExpression).toHaveBeenCalledWith('sage', 'new expression', {
      summary: 'because evidence shows X',
      evidenceRef: `nightly:0.60@${EVIDENCE.windowEnd}`,
    });
    expect(spies.applyMemoryUpdates).toHaveBeenCalledTimes(1);

    const state = getState();
    expect(state?.windowEnd).toBe(EVIDENCE.windowEnd);
    expect(state?.completed).toEqual(
      expect.arrayContaining(['judge', 'expression', 'skills', 'memory']),
    );
  });

  it('insufficient_data: judge and expression skipped, memory still runs', async () => {
    const scoreAlignment = vi.fn(
      async (): Promise<ScoreOutcome> => ({ kind: 'insufficient_data', reason: 'too few' }),
    );
    const { deps, spies } = makeDeps({ scoreAlignment });
    const res = await runNightlyPass('sage', deps);

    expect(stepStatus(res.steps, 'judge')).toBe('skipped');
    expect(res.steps.find((s) => s.step === 'judge')?.detail).toBe('too few');
    expect(stepStatus(res.steps, 'expression')).toBe('skipped');
    expect(stepStatus(res.steps, 'memory')).toBe('ran');
    expect(spies.applyExpression).not.toHaveBeenCalled();
    expect(spies.applyMemoryUpdates).toHaveBeenCalledTimes(1);
  });

  it('alignment >= GOOD threshold: expression skipped, no applyExpression', async () => {
    const scoreAlignment = vi.fn(async () => scoredOutcome(GOOD_ALIGNMENT_THRESHOLD + 0.05));
    const { deps, spies } = makeDeps({ scoreAlignment });
    const res = await runNightlyPass('sage', deps);

    const expr = res.steps.find((s) => s.step === 'expression');
    expect(expr?.status).toBe('skipped');
    expect(expr?.detail).toContain('well-aligned');
    expect(spies.applyExpression).not.toHaveBeenCalled();
    expect(spies.draftExpression).not.toHaveBeenCalled();
  });

  it('no createSkills dep: skills step is noop and does not crash', async () => {
    const { deps } = makeDeps();
    const res = await runNightlyPass('sage', deps);
    expect(stepStatus(res.steps, 'skills')).toBe('noop');
  });

  it('createSkills present: skills step runs with count', async () => {
    const createSkills = vi.fn(async () => 3);
    const { deps } = makeDeps({ createSkills });
    const res = await runNightlyPass('sage', deps);
    expect(stepStatus(res.steps, 'skills')).toBe('ran');
    expect(res.steps.find((s) => s.step === 'skills')?.detail).toContain('3');
    expect(createSkills).toHaveBeenCalledTimes(1);
  });

  it('idempotency: all steps completed for the same window are skipped without effects', async () => {
    const completedState: NightlyState = {
      windowEnd: EVIDENCE.windowEnd,
      completed: ['judge', 'expression', 'skills', 'memory'],
    };
    const { deps, spies } = makeDeps({ readState: async () => completedState });
    const res = await runNightlyPass('sage', deps);

    for (const name of ['judge', 'expression', 'skills', 'memory']) {
      expect(stepStatus(res.steps, name)).toBe('skipped');
    }
    expect(spies.applyExpression).not.toHaveBeenCalled();
    expect(spies.applyMemoryUpdates).not.toHaveBeenCalled();
    expect(spies.scoreAlignment).not.toHaveBeenCalled();
  });

  it('a fresh window resets the checkpoint from a prior window', async () => {
    const staleState: NightlyState = {
      windowEnd: '2026-06-15T00:00:00.000Z',
      completed: ['judge', 'expression', 'skills', 'memory'],
    };
    const { deps, spies } = makeDeps({ readState: async () => staleState });
    const res = await runNightlyPass('sage', deps);

    expect(stepStatus(res.steps, 'judge')).toBe('ran');
    expect(spies.scoreAlignment).toHaveBeenCalledTimes(1);
    expect(spies.applyExpression).toHaveBeenCalledTimes(1);
  });

  it('failing expression step is recorded failed, memory still runs, step not completed', async () => {
    const applyExpression = vi.fn(async (): Promise<{ revisionId: string }> => {
      throw new Error('apply boom');
    });
    const { deps, spies, getState } = makeDeps({ applyExpression });
    const res = await runNightlyPass('sage', deps);

    const expr = res.steps.find((s) => s.step === 'expression');
    expect(expr?.status).toBe('failed');
    expect(expr?.detail).toContain('apply boom');
    expect(stepStatus(res.steps, 'memory')).toBe('ran');
    expect(spies.applyMemoryUpdates).toHaveBeenCalledTimes(1);

    expect(getState()?.completed).not.toContain('expression');
    expect(getState()?.completed).toEqual(expect.arrayContaining(['judge', 'skills', 'memory']));
  });

  it('signal set: onSignal called with the right value', async () => {
    const scoreAlignment = vi.fn(async () => scoredOutcome(0.3, 'drift'));
    const onSignal = vi.fn();
    const { deps } = makeDeps({ scoreAlignment, onSignal });
    await runNightlyPass('sage', deps);
    expect(onSignal).toHaveBeenCalledWith('sage', 'drift');
  });

  it('memory with no diff is a noop', async () => {
    const { deps, spies } = makeDeps({
      readMemory: async () => ({ memory: 'same', user: 'same' }),
      consolidate: async () => ({ memory: 'same', user: 'same' }),
    });
    const res = await runNightlyPass('sage', deps);
    expect(stepStatus(res.steps, 'memory')).toBe('noop');
    expect(spies.applyMemoryUpdates).not.toHaveBeenCalled();
  });
});
