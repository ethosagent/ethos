import { EthosError, type EthosErrorCode } from '@ethosagent/types';
import type {
  LearningCandidateView,
  LearningReplayReportView,
  LearningTimelineEntryView,
} from '@ethosagent/web-contracts';
import { LearningCandidateStatusSchema } from '@ethosagent/web-contracts';
import {
  AWAITING_DECISION,
  type CandidateStatus,
  type LearningCandidate,
  type LearningCandidateDetail,
  type LearningInbox,
  type LearningInboxRefusal,
  type LearningInboxResult,
  type ReplayReport,
} from '@ethosagent/wiring';

// The web half of the learning review inbox (plan `trust-before-reach.md`
// Part 4, L-T8).
//
// Thin by construction, like `OutboxService`. The inbox it wraps
// (`LearningInbox`, `extensions/learning-inbox/src/inbox.ts`, built by wiring's
// `createLearningInbox`) owns every rule a decision is subject to:
//
//   - the override rule — `approve` on a verdict other than `pass`, a
//     never-replayed candidate included, refuses `override_required` without a
//     reason. Enforced in `LearningInbox.approve`, so the RPC, the legacy
//     `personalities.applyExpression` / `skillCandidateApprove` and
//     `evolver.pendingApprove` adapters below cannot each get it differently;
//   - one `recordSafetyApproval` row per decision (`learning.approve|override|
//     reject|rollback`, X-D11). This service writes NO audit rows of its own —
//     a second writer would double every decision in `ethos audit decisions`;
//   - the one-time legacy queue drain, run on first use, so a web-only
//     deployment's inbox is not empty.
//
// What is left here is wire mapping, and the adapters the legacy procedures use.

const DEFAULT_LIMIT = 200;

/**
 * Every status, derived from the WIRE enum. The `satisfies` fails to typecheck
 * when the wire enum names a status the store does not know; `toCandidateView`
 * assigning the store's `status` into the wire type fails when the store gains
 * one the wire does not. Together they pin the two in both directions.
 */
const ALL_STATUSES = LearningCandidateStatusSchema.options satisfies readonly CandidateStatus[];

export type LearningServiceResult<T> = LearningInboxResult<T>;
export type LearningRefusalCode = LearningInboxRefusal;

export interface LearningServiceOptions {
  inbox: LearningInbox;
}

export interface LearningDetailView {
  candidate: LearningCandidateView;
  current: { content: string | null; core: string | null };
  replay: LearningReplayReportView | null;
  replayRunIds: string[];
  timeline: LearningTimelineEntryView[];
  rollback: { allowed: boolean; code: string | null; reason: string | null };
}

export type LearningPromotion = NonNullable<LearningCandidateDetail['promotion']>;

export interface LearningReplayResultView {
  candidate: LearningCandidateView;
  replay: LearningReplayReportView;
  promoted: boolean;
  decisionReason: string | null;
}

export class LearningService {
  constructor(private readonly opts: LearningServiceOptions) {}

  async list(
    input: {
      personalityId?: string | undefined;
      kind?: LearningCandidate['kind'] | undefined;
      statuses?: readonly CandidateStatus[] | undefined;
      limit?: number | undefined;
    } = {},
  ): Promise<{ candidates: LearningCandidateView[] }> {
    const rows = await this.opts.inbox.list({
      ...(input.personalityId ? { personalityId: input.personalityId } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      status: input.statuses ?? ALL_STATUSES,
    });
    return { candidates: rows.slice(0, input.limit ?? DEFAULT_LIMIT).map(toCandidateView) };
  }

  async get(candidateId: string): Promise<LearningServiceResult<LearningDetailView>> {
    const result = await this.opts.inbox.get(candidateId);
    if (!result.ok) return result;
    const d = result.value;
    return {
      ok: true,
      value: {
        candidate: toCandidateView(d.candidate),
        current: d.current,
        replay: d.replay ? toReplayView(d.replay) : null,
        replayRunIds: d.replayRunIds,
        timeline: d.timeline.map(toTimelineView),
        rollback: d.rollback.allowed
          ? { allowed: true, code: null, reason: null }
          : { allowed: false, code: d.rollback.code, reason: d.rollback.reason },
      },
    };
  }

  async replay(candidateId: string): Promise<LearningServiceResult<LearningReplayResultView>> {
    const result = await this.opts.inbox.replay(candidateId);
    if (!result.ok) return result;
    const r = result.value;
    const promoted = r.promotion?.ok === true;
    return {
      ok: true,
      value: {
        candidate: toCandidateView(r.candidate),
        replay: toReplayView(r.report),
        promoted,
        decisionReason: promoted
          ? null
          : r.promotion && !r.promotion.ok
            ? r.promotion.reason
            : r.decision.reason,
      },
    };
  }

  async approve(input: {
    candidateId: string;
    decidedBy: string;
    override?: { reason: string } | undefined;
  }): Promise<
    LearningServiceResult<{ candidate: LearningCandidateView; promotion: LearningPromotion }>
  > {
    const result = await this.opts.inbox.approve(input.candidateId, {
      actor: 'web',
      decidedBy: input.decidedBy,
      override: input.override,
    });
    if (!result.ok) return result;
    return {
      ok: true,
      value: { candidate: toCandidateView(result.value.candidate), promotion: result.value.record },
    };
  }

  async reject(input: {
    candidateId: string;
    decidedBy: string;
    reason?: string | undefined;
  }): Promise<LearningServiceResult<{ candidate: LearningCandidateView }>> {
    const result = await this.opts.inbox.reject(input.candidateId, {
      actor: 'web',
      decidedBy: input.decidedBy,
      reason: input.reason,
    });
    if (!result.ok) return result;
    return { ok: true, value: { candidate: toCandidateView(result.value) } };
  }

  async rollback(input: {
    candidateId: string;
    decidedBy: string;
    reason?: string | undefined;
  }): Promise<LearningServiceResult<{ candidate: LearningCandidateView }>> {
    const result = await this.opts.inbox.rollback(input.candidateId, {
      actor: 'web',
      decidedBy: input.decidedBy,
      reason: input.reason,
    });
    if (!result.ok) return result;
    return { ok: true, value: { candidate: toCandidateView(result.value) } };
  }

  // -- Legacy adapters ------------------------------------------------------
  // `personalities.skillCandidate*`, `personalities.applyExpression` and
  // `evolver.pending*` predate the inbox. They keep their wire shapes and
  // decide through the SAME `LearningInbox` calls as the RPCs above.

  /** Skill candidates still waiting for a decision, newest first. */
  pendingSkills(personalityId?: string): Promise<LearningCandidate[]> {
    return this.opts.inbox.list({
      kind: 'skill',
      status: AWAITING_DECISION,
      ...(personalityId ? { personalityId } : {}),
    });
  }

  /** A waiting skill candidate by id, or by its destination filename. */
  resolveSkill(
    ref: string,
    personalityId?: string,
  ): Promise<LearningServiceResult<LearningCandidate>> {
    return this.opts.inbox.resolve(ref, {
      kind: 'skill',
      ...(personalityId ? { personalityId } : {}),
    });
  }
}

/**
 * A refusal as the `EthosError` a legacy procedure throws. The RPCs in
 * `rpc/learning.ts` map codes to typed oRPC errors instead; the legacy
 * procedures predate those codes and keep the error envelope they always had.
 */
export function learningRefusalError(
  refusal: { code: LearningRefusalCode; reason: string },
  action: string,
  notFoundCode: EthosErrorCode = 'SKILL_NOT_FOUND',
): EthosError {
  const code: EthosErrorCode =
    refusal.code === 'not_found'
      ? notFoundCode
      : refusal.code === 'replay_unavailable'
        ? 'NOT_CONFIGURED'
        : 'INVALID_INPUT';
  return new EthosError({ code, cause: refusal.reason, action });
}

export function toCandidateView(c: LearningCandidate): LearningCandidateView {
  return {
    id: c.id,
    kind: c.kind,
    op: c.op,
    personalityId: c.personalityId,
    origin: c.origin,
    destination: c.destination,
    content: c.content,
    baseHash: c.baseHash,
    evidence: {
      sessionIds: [...c.evidence.sessionIds],
      taskIds: [...c.evidence.taskIds],
      digest: c.evidence.digest,
      ref: c.evidence.ref,
    },
    targetCaseIds: [...c.targetCaseIds],
    status: c.status,
    verdict: c.verdict,
    submittedAt: c.submittedAt,
    updatedAt: c.updatedAt,
  };
}

function toReplayView(r: ReplayReport): LearningReplayReportView {
  return {
    runId: r.runId,
    candidateId: r.candidateId,
    testedOn: r.testedOn,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    verdict: r.verdict,
    rules: { a: r.rules.a, b: r.rules.b, c: r.rules.c, d: r.rules.d },
    targetMeanDelta: r.targetMeanDelta,
    regressionMeanDelta: r.regressionMeanDelta,
    regressionsWorse: r.regressionsWorse,
    regressionCount: r.regressionCount,
    costUsd: r.costUsd,
    maxCostUsd: r.maxCostUsd,
    stopReason: r.stopReason,
    error: r.error,
    cases: r.cases.map((c) => ({
      caseId: c.caseId,
      role: c.role,
      source: c.source,
      sourceRef: c.sourceRef,
      prompt: c.prompt,
      baseline: c.baseline ? toArmView(c.baseline) : null,
      candidate: c.candidate ? toArmView(c.candidate) : null,
      delta: c.delta,
    })),
    skipped: r.skipped.map((s) => ({ caseId: s.caseId, reason: s.reason })),
    limitations: [...r.limitations],
  };
}

type ArmResult = NonNullable<ReplayReport['cases'][number]['baseline']>;

function toArmView(a: ArmResult): LearningReplayReportView['cases'][number]['baseline'] {
  return {
    arm: a.arm,
    text: a.text,
    plan: a.plan.map((p) => ({ toolCallId: p.toolCallId, toolName: p.toolName, args: p.args })),
    errors: a.errors.map((e) => ({ error: e.error, code: e.code })),
    halts: a.halts.map((h) => ({ kind: h.kind, rule: h.rule, message: h.message })),
    costUsd: a.costUsd,
    completed: a.completed,
    assertions: a.assertions.map((x) => ({ kind: x.kind, value: x.value, passed: x.passed })),
    score: a.score,
  };
}

function toTimelineView(e: LearningCandidateDetail['timeline'][number]): LearningTimelineEntryView {
  return {
    at: e.at,
    action: e.action,
    from: e.from ?? null,
    to: e.to ?? null,
    verdict: e.verdict ?? null,
    actor: e.actor ?? null,
    reason: e.reason ?? null,
  };
}
