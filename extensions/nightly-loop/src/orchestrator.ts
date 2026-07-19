// Nightly-pass orchestrator (Phase 3c, component E) — the pure, dependency-
// injected core of the nightly governed-learning pass.
//
// runNightlyPass() runs five ordered, individually-checkpointed steps for one
// personality: gather evidence → judge alignment → (maybe) evolve Expression →
// (maybe) create skills → consolidate memory. Every external effect is an
// injected plain function (NightlyPassDeps), so the pass is unit-testable with
// stubs — no AgentLoop, no real LLM, no Storage.
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
  applyExpression(
    id: string,
    newExpression: string,
    opts: { summary: string; evidenceRef: string },
  ): Promise<{ revisionId: string }>;
  createSkills?(id: string, evidence: NightlyEvidence): Promise<number>; // 3d hook; OPTIONAL — absent = step noop
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
        const applied = await deps.applyExpression(personalityId, draft.newExpression, {
          summary: draft.rationale.slice(0, 120) || 'nightly expression update',
          evidenceRef: `nightly:${result.alignmentScore.toFixed(2)}@${evidence.windowEnd}`,
        });
        steps.push({
          step: 'expression',
          status: 'ran',
          detail: `applied (alignment ${pct}%, revision ${applied.revisionId})`,
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
      steps.push({ step: 'skills', status: 'ran', detail: `${count} skill(s) created` });
      await markDone('skills');
    } catch (err) {
      steps.push({ step: 'skills', status: 'failed', detail: errMessage(err) });
    }
  } else {
    steps.push({ step: 'skills', status: 'noop', detail: 'skill creation deferred to 3d' });
    await markDone('skills');
  }

  // Step 5: memory consolidation. Independent of the judge/expression outcome —
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
