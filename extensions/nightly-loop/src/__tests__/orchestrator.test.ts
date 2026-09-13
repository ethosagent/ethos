import type { JudgeResult, ScoreOutcome } from '@ethosagent/personality-judge';
import { GOOD_ALIGNMENT_THRESHOLD } from '@ethosagent/personality-judge';
import { describe, expect, it, vi } from 'vitest';
import type { ConsolidationResult } from '../memory-consolidation';
import { emptyMeta, type MemoryMeta } from '../memory-decay';
import {
  type NightlyEvidence,
  type NightlyLearningDeps,
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
    submitExpression: ReturnType<typeof vi.fn>;
    applyMemoryUpdates: ReturnType<typeof vi.fn>;
    draftExpression: ReturnType<typeof vi.fn>;
    scoreAlignment: ReturnType<typeof vi.fn>;
  };
  getState: () => NightlyState | null;
} {
  let state: NightlyState | null = null;

  const submitExpression = vi.fn(async () => ({ candidateId: 'c-expr-1' }));
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
    submitExpression,
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
    spies: {
      submitExpression,
      applyMemoryUpdates,
      draftExpression,
      scoreAlignment,
    },
    getState: () => state,
  };
}

function stepStatus(steps: { step: string; status: string }[], name: string): string | undefined {
  return steps.find((s) => s.step === name)?.status;
}

describe('runNightlyPass', () => {
  it('happy path: below GOOD threshold submits an Expression candidate and consolidates memory', async () => {
    const { deps, spies, getState } = makeDeps();
    const res = await runNightlyPass('sage', deps);

    expect(stepStatus(res.steps, 'judge')).toBe('ran');
    expect(stepStatus(res.steps, 'expression')).toBe('ran');
    expect(res.steps.find((s) => s.step === 'expression')?.detail).toContain('c-expr-1');
    expect(stepStatus(res.steps, 'memory')).toBe('ran');
    expect(spies.submitExpression).toHaveBeenCalledTimes(1);
    expect(spies.submitExpression).toHaveBeenCalledWith(
      'sage',
      { newExpression: 'new expression', rationale: 'because evidence shows X' },
      { evidenceRef: `nightly:0.60@${EVIDENCE.windowEnd}` },
    );
    expect(spies.applyMemoryUpdates).toHaveBeenCalledTimes(1);

    const state = getState();
    expect(state?.windowEnd).toBe(EVIDENCE.windowEnd);
    expect(state?.completed).toEqual(
      expect.arrayContaining(['judge', 'expression', 'skills', 'replay', 'memory']),
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
    expect(spies.submitExpression).not.toHaveBeenCalled();
    expect(spies.applyMemoryUpdates).toHaveBeenCalledTimes(1);
  });

  it('alignment >= GOOD threshold: expression skipped, no applyExpression', async () => {
    const scoreAlignment = vi.fn(async () => scoredOutcome(GOOD_ALIGNMENT_THRESHOLD + 0.05));
    const { deps, spies } = makeDeps({ scoreAlignment });
    const res = await runNightlyPass('sage', deps);

    const expr = res.steps.find((s) => s.step === 'expression');
    expect(expr?.status).toBe('skipped');
    expect(expr?.detail).toContain('well-aligned');
    expect(spies.submitExpression).not.toHaveBeenCalled();
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
      completed: ['judge', 'expression', 'skills', 'replay', 'memory'],
    };
    const { deps, spies } = makeDeps({ readState: async () => completedState });
    const res = await runNightlyPass('sage', deps);

    for (const name of ['judge', 'expression', 'skills', 'replay', 'memory']) {
      expect(stepStatus(res.steps, name)).toBe('skipped');
    }
    expect(spies.submitExpression).not.toHaveBeenCalled();
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
    expect(spies.submitExpression).toHaveBeenCalledTimes(1);
  });

  it('failing expression step is recorded failed, memory still runs, step not completed', async () => {
    const submitExpression = vi.fn(async (): Promise<{ candidateId: string }> => {
      throw new Error('submit boom');
    });
    const { deps, spies, getState } = makeDeps({ submitExpression });
    const res = await runNightlyPass('sage', deps);

    const expr = res.steps.find((s) => s.step === 'expression');
    expect(expr?.status).toBe('failed');
    expect(expr?.detail).toContain('submit boom');
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

  describe('gates (P5 — defaults preserve behavior)', () => {
    it('gates absent: judge + expression run exactly as before', async () => {
      const { deps, spies } = makeDeps();
      const res = await runNightlyPass('sage', deps);
      expect(stepStatus(res.steps, 'judge')).toBe('ran');
      expect(stepStatus(res.steps, 'expression')).toBe('ran');
      expect(spies.scoreAlignment).toHaveBeenCalledTimes(1);
      expect(spies.submitExpression).toHaveBeenCalledTimes(1);
    });

    it('gates undefined fields: judge + expression run (default true)', async () => {
      const { deps, spies } = makeDeps();
      const res = await runNightlyPass('sage', deps, {});
      expect(stepStatus(res.steps, 'judge')).toBe('ran');
      expect(stepStatus(res.steps, 'expression')).toBe('ran');
      expect(spies.submitExpression).toHaveBeenCalledTimes(1);
    });

    it('gates.judge false: judge skipped, expression short-circuits, memory still runs', async () => {
      const { deps, spies } = makeDeps();
      const res = await runNightlyPass('sage', deps, { judge: false });
      const judge = res.steps.find((s) => s.step === 'judge');
      expect(judge?.status).toBe('skipped');
      expect(judge?.detail).toBe('judge disabled');
      expect(stepStatus(res.steps, 'expression')).toBe('skipped');
      expect(spies.scoreAlignment).not.toHaveBeenCalled();
      expect(spies.submitExpression).not.toHaveBeenCalled();
      expect(stepStatus(res.steps, 'memory')).toBe('ran');
      expect(spies.applyMemoryUpdates).toHaveBeenCalledTimes(1);
    });

    it('gates.expression false: judge runs, expression skipped regardless of verdict', async () => {
      const { deps, spies } = makeDeps();
      const res = await runNightlyPass('sage', deps, { expression: false });
      expect(stepStatus(res.steps, 'judge')).toBe('ran');
      expect(spies.scoreAlignment).toHaveBeenCalledTimes(1);
      const expr = res.steps.find((s) => s.step === 'expression');
      expect(expr?.status).toBe('skipped');
      expect(expr?.detail).toBe('expression disabled');
      expect(spies.draftExpression).not.toHaveBeenCalled();
      expect(spies.submitExpression).not.toHaveBeenCalled();
    });
  });

  // B-T1 made `user` mode queue instead of apply; L-D2 goes further. The pass has
  // no apply dependency at all: a draft is a learning candidate in EVERY mode,
  // and only `replayAndResolve` may promote one without a human
  // (`extensions/learning-inbox/src/__tests__/auto-promotion.test.ts` pins the
  // mode side). The deps below carry a pre-L-T6 host's `applyExpression` and
  // mode reader anyway, to prove nothing on this path can reach them.
  describe('evolution_approval_mode (B-T1, L-D2)', () => {
    function withLegacyApply(mode: 'auto' | 'user' | undefined) {
      const applyExpression = vi.fn(async () => ({ revisionId: 'rev-1' }));
      const made = makeDeps({
        applyExpression,
        expressionApprovalMode: () => mode,
      } as Partial<NightlyPassDeps>);
      return { ...made, applyExpression };
    }

    it('a user-mode personality never reaches applyExpression', async () => {
      const { deps, spies, applyExpression } = withLegacyApply('user');
      const res = await runNightlyPass('sage', deps);

      expect(res.steps.find((s) => s.step === 'expression')?.status).toBe('ran');
      expect(applyExpression).not.toHaveBeenCalled();
      expect(spies.submitExpression).toHaveBeenCalledTimes(1);
    });

    it('mode absent (the `user` default) never reaches applyExpression', async () => {
      const { deps, spies, applyExpression } = withLegacyApply(undefined);
      await runNightlyPass('sage', deps);

      expect(applyExpression).not.toHaveBeenCalled();
      expect(spies.submitExpression).toHaveBeenCalledTimes(1);
    });

    it("mode 'auto' no longer applies an unevaluated draft: it is submitted too", async () => {
      const { deps, spies, applyExpression } = withLegacyApply('auto');
      const res = await runNightlyPass('sage', deps);

      expect(res.steps.find((s) => s.step === 'expression')?.detail).toContain('submitted');
      expect(applyExpression).not.toHaveBeenCalled();
      expect(spies.submitExpression).toHaveBeenCalledTimes(1);
    });

    it('a submitted draft completes the step, so the same window does not re-submit', async () => {
      const { deps, spies, getState } = makeDeps();
      await runNightlyPass('sage', deps);
      expect(getState()?.completed).toContain('expression');

      await runNightlyPass('sage', deps);
      expect(spies.submitExpression).toHaveBeenCalledTimes(1);
    });
  });

  describe('replay step (L-D9)', () => {
    function budget(n: number): NightlyLearningDeps['budget'] {
      let left = n;
      return {
        take: () => {
          if (left <= 0) return false;
          left -= 1;
          return true;
        },
      };
    }

    function learning(overrides: Partial<NightlyLearningDeps> = {}) {
      const freezeCases = vi.fn(async () => ({ frozen: 2, pinned: 0, overflow: 0 }));
      const pendingReplay = vi.fn(async () => ['c-1', 'c-2', 'c-3', 'c-4', 'c-5']);
      const replay = vi.fn(async () => ({ verdict: 'pass', promoted: false }));
      const deps: NightlyLearningDeps = {
        enabled: true,
        budget: budget(5),
        freezeCases,
        pendingReplay,
        replay,
        ...overrides,
      };
      return { deps, freezeCases, pendingReplay, replay };
    }

    it('runs after skills and before memory, freezing cases first', async () => {
      const order: string[] = [];
      const l = learning({
        freezeCases: async () => {
          order.push('freeze');
          return { frozen: 1, pinned: 0, overflow: 0 };
        },
        pendingReplay: async () => {
          order.push('pending');
          return ['c-1'];
        },
        replay: async () => {
          order.push('replay');
          return { verdict: 'pass', promoted: true };
        },
      });
      const { deps } = makeDeps({
        createSkills: async () => {
          order.push('skills');
          return 1;
        },
        readMemory: async () => {
          order.push('memory');
          return { memory: 'm', user: 'u' };
        },
        learning: l.deps,
      });

      const res = await runNightlyPass('sage', deps);

      expect(order).toEqual(['skills', 'freeze', 'pending', 'replay', 'memory']);
      expect(res.steps.map((s) => s.step)).toEqual([
        'judge',
        'expression',
        'skills',
        'replay',
        'memory',
      ]);
      expect(res.steps.find((s) => s.step === 'replay')?.detail).toContain('1 promoted');
    });

    it('says why when pinned targets push the case pool over its cap', async () => {
      const l = learning({
        freezeCases: async () => ({ frozen: 0, pinned: 43, overflow: 3 }),
        pendingReplay: async () => ['c-1'],
        replay: async () => ({ verdict: 'incomplete', promoted: false }),
      });
      const { deps } = makeDeps({ learning: l.deps });

      const res = await runNightlyPass('sage', deps);

      const detail = res.steps.find((s) => s.step === 'replay')?.detail ?? '';
      expect(detail).toContain('0 case(s) frozen, 1 replayed, 0 promoted');
      expect(detail).toContain('case pool is 3 over its cap: 43 case(s) are targets');
      expect(detail).toContain('incomplete');
    });

    it('adds no pool notice while the pool is within its cap', async () => {
      const l = learning({ freezeCases: async () => ({ frozen: 1, pinned: 5, overflow: 0 }) });
      const { deps } = makeDeps({ learning: l.deps });

      const res = await runNightlyPass('sage', deps);

      expect(res.steps.find((s) => s.step === 'replay')?.detail).not.toContain('case pool');
    });

    it('never runs replay (or freezes cases) when learningReplay.enabled is false', async () => {
      const l = learning({ enabled: false });
      const { deps, getState } = makeDeps({ learning: l.deps });

      const res = await runNightlyPass('sage', deps);

      expect(stepStatus(res.steps, 'replay')).toBe('skipped');
      expect(l.freezeCases).not.toHaveBeenCalled();
      expect(l.pendingReplay).not.toHaveBeenCalled();
      expect(l.replay).not.toHaveBeenCalled();
      expect(getState()?.completed).not.toContain('replay');
    });

    it('never exceeds maxCandidatesPerRun, and the budget is shared across personalities', async () => {
      const shared = budget(2);
      const first = learning({ budget: shared });
      const second = learning({ budget: shared });

      const a = await runNightlyPass('sage', makeDeps({ learning: first.deps }).deps);
      const b = await runNightlyPass('scout', makeDeps({ learning: second.deps }).deps);

      expect(first.replay).toHaveBeenCalledTimes(2);
      expect(second.replay).not.toHaveBeenCalled();
      expect(a.steps.find((s) => s.step === 'replay')?.detail).toContain('3 deferred');
      expect(b.steps.find((s) => s.step === 'replay')?.detail).toContain('5 deferred');
    });

    it('one failing candidate does not stop the others, and the step is not completed', async () => {
      const replay = vi.fn(async (_id: string, candidateId: string) => {
        if (candidateId === 'c-2') throw new Error('arm crashed');
        return { verdict: 'regress', promoted: false };
      });
      const { deps, getState } = makeDeps({ learning: learning({ replay }).deps });

      const res = await runNightlyPass('sage', deps);

      expect(replay).toHaveBeenCalledTimes(5);
      const step = res.steps.find((s) => s.step === 'replay');
      expect(step?.status).toBe('failed');
      expect(step?.detail).toContain('c-2: arm crashed');
      expect(getState()?.completed).not.toContain('replay');
      expect(stepStatus(res.steps, 'memory')).toBe('ran');
    });

    it('no learning dep: the step is a noop', async () => {
      const { deps } = makeDeps();
      const res = await runNightlyPass('sage', deps);
      expect(stepStatus(res.steps, 'replay')).toBe('noop');
    });
  });

  describe('M3 — importance decay in the memory step', () => {
    function scored(memorySections: ConsolidationResult['memorySections']): ConsolidationResult {
      const memory = (memorySections ?? []).map((s) => `### ${s.slug}\n${s.content}`).join('\n\n');
      return { memory, user: '', memorySections, userSections: [], scored: true };
    }

    it('scored result + sidecar deps: archives low-importance and writes meta', async () => {
      const writeMemoryMeta = vi.fn(async () => {});
      let stored: MemoryMeta = emptyMeta();
      const { deps, spies } = makeDeps({
        readMemory: async () => ({ memory: '### keep\nx\n\n### drop\ny', user: '' }),
        consolidate: async () =>
          scored([
            { slug: 'keep', content: 'x', score: 0.9 },
            { slug: 'drop', content: 'y', score: 0.0 },
          ]),
        readMemoryMeta: async () => stored,
        writeMemoryMeta: async (_id, m) => {
          stored = m;
          writeMemoryMeta();
        },
        now: () => 1_800_000_000_000,
      });

      const res = await runNightlyPass('sage', deps);
      expect(stepStatus(res.steps, 'memory')).toBe('ran');
      expect(res.steps.find((s) => s.step === 'memory')?.detail).toContain('archived 1');
      expect(writeMemoryMeta).toHaveBeenCalledTimes(1);

      const updates = spies.applyMemoryUpdates.mock.calls[0]?.[1] as Array<{ key: string }>;
      expect(updates.some((u) => u.key === 'memory-archive.md')).toBe(true);
      // Only the kept slug remains tracked.
      expect(Object.keys(stored.keys['MEMORY.md'] ?? {})).toEqual(['keep']);
    });

    it('§5 drift reconciliation: hand-deleted section → user-removed + onSidecarReconciled', async () => {
      let stored: MemoryMeta = {
        version: 1,
        keys: {
          'MEMORY.md': {
            keep: { importance: 0.9, lastSeen: 1_800_000_000_000 },
            gone: { importance: 0.8, lastSeen: 1_800_000_000_000 },
          },
        },
      };
      const onSidecarReconciled = vi.fn(async () => {});
      const { deps } = makeDeps({
        // `### gone` was hand-deleted from the live file before this pass.
        readMemory: async () => ({ memory: '### keep\nx', user: '' }),
        consolidate: async () => scored([{ slug: 'keep', content: 'x reworded', score: 0.9 }]),
        readMemoryMeta: async () => stored,
        writeMemoryMeta: async (_id, m) => {
          stored = m;
        },
        onSidecarReconciled,
        now: () => 1_800_000_000_000,
      });

      const res = await runNightlyPass('sage', deps);
      expect(res.steps.find((s) => s.step === 'memory')?.detail).toContain(
        'reconciled 1 user-removed',
      );
      expect(stored.keys['MEMORY.md']?.gone?.state).toBe('user-removed');
      expect(onSidecarReconciled).toHaveBeenCalledTimes(1);
      const args = onSidecarReconciled.mock.calls[0] as unknown as [
        string,
        { userRemovedSlugs: string[] },
      ];
      expect(args[0]).toBe('sage');
      expect(args[1].userRemovedSlugs).toEqual(['gone']);
    });

    it('scoring failure (scored=false): no decay, meta untouched', async () => {
      const writeMemoryMeta = vi.fn(async () => {});
      const { deps, spies } = makeDeps({
        readMemory: async () => ({ memory: 'old memory', user: 'old user' }),
        consolidate: async (): Promise<ConsolidationResult> => ({
          memory: 'new memory',
          user: 'new user',
          scored: false,
        }),
        readMemoryMeta: async () => emptyMeta(),
        writeMemoryMeta,
      });

      const res = await runNightlyPass('sage', deps);
      expect(stepStatus(res.steps, 'memory')).toBe('ran');
      expect(res.steps.find((s) => s.step === 'memory')?.detail).not.toContain('archived');
      expect(writeMemoryMeta).not.toHaveBeenCalled();
      expect(spies.applyMemoryUpdates).toHaveBeenCalledTimes(1);
    });
  });
});
