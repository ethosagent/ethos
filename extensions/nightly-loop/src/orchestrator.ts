// Nightly-pass orchestrator (Phase 3c, component E) — the pure, dependency-
// injected core of the nightly governed-learning pass.
//
// runNightlyPass() runs six ordered, individually-checkpointed steps for one
// personality: gather evidence → judge alignment → (maybe) draft an Expression →
// (maybe) create skills → replay learning candidates → consolidate memory.
//
// Nothing in this pass writes SOUL.md or a live skill directly (plan
// `trust-before-reach.md` Part 4, L-D2). Step 3 submits its Expression draft as
// a learning candidate (`submitExpression`); the Judge decides only WHETHER to
// draft. The `replay` step measures pending candidates, and the one path that
// may then promote without a human is `replayAndResolve`
// (`extensions/learning-inbox/src/auto-promotion.ts`), reached through
// `NightlyLearningDeps.replay`. This module therefore has no apply dependency to
// call — an approval mode cannot route around a gate that is not here.
//
// Every external effect is an injected plain function (NightlyPassDeps), so the
// pass is unit-testable with stubs — no AgentLoop, no real LLM, no Storage.
//
// Idempotency: each step name is recorded in NightlyState.completed once it
// succeeds, scoped to the evidence window (windowEnd). A re-run with the same
// window skips completed steps; a failed step is NOT marked completed, so a
// re-run retries it. One step's failure is recorded and does not abort the
// remaining independent steps.

import { GOOD_ALIGNMENT_THRESHOLD, type ScoreOutcome } from '@ethosagent/personality-judge';
import type { MemoryUpdate } from '@ethosagent/types';
import { buildConsolidationUpdates, type ConsolidationResult } from './memory-consolidation';
import {
  type DecayConfig,
  type MemoryMeta,
  planConsolidation,
  resolveDecayParams,
} from './memory-decay';

export interface NightlyStepLog {
  step: string;
  status: 'ran' | 'skipped' | 'noop' | 'failed';
  detail: string;
}

export interface NightlyPassResult {
  personalityId: string;
  windowEnd: string;
  steps: NightlyStepLog[];
}

// Per-personality idempotency checkpoint. `completed` lists step names already
// done for `windowEnd`; a re-run with the same window skips them.
export interface NightlyState {
  windowEnd: string;
  completed: string[];
}

export interface NightlyEvidence {
  recentPrompts: Array<{ id: string; prompt: string }>;
  evidenceDigest: string; // compact prose digest for the Expression draft + consolidation
  windowStart: string;
  windowEnd: string;
  elapsedHours: number;
}

export interface NightlyPassDeps {
  readLivingSoul(id: string): Promise<{ core: string; expression: string }>;
  gatherEvidence(id: string): Promise<NightlyEvidence>;
  // Runs the Judge (wraps scorePersonality with a real EvalRunner in prod).
  scoreAlignment(args: {
    personalityId: string;
    core: string;
    expression: string;
    evidence: NightlyEvidence;
    priorLowStreak: number;
  }): Promise<ScoreOutcome>;
  readJudgeStreak(id: string): Promise<number>;
  writeJudgeStreak(id: string, lowStreak: number): Promise<void>;
  draftExpression(args: {
    core: string;
    currentExpression: string;
    evidence: string;
  }): Promise<{ newExpression: string; rationale: string }>;
  /**
   * Submit a drafted Expression to the learning inbox (L-D2). It is never
   * applied here, in any approval mode: an `auto` personality's draft goes live
   * only after a `pass` replay (`replayAndResolve`), a `user` one only when a
   * human approves it. The candidate fingerprints the live SOUL.md itself
   * (`baseHash`), so no base Expression is passed. In the CLI this is
   * `submitExpressionCandidate` (`packages/wiring/src/learning-pipeline.ts`).
   */
  submitExpression(
    id: string,
    draft: { newExpression: string; rationale: string },
    meta: { evidenceRef: string },
  ): Promise<{ candidateId: string }>;
  createSkills?(id: string, evidence: NightlyEvidence): Promise<number>; // 3d hook; OPTIONAL — absent = step noop
  /** The `replay` step (L-D9). OPTIONAL — absent = step noop. */
  learning?: NightlyLearningDeps;
  readMemory(id: string): Promise<{ memory: string; user: string }>;
  consolidate(input: {
    memory: string;
    user: string;
    recentContext: string;
  }): Promise<ConsolidationResult>;
  applyMemoryUpdates(personalityId: string, updates: MemoryUpdate[]): Promise<void>;
  // Importance/decay sidecar (M3, §4.1). OPTIONAL — when either is absent the
  // memory step degrades to the pre-M3 whole-file consolidation (no decay).
  // The nightly pass is the SINGLE writer of `memory-meta.json`.
  readMemoryMeta?(id: string): Promise<MemoryMeta>;
  writeMemoryMeta?(id: string, meta: MemoryMeta): Promise<void>;
  /**
   * §5 sidecar-drift reconciliation. Called after the sidecar is persisted when
   * the pass marked hand-deleted sections 'user-removed', so the caller can
   * history-record the transition. OPTIONAL — absent means no record.
   */
  onSidecarReconciled?(
    id: string,
    args: { userRemovedSlugs: string[]; before: MemoryMeta; after: MemoryMeta },
  ): Promise<void>;
  /** Decay tuning (§4.2/§4.3). Defaults applied by `resolveDecayParams`. */
  memoryDecay?: DecayConfig;
  /** Injected clock for decay recency; defaults to Date.now. */
  now?(): number;
  readState(id: string): Promise<NightlyState | null>;
  writeState(id: string, state: NightlyState): Promise<void>;
  onSignal?(id: string, signal: 'drift' | 'underspecified_soul'): void; // surface the actionable signal
  log?(msg: string): void;
}

/**
 * The nightly `replay` step (plan `trust-before-reach.md` Part 4, L-D9). The one
 * scheduled place replay runs — never on `agent_done`.
 */
export interface NightlyLearningDeps {
  /** `learningReplay.enabled` (`resolveLearningReplay`). False skips the whole step. */
  enabled: boolean;
  /**
   * The run's `learningReplay.maxCandidatesPerRun`. `take()` consumes one slot
   * and returns false once none are left. One budget object is shared by every
   * personality in a run, so the cap is per RUN, not per personality.
   */
  budget: { take(): boolean };
  /** Freeze new cases for this personality (at most 10, pool capped at 40). Returns the count frozen. */
  freezeCases(id: string): Promise<number>;
  /** This personality's `pending_replay` candidate ids, oldest first. */
  pendingReplay(id: string): Promise<string[]>;
  /** Replay one candidate and let `replayAndResolve` decide whether it promotes. */
  replay(id: string, candidateId: string): Promise<{ verdict: string; promoted: boolean }>;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Per-step gates resolved from `PersonalityConfig.nightly`. Both default to
 * true (today's behavior). `judge: false` skips the judge step (no verdict, so
 * expression short-circuits as on insufficient data); `expression: false` skips
 * the expression step regardless of the verdict.
 */
export interface NightlyGates {
  judge?: boolean;
  expression?: boolean;
}

export async function runNightlyPass(
  personalityId: string,
  deps: NightlyPassDeps,
  gates?: NightlyGates,
): Promise<NightlyPassResult> {
  const judgeEnabled = gates?.judge !== false;
  const expressionEnabled = gates?.expression !== false;
  const steps: NightlyStepLog[] = [];

  // Step 1: gather evidence. This is the precondition for every later step, so
  // a failure here aborts the pass (there is nothing independent to salvage).
  const evidence = await deps.gatherEvidence(personalityId);

  // Load (or freshen) the checkpoint for this window. A new window resets the
  // completed list — last night's progress does not count for tonight.
  const prior = await deps.readState(personalityId);
  const state: NightlyState =
    prior && prior.windowEnd === evidence.windowEnd
      ? { windowEnd: prior.windowEnd, completed: [...prior.completed] }
      : { windowEnd: evidence.windowEnd, completed: [] };

  const done = (step: string): boolean => state.completed.includes(step);
  const markDone = async (step: string): Promise<void> => {
    if (!state.completed.includes(step)) state.completed.push(step);
    await deps.writeState(personalityId, state);
  };

  const soul = await deps.readLivingSoul(personalityId);

  // Step 2: judge. Records the verdict for the expression step. insufficient_data
  // means no verdict → the expression step is skipped (no auto-apply without a
  // score), but memory consolidation still runs.
  let judgeOutcome: ScoreOutcome | null = null;
  let judgeInsufficient = false;
  if (done('judge')) {
    steps.push({ step: 'judge', status: 'skipped', detail: 'already completed for this window' });
  } else if (!judgeEnabled) {
    // Judge disabled for this personality: no verdict is produced, so the
    // expression step short-circuits exactly as it does on insufficient data.
    judgeInsufficient = true;
    steps.push({ step: 'judge', status: 'skipped', detail: 'judge disabled' });
  } else {
    try {
      const priorLowStreak = await deps.readJudgeStreak(personalityId);
      const outcome = await deps.scoreAlignment({
        personalityId,
        core: soul.core,
        expression: soul.expression,
        evidence,
        priorLowStreak,
      });
      if (outcome.kind === 'insufficient_data') {
        judgeInsufficient = true;
        steps.push({ step: 'judge', status: 'skipped', detail: outcome.reason });
      } else {
        judgeOutcome = outcome;
        await deps.writeJudgeStreak(personalityId, outcome.lowStreak);
        const signal = outcome.result.signal;
        if (signal) deps.onSignal?.(personalityId, signal);
        steps.push({
          step: 'judge',
          status: 'ran',
          detail: `alignment ${(outcome.result.alignmentScore * 100).toFixed(0)}%${
            signal ? ` (signal: ${signal})` : ''
          }`,
        });
      }
      await markDone('judge');
    } catch (err) {
      steps.push({ step: 'judge', status: 'failed', detail: errMessage(err) });
    }
  }

  // Step 3: expression. Skipped if already done, if the judge produced no
  // verdict (insufficient data), or if the judge has no result this run (e.g.
  // it failed or was already completed in a prior run with no carried verdict).
  if (done('expression')) {
    steps.push({
      step: 'expression',
      status: 'skipped',
      detail: 'already completed for this window',
    });
  } else if (!expressionEnabled) {
    steps.push({ step: 'expression', status: 'skipped', detail: 'expression disabled' });
  } else if (judgeInsufficient) {
    steps.push({ step: 'expression', status: 'skipped', detail: 'no verdict (insufficient data)' });
  } else if (!judgeOutcome) {
    steps.push({ step: 'expression', status: 'skipped', detail: 'no judge verdict available' });
  } else {
    const result = judgeOutcome.result;
    const pct = (result.alignmentScore * 100).toFixed(0);
    if (result.alignmentScore >= GOOD_ALIGNMENT_THRESHOLD) {
      steps.push({ step: 'expression', status: 'skipped', detail: `already well-aligned ${pct}%` });
      await markDone('expression');
    } else {
      try {
        const draft = await deps.draftExpression({
          core: soul.core,
          currentExpression: soul.expression,
          evidence: evidence.evidenceDigest,
        });
        const evidenceRef = `nightly:${result.alignmentScore.toFixed(2)}@${evidence.windowEnd}`;
        // L-D2: the Judge decided to draft; it does not decide to apply. The
        // draft is a candidate in every approval mode.
        const submitted = await deps.submitExpression(personalityId, draft, { evidenceRef });
        steps.push({
          step: 'expression',
          status: 'ran',
          detail: `submitted candidate ${submitted.candidateId} (alignment ${pct}%)`,
        });
        await markDone('expression');
      } catch (err) {
        steps.push({ step: 'expression', status: 'failed', detail: errMessage(err) });
      }
    }
  }

  // Step 4: skills. Optional dependency — when absent the step is a noop and
  // must not crash. The real implementation arrives in 3d.
  if (done('skills')) {
    steps.push({ step: 'skills', status: 'skipped', detail: 'already completed for this window' });
  } else if (deps.createSkills) {
    try {
      const count = await deps.createSkills(personalityId, evidence);
      steps.push({
        step: 'skills',
        status: 'ran',
        detail: `${count} skill candidate(s) submitted`,
      });
      await markDone('skills');
    } catch (err) {
      steps.push({ step: 'skills', status: 'failed', detail: errMessage(err) });
    }
  } else {
    steps.push({ step: 'skills', status: 'noop', detail: 'skill creation deferred to 3d' });
    await markDone('skills');
  }

  // Step 5: replay (L-D9). After `skills`, so tonight's candidates are measured
  // tonight. Budget-capped across the run; skipped entirely when
  // `learningReplay.enabled` is false. A failing candidate does not stop the
  // others; a step with any failure is not marked done, and a retry only sees
  // what is still `pending_replay`.
  const learning = deps.learning;
  if (done('replay')) {
    steps.push({ step: 'replay', status: 'skipped', detail: 'already completed for this window' });
  } else if (!learning) {
    steps.push({ step: 'replay', status: 'noop', detail: 'learning inbox not wired' });
    await markDone('replay');
  } else if (!learning.enabled) {
    steps.push({ step: 'replay', status: 'skipped', detail: 'learningReplay.enabled is false' });
  } else {
    try {
      const frozen = await learning.freezeCases(personalityId);
      const failures: string[] = [];
      let replayed = 0;
      let promoted = 0;
      let deferred = 0;
      for (const candidateId of await learning.pendingReplay(personalityId)) {
        if (!learning.budget.take()) {
          deferred += 1;
          continue;
        }
        try {
          const outcome = await learning.replay(personalityId, candidateId);
          replayed += 1;
          if (outcome.promoted) promoted += 1;
        } catch (err) {
          failures.push(`${candidateId}: ${errMessage(err)}`);
        }
      }
      const detail = `${frozen} case(s) frozen, ${replayed} replayed, ${promoted} promoted${
        deferred ? `, ${deferred} deferred (maxCandidatesPerRun)` : ''
      }`;
      if (failures.length > 0) {
        steps.push({
          step: 'replay',
          status: 'failed',
          detail: `${detail}; ${failures.join('; ')}`,
        });
      } else {
        steps.push({ step: 'replay', status: 'ran', detail });
        await markDone('replay');
      }
    } catch (err) {
      steps.push({ step: 'replay', status: 'failed', detail: errMessage(err) });
    }
  }

  // Step 6: memory consolidation. Independent of the judge/expression outcome —
  // runs even if those failed.
  if (done('memory')) {
    steps.push({ step: 'memory', status: 'skipped', detail: 'already completed for this window' });
  } else {
    try {
      const cur = await deps.readMemory(personalityId);
      const next = await deps.consolidate({
        memory: cur.memory,
        user: cur.user,
        recentContext: evidence.evidenceDigest,
      });

      // Decay-aware path (M3): requires a scored result AND the sidecar deps.
      // A scoring failure (unstructured/garbage response) or an unwired sidecar
      // degrades to the whole-file no-decay path — never "archive everything".
      let updates: MemoryUpdate[];
      let detailSuffix = '';
      if (next.scored && deps.readMemoryMeta && deps.writeMemoryMeta) {
        const meta = await deps.readMemoryMeta(personalityId);
        const now = deps.now?.() ?? Date.now();
        const plan = planConsolidation({
          current: cur,
          result: next,
          meta,
          params: resolveDecayParams(deps.memoryDecay, now),
        });
        updates = plan.updates;
        // Single writer: only the nightly pass persists the sidecar.
        await deps.writeMemoryMeta(personalityId, plan.nextMeta);
        if (plan.archivedSlugs.length > 0) detailSuffix = `, archived ${plan.archivedSlugs.length}`;
        if (plan.userRemovedSlugs.length > 0) {
          detailSuffix += `, reconciled ${plan.userRemovedSlugs.length} user-removed`;
          await deps.onSidecarReconciled?.(personalityId, {
            userRemovedSlugs: plan.userRemovedSlugs,
            before: meta,
            after: plan.nextMeta,
          });
        }
      } else {
        updates = buildConsolidationUpdates(cur, next);
      }

      if (updates.length) {
        await deps.applyMemoryUpdates(personalityId, updates);
        steps.push({
          step: 'memory',
          status: 'ran',
          detail: `${updates.length} update(s)${detailSuffix}`,
        });
      } else {
        steps.push({ step: 'memory', status: 'noop', detail: '0 updates' });
      }
      await markDone('memory');
    } catch (err) {
      steps.push({ step: 'memory', status: 'failed', detail: errMessage(err) });
    }
  }

  deps.log?.(
    `nightly pass for ${personalityId} (window ${evidence.windowEnd}): ${steps.length} steps`,
  );

  return { personalityId, windowEnd: evidence.windowEnd, steps };
}
