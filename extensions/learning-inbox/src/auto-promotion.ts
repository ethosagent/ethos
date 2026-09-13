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
// Pinned by `__tests__/auto-promotion.test.ts`.

import { type PromoteDeps, type PromoteResult, promote, type SkillScope } from './promote';
import { type ReplayCandidateDeps, type ReplayReport, replayCandidate } from './replay';
import type { CandidateKind, CandidateVerdict, LearningCandidate } from './store';

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

/**
 * L-D3. Skills: `promotion` > `evolution_approval_mode` > global `autoApprove`
 * > review — the first knob that is SET decides, so an explicit `review` or
 * `user` on a personality beats a global `autoApprove: true`. Expression:
 * `evolution_approval_mode === 'auto'` only; the skill knobs do not reach it.
 */
export function resolveAutoPromotion(
  kind: CandidateKind,
  knobs: AutoPromotionKnobs,
): AutoPromotionMode {
  if (kind === 'expression') return knobs.approvalMode === 'auto' ? 'auto' : 'review';
  if (knobs.promotion !== undefined) return knobs.promotion;
  if (knobs.approvalMode !== undefined) return knobs.approvalMode === 'auto' ? 'auto' : 'review';
  return knobs.globalAutoApprove === true ? 'auto' : 'review';
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
  const decision = autoPromotionDecision({
    candidate,
    verdict: candidate.verdict,
    mode: resolveAutoPromotion(candidate.kind, policy.knobs),
    scope: policy.scope,
  });
  if (!decision.promote) return { candidate, report, decision, promotion: null };

  const promotion = await promote(deps.promote, candidateId, {
    actor: 'auto',
    reason: `replay ${report.runId}: pass`,
  });
  return {
    candidate: promotion.candidate ?? candidate,
    report,
    decision,
    promotion,
  };
}
