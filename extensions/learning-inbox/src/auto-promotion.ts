// The one auto resolver (plan `trust-before-reach.md` Part 4, L-D3) and the
// only non-human promotion path (L-D1, L-D11, L-D13).
//
// Before this there were three auto knobs, each read by a different writer:
// `skill_evolution.promotion` (nightly only), `evolution_approval_mode` (CLI
// evolve and the nightly skill fallback) and the global `evolve-config.json`
// `autoApprove` (the live fork only). `resolveAutoPromotion` reads all three in
// one precedence order, and `replayAndResolve` is the single place that turns
// "the resolver said auto" into a promotion.
//
// A promotion here needs ALL of (enforced by `autoPromotionDecision`):
//   1. a replay verdict of `pass` — a measurement of the change itself; an LLM
//      opinion never decides (L-D1);
//   2. the resolver answering `auto`;
//   3. a destination visible ONLY to the personality the replay ran on — a
//      skill with `skill_evolution.scope: personality`, or an Expression
//      (L-D11). Replay tests one personality; a shared skill runs on every
//      capability-matched one, so it always needs a human.
// Anything else leaves the candidate in `pending_review` for a human.
//
// Every promotion that lands here also writes ONE `learning.auto_promote`
// `recordSafetyApproval` row, attributed to the system, so `ethos audit
// decisions` lists the promotion no human made beside the ones a human did
// (X-D11). Written here, the one place automatic promotion happens, so the
// nightly step, `ethos learning replay` and the web's Run replay are all
// covered. A replay that does not promote, or a promotion `promote()` refuses,
// writes none.
//
// Pinned by `__tests__/auto-promotion.test.ts`.

import type { LearningObservability } from './inbox';
import { type PromoteDeps, type PromoteResult, promote, type SkillScope } from './promote';
import { type ReplayCandidateDeps, type ReplayReport, replayCandidate } from './replay';
import {
  type CandidateKind,
  type CandidateVerdict,
  type LearningCandidate,
  sha256Hex,
} from './store';

/** The audit code of an automatic promotion. Not one of `LEARNING_AUDIT_CODES`: no human decided it. */
export const LEARNING_AUTO_PROMOTE_CODE = 'learning.auto_promote';

export type AutoPromotionMode = 'auto' | 'review';

/** The three knobs, as the personality and the operator set them. */
export interface AutoPromotionKnobs {
  /** `PersonalityConfig.skill_evolution.promotion`. Skills only. */
  promotion?: 'review' | 'auto';
  /** `PersonalityConfig.evolution_approval_mode`. */
  approvalMode?: 'auto' | 'user';
  /** `~/.ethos/evolve-config.json` `autoApprove`. Skills only. */
  globalAutoApprove?: boolean;
}

/** The knob that decided, by its config name; `null` when none was set. */
export type AutoPromotionKnob =
  | 'skill_evolution.promotion'
  | 'evolution_approval_mode'
  | 'autoApprove'
  | null;

/**
 * L-D3, with the knob that decided. Skills: `promotion` >
 * `evolution_approval_mode` > global `autoApprove` > review — the first knob
 * that is SET decides, so an explicit `review` or `user` on a personality beats
 * a global `autoApprove: true`. Expression: `evolution_approval_mode === 'auto'`
 * only; the skill knobs do not reach it.
 */
export function explainAutoPromotion(
  kind: CandidateKind,
  knobs: AutoPromotionKnobs,
): { mode: AutoPromotionMode; knob: AutoPromotionKnob } {
  const byApprovalMode = {
    mode: knobs.approvalMode === 'auto' ? 'auto' : 'review',
    knob: 'evolution_approval_mode',
  } as const;
  if (kind === 'expression') {
    return knobs.approvalMode === undefined ? { mode: 'review', knob: null } : byApprovalMode;
  }
  if (knobs.promotion !== undefined) {
    return { mode: knobs.promotion, knob: 'skill_evolution.promotion' };
  }
  if (knobs.approvalMode !== undefined) return byApprovalMode;
  if (knobs.globalAutoApprove !== undefined) {
    return { mode: knobs.globalAutoApprove ? 'auto' : 'review', knob: 'autoApprove' };
  }
  return { mode: 'review', knob: null };
}

/** `explainAutoPromotion`'s mode alone. */
export function resolveAutoPromotion(
  kind: CandidateKind,
  knobs: AutoPromotionKnobs,
): AutoPromotionMode {
  return explainAutoPromotion(kind, knobs).mode;
}

export interface AutoPromotionDecision {
  promote: boolean;
  /** Why not, or `null` when it promotes. Recorded on the audit line. */
  reason: string | null;
}

/** The three conditions above. Pure. */
export function autoPromotionDecision(input: {
  candidate: Pick<LearningCandidate, 'kind' | 'personalityId'>;
  verdict: CandidateVerdict | null;
  mode: AutoPromotionMode;
  /** The personality's CURRENT `skill_evolution.scope`. Ignored for an Expression. */
  scope: SkillScope | undefined;
}): AutoPromotionDecision {
  if (input.verdict !== 'pass') {
    return { promote: false, reason: `verdict ${input.verdict ?? 'not run'}; needs a human` };
  }
  if (input.mode !== 'auto') {
    return { promote: false, reason: 'approval mode is review; needs a human' };
  }
  if (input.candidate.kind === 'skill' && input.scope !== 'personality') {
    return {
      promote: false,
      reason: `shared skill: tested on ${input.candidate.personalityId}, visible to every capability-matched personality; needs a human`,
    };
  }
  return { promote: true, reason: null };
}

export interface ReplayAndResolveDeps extends ReplayCandidateDeps {
  promote: PromoteDeps;
  /** The knobs and current scope for this candidate's personality. */
  policyFor(candidate: LearningCandidate): Promise<{
    knobs: AutoPromotionKnobs;
    scope: SkillScope | undefined;
  }>;
  /**
   * The `ethos audit decisions` sink. Absent (tests, or a host with no store)
   * → no `learning.auto_promote` row; the promotion itself is unaffected.
   */
  observability?: LearningObservability;
}

export interface ReplayAndResolveResult {
  candidate: LearningCandidate;
  report: ReplayReport;
  decision: AutoPromotionDecision;
  /** Set only when the decision was to promote. A refusal (`stale`, `invalid`) is returned here. */
  promotion: PromoteResult | null;
}

/**
 * Replay a candidate, then promote it only when `autoPromotionDecision` allows.
 * The caller decides WHEN this runs (L-D9: the nightly `replay` step, or
 * synchronously under `--auto-approve`; never on `agent_done`).
 */
export async function replayAndResolve(
  deps: ReplayAndResolveDeps,
  candidateId: string,
): Promise<ReplayAndResolveResult> {
  const { candidate, report } = await replayCandidate(deps, candidateId);
  const policy = await deps.policyFor(candidate);
  const resolved = explainAutoPromotion(candidate.kind, policy.knobs);
  const decision = autoPromotionDecision({
    candidate,
    verdict: candidate.verdict,
    mode: resolved.mode,
    scope: policy.scope,
  });
  if (!decision.promote) return { candidate, report, decision, promotion: null };

  const promotion = await promote(deps.promote, candidateId, {
    actor: 'auto',
    reason: `replay ${report.runId}: pass`,
  });
  if (promotion.ok) {
    recordAutoPromotion(deps, promotion.candidate, report, {
      knob: resolved.knob,
      scope: policy.scope,
    });
  }
  return {
    candidate: promotion.candidate ?? candidate,
    report,
    decision,
    promotion,
  };
}

/**
 * The why of an automatic promotion, in words: which knob said auto, and what
 * made the destination one only the replayed personality can see (L-D11).
 */
function autoPromotionReason(
  candidate: LearningCandidate,
  knob: AutoPromotionKnob,
  scope: SkillScope | undefined,
): string {
  const visibility =
    candidate.kind === 'expression'
      ? `an Expression, visible only to ${candidate.personalityId}`
      : `skill_evolution.scope: ${scope ?? 'shared'}, visible only to ${candidate.personalityId}`;
  return `${knob ?? 'no knob'} resolved auto; ${visibility}`;
}

/**
 * ONE `learning.auto_promote` row per automatic promotion that landed.
 * Fail-open, like `LearningInbox.recordDecision`: a broken sink never undoes a
 * promotion that already happened (it is in `audit.jsonl` either way).
 */
function recordAutoPromotion(
  deps: ReplayAndResolveDeps,
  candidate: LearningCandidate,
  report: ReplayReport,
  resolved: { knob: AutoPromotionKnob; scope: SkillScope | undefined },
): void {
  const obs = deps.observability;
  if (!obs) return;
  const reason = autoPromotionReason(candidate, resolved.knob, resolved.scope);
  try {
    obs.recordSafetyApproval({
      decision: 'auto',
      severity: 'info',
      code: LEARNING_AUTO_PROMOTE_CODE,
      cause: `learning ${candidate.id}: auto_promote ${candidate.kind} for ${candidate.personalityId} — ${reason}`,
      details: {
        candidateId: candidate.id,
        personalityId: candidate.personalityId,
        kind: candidate.kind,
        op: candidate.op,
        origin: candidate.origin,
        destination: candidate.destination,
        status: candidate.status,
        // The hash, never the content — the trail ships in support bundles.
        contentHash: sha256Hex(candidate.content),
        // Attributed to the system: no human decided this.
        actor: 'auto',
        decidedBy: 'system',
        // Which surface ran the replay (`nightly`, `cli`, `web`, `evolve`).
        trigger: deps.actor ?? 'replay',
        verdict: report.verdict,
        replayRunId: report.runId,
        reason,
        knob: resolved.knob,
        scope: candidate.kind === 'expression' ? null : (resolved.scope ?? null),
      },
    });
  } catch {
    // Audit is fail-open.
  }
}
