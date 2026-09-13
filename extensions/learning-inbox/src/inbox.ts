// The review inbox (plan `trust-before-reach.md` Part 4, L-T8; Design §6).
//
// ONE service for every human decision about a learned change: list, get,
// replay, approve, reject, rollback. Every surface — the `learning.*` RPCs
// (`apps/web-api/src/services/learning.service.ts`), `ethos learning`
// (`apps/ethos/src/commands/learning.ts`), the chat tools `skills_pending_*`
// and every legacy verb (`ethos evolve apply|--approve|--reject`,
// `evolver.pending*`, `personalities.skillCandidate*`,
// `personalities.applyExpression`) — goes through this class, so the two rules
// below are enforced once and cannot drift between surfaces:
//
//   1. The override rule. `approve` on any verdict other than `pass` —
//      including a candidate that was never replayed (`verdict: null`) —
//      refuses with `override_required` unless `override.reason` is a
//      non-blank string. The reason is written to `audit.jsonl` on the
//      promotion's status line (`promote`'s `reason`). Enforced in `approve`.
//   2. One audit row per human decision (X-D11). A decision that LANDED writes
//      exactly one `recordSafetyApproval` row — `learning.approve`,
//      `learning.override`, `learning.reject` or `learning.rollback` — so
//      `ethos audit decisions` lists it beside Part 2's `outbox.*` rows. A
//      refusal writes none. Enforced in `recordDecision`; pinned by
//      `__tests__/inbox.test.ts`.
//
// What this class does NOT do, and who does (rule 12): promotion, its
// snapshot and its refusals are `promote.ts`; the replay and the auto decision
// are the injected `replay` (wiring's `createLearningReplayer`); the legacy
// queue drain is the injected `importLegacy` (wiring's
// `importLegacyLearningQueues`). Nothing here re-implements them.
//
// Refusals are RESULTS, not exceptions, the same contract `promote()` has: a
// surface maps `code` onto its own error vocabulary.
//
// LIMITATION (L-D10): the status checks here are check-then-write, exactly as
// `promote()`'s are. Two humans approving the same candidate at once can both
// pass the check; both transitions land in `audit.jsonl`.

import { basename } from 'node:path';
import type { Storage } from '@ethosagent/types';
import { type LearningAuditEntry, readAudit } from './audit';
import type { ReplayAndResolveResult } from './auto-promotion';
import {
  checkRollback,
  type PromoteDeps,
  type PromoteRefusal,
  type PromotionRecord,
  promote,
  type RollbackRefusal,
  readPromotionRecord,
  rollback,
} from './promote';
import type { ReplayReport } from './replay';
import {
  type CandidateFilter,
  type CandidateStatus,
  type LearningCandidate,
  listCandidates,
  listReplayRunIds,
  readCandidate,
  readReplayRun,
  sha256Hex,
  updateCandidate,
} from './store';

/** The four human decisions, and the audit code each one writes (X-D11). */
export const LEARNING_AUDIT_CODES = {
  approve: 'learning.approve',
  override: 'learning.override',
  reject: 'learning.reject',
  rollback: 'learning.rollback',
} as const;

export type LearningDecision = keyof typeof LEARNING_AUDIT_CODES;

/**
 * How a decision maps onto `recordSafetyApproval`'s three-value `decision`.
 * A rollback undoes an approval, so it reads `denied`, like a rejection. Nothing
 * here is `auto`: the one non-human promotion path is `replayAndResolve`, and
 * it is not a decision this class records.
 */
const AUDIT_DECISION: Record<LearningDecision, 'approved' | 'denied'> = {
  approve: 'approved',
  override: 'approved',
  reject: 'denied',
  rollback: 'denied',
};

/** An override, a rejection and a rollback are what an auditor scans for. */
const AUDIT_SEVERITY: Record<LearningDecision, 'info' | 'warn'> = {
  approve: 'info',
  override: 'warn',
  reject: 'warn',
  rollback: 'warn',
};

/**
 * The audit sink, declared structurally — `packages/wiring`'s
 * `EthosObservability` satisfies it, as it does `OutboxObservability`.
 */
export interface LearningObservability {
  recordSafetyApproval(opts: {
    decision: 'approved' | 'denied' | 'auto';
    severity?: 'info' | 'warn';
    code?: string;
    cause?: string;
    details?: Record<string, unknown>;
  }): void;
}

/** Statuses a human can still decide on. Also the "Needs review" + "Waiting for replay" groups. */
export const AWAITING_DECISION: readonly CandidateStatus[] = ['pending_replay', 'pending_review'];

/** Statuses a rejection may move a candidate out of. Rejecting only narrows. */
const REJECTABLE: readonly CandidateStatus[] = [
  'pending_replay',
  'pending_review',
  'invalid',
  'stale',
];

export type LearningInboxRefusal =
  | PromoteRefusal
  | RollbackRefusal
  /** Non-`pass` verdict (or never replayed) and no `override.reason`. */
  | 'override_required'
  | 'not_rejectable'
  | 'not_replayable'
  /** No replayer in this process (`learningReplay.enabled: false`, or no LLM). */
  | 'replay_unavailable'
  /** The replayer threw before it could record a scorecard. */
  | 'replay_failed'
  /** A legacy filename reference matched more than one waiting candidate. */
  | 'ambiguous';

export type LearningInboxResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: LearningInboxRefusal; reason: string };

/** What is live at the destination now — the left side of the diff. */
export interface CurrentContent {
  /** Skill: the live file's bytes. Expression: the current Expression region. Null when absent. */
  content: string | null;
  /** Expression only: the Core, shown greyed above the diff. Null for a skill. */
  core: string | null;
}

export interface LearningCandidateDetail {
  candidate: LearningCandidate;
  current: CurrentContent;
  /** The newest replay scorecard, or null when the candidate was never replayed. */
  replay: ReplayReport | null;
  /** Every replay run id, oldest first. */
  replayRunIds: string[];
  /** This candidate's lines of `audit.jsonl`, oldest first. */
  timeline: LearningAuditEntry[];
  promotion: PromotionRecord | null;
  /** Whether Rollback would proceed now, and why not (`checkRollback`). */
  rollback: { allowed: true } | { allowed: false; code: RollbackRefusal; reason: string };
}

/** Who decided. `actor` is the surface (`web`, `cli`, `chat`); `decidedBy` the tab or user label. */
export interface DecisionActor {
  actor: string;
  decidedBy: string;
}

export interface LearningInboxDeps {
  storage: Storage;
  dataDir: string;
  promote: PromoteDeps;
  /** Wiring's `createLearningReplayer`. Absent → `replay` refuses `replay_unavailable`. */
  replay?: (candidateId: string) => Promise<ReplayAndResolveResult>;
  /**
   * Wiring's `importLegacyLearningQueues`. Run once, on first use, so a
   * deployment that only ever runs web-api still drains the old queues. It is
   * idempotent by its own marker file; the memo here only saves the stat.
   */
  importLegacy?: () => Promise<unknown>;
  /** What is live now. Absent → the destination's raw bytes, no Core. */
  current?: (candidate: LearningCandidate) => Promise<CurrentContent>;
  observability?: LearningObservability;
}

export class LearningInbox {
  private imported: Promise<void> | null = null;

  constructor(private readonly deps: LearningInboxDeps) {}

  /** Newest first. */
  async list(filter?: CandidateFilter): Promise<LearningCandidate[]> {
    await this.ensureImported();
    return listCandidates(this.deps.storage, this.deps.dataDir, filter);
  }

  async get(candidateId: string): Promise<LearningInboxResult<LearningCandidateDetail>> {
    await this.ensureImported();
    const { storage, dataDir } = this.deps;
    const candidate = await readCandidate(storage, dataDir, candidateId);
    if (!candidate) return notFound(candidateId);

    const replayRunIds = await listReplayRunIds(storage, dataDir, candidateId);
    const latest = replayRunIds.at(-1);
    const replay = latest
      ? asReplayReport(await readReplayRun(storage, dataDir, candidateId, latest))
      : null;
    const check = await checkRollback(this.deps.promote, candidateId);
    return {
      ok: true,
      value: {
        candidate,
        current: await this.currentFor(candidate),
        replay,
        replayRunIds,
        timeline: await readAudit(storage, dataDir, { candidateId }),
        promotion: await readPromotionRecord(storage, dataDir, candidateId),
        rollback: check.ok
          ? { allowed: true }
          : { allowed: false, code: check.code, reason: check.reason },
      },
    };
  }

  /**
   * Find a waiting candidate by id, or — for the legacy verbs that were keyed
   * on a filename — by the basename of its destination. `ambiguous` when a
   * filename matches more than one, so a legacy verb never guesses.
   */
  async resolve(
    ref: string,
    filter: Omit<CandidateFilter, 'status'> = {},
  ): Promise<LearningInboxResult<LearningCandidate>> {
    await this.ensureImported();
    const byId = await this.readById(ref);
    if (byId && matches(byId, filter)) return { ok: true, value: byId };

    const fileName = ref.endsWith('.md') ? ref : `${ref}.md`;
    const waiting = await listCandidates(this.deps.storage, this.deps.dataDir, {
      ...filter,
      status: AWAITING_DECISION,
    });
    const hits = waiting.filter((c) => basename(c.destination) === fileName);
    const [only] = hits;
    if (hits.length === 1 && only) return { ok: true, value: only };
    if (hits.length > 1) {
      return {
        ok: false,
        code: 'ambiguous',
        reason: `${fileName} matches ${hits.length} waiting candidates (${hits.map((c) => c.id).join(', ')}); name one by id`,
      };
    }
    return notFound(ref);
  }

  /** Replay on demand (L-D9). The replayer may auto-promote under L-D3's resolver. */
  async replay(candidateId: string): Promise<LearningInboxResult<ReplayAndResolveResult>> {
    await this.ensureImported();
    const replay = this.deps.replay;
    if (!replay) {
      return {
        ok: false,
        code: 'replay_unavailable',
        reason:
          'Replay is not available in this process (learningReplay.enabled is false, or no LLM is configured)',
      };
    }
    const candidate = await readCandidate(this.deps.storage, this.deps.dataDir, candidateId);
    if (!candidate) return notFound(candidateId);
    if (!AWAITING_DECISION.includes(candidate.status)) {
      return {
        ok: false,
        code: 'not_replayable',
        reason: `Candidate is ${candidate.status}; only ${AWAITING_DECISION.join(' or ')} candidates are replayed`,
      };
    }
    try {
      return { ok: true, value: await replay(candidateId) };
    } catch (err) {
      return { ok: false, code: 'replay_failed', reason: messageOf(err) };
    }
  }

  /**
   * A human approval. The override rule lives HERE and nowhere else: a
   * verdict other than `pass` needs a non-blank `override.reason`.
   */
  async approve(
    candidateId: string,
    opts: DecisionActor & { override?: { reason: string } | undefined },
  ): Promise<LearningInboxResult<{ candidate: LearningCandidate; record: PromotionRecord }>> {
    await this.ensureImported();
    const current = await readCandidate(this.deps.storage, this.deps.dataDir, candidateId);
    if (!current) return notFound(candidateId);
    if (!AWAITING_DECISION.includes(current.status)) {
      return {
        ok: false,
        code: 'not_promotable',
        reason: `Candidate is ${current.status}; only ${AWAITING_DECISION.join(' or ')} candidates can be approved`,
      };
    }
    const overrideReason = opts.override?.reason.trim() ?? '';
    const passed = current.verdict === 'pass';
    if (!passed && overrideReason === '') {
      return {
        ok: false,
        code: 'override_required',
        reason: `Verdict is ${verdictLabel(current.verdict)}; approving a candidate that has not passed a replay needs an override reason`,
      };
    }

    const decision: LearningDecision = passed ? 'approve' : 'override';
    const result = await promote(this.deps.promote, candidateId, {
      actor: opts.actor,
      ...(decision === 'override'
        ? { reason: `override (verdict ${verdictLabel(current.verdict)}): ${overrideReason}` }
        : {}),
    });
    if (!result.ok) return { ok: false, code: result.code, reason: result.reason };

    this.recordDecision(decision, result.candidate, opts, {
      verdict: current.verdict,
      ...(decision === 'override' ? { overrideReason } : {}),
    });
    return { ok: true, value: { candidate: result.candidate, record: result.record } };
  }

  async reject(
    candidateId: string,
    opts: DecisionActor & { reason?: string | undefined },
  ): Promise<LearningInboxResult<LearningCandidate>> {
    await this.ensureImported();
    const current = await readCandidate(this.deps.storage, this.deps.dataDir, candidateId);
    if (!current) return notFound(candidateId);
    if (!REJECTABLE.includes(current.status)) {
      return {
        ok: false,
        code: 'not_rejectable',
        reason: `Candidate is ${current.status}; it can no longer be rejected`,
      };
    }
    const reason = opts.reason?.trim();
    const candidate = await updateCandidate(this.deps.storage, this.deps.dataDir, candidateId, {
      status: 'rejected',
      actor: opts.actor,
      ...(reason ? { reason } : {}),
    });
    this.recordDecision('reject', candidate, opts, reason ? { reason } : {});
    return { ok: true, value: candidate };
  }

  async rollback(
    candidateId: string,
    opts: DecisionActor & { reason?: string | undefined },
  ): Promise<LearningInboxResult<LearningCandidate>> {
    await this.ensureImported();
    const reason = opts.reason?.trim();
    const result = await rollback(this.deps.promote, candidateId, {
      actor: opts.actor,
      ...(reason ? { reason } : {}),
    });
    if (!result.ok) return { ok: false, code: result.code, reason: result.reason };
    this.recordDecision('rollback', result.candidate, opts, reason ? { reason } : {});
    return { ok: true, value: result.candidate };
  }

  // -- internals ------------------------------------------------------------

  private ensureImported(): Promise<void> {
    const run = this.deps.importLegacy;
    if (!run) return Promise.resolve();
    if (!this.imported) {
      this.imported = run().then(
        () => undefined,
        (err: unknown) => {
          // Not memoised on failure: the next call retries the drain.
          this.imported = null;
          throw err;
        },
      );
    }
    return this.imported;
  }

  /** A ref that is not a safe id is simply not an id — fall through to the filename match. */
  private async readById(ref: string): Promise<LearningCandidate | null> {
    try {
      return await readCandidate(this.deps.storage, this.deps.dataDir, ref);
    } catch {
      return null;
    }
  }

  private async currentFor(candidate: LearningCandidate): Promise<CurrentContent> {
    if (this.deps.current) return this.deps.current(candidate);
    return { content: await this.deps.storage.read(candidate.destination), core: null };
  }

  /**
   * ONE row per decision that landed. Fail-open, like `OutboxService.audit`: a
   * broken sink never undoes a decision the human already made.
   */
  private recordDecision(
    decision: LearningDecision,
    candidate: LearningCandidate,
    who: DecisionActor,
    extra: Record<string, unknown>,
  ): void {
    const obs = this.deps.observability;
    if (!obs) return;
    try {
      obs.recordSafetyApproval({
        decision: AUDIT_DECISION[decision],
        severity: AUDIT_SEVERITY[decision],
        code: LEARNING_AUDIT_CODES[decision],
        cause: `learning ${candidate.id}: ${decision} ${candidate.kind} for ${candidate.personalityId}`,
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
          actor: who.actor,
          decidedBy: who.decidedBy,
          ...extra,
        },
      });
    } catch {
      // Audit is fail-open.
    }
  }
}

function matches(candidate: LearningCandidate, filter: Omit<CandidateFilter, 'status'>): boolean {
  if (filter.personalityId && candidate.personalityId !== filter.personalityId) return false;
  if (filter.kind && candidate.kind !== filter.kind) return false;
  return true;
}

function notFound<T>(candidateId: string): LearningInboxResult<T> {
  return { ok: false, code: 'not_found', reason: `No such learning candidate: ${candidateId}` };
}

function verdictLabel(verdict: LearningCandidate['verdict']): string {
  return verdict ?? 'not run';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `replay-<runId>.json` is written by `replayCandidate` from a `ReplayReport`,
 * and `readReplayRun` hands it back as `unknown`. A file that does not carry
 * the fields a scorecard renders from is treated as absent, not trusted.
 */
function asReplayReport(raw: unknown): ReplayReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<ReplayReport>;
  if (
    typeof r.runId !== 'string' ||
    typeof r.verdict !== 'string' ||
    !Array.isArray(r.cases) ||
    !Array.isArray(r.limitations)
  ) {
    return null;
  }
  return raw as ReplayReport;
}
