/**
 * `@ethosagent/learning-inbox` — one queue for every learned change
 * (plan `trust-before-reach.md` Part 4).
 *
 * What ships here:
 *   1. The candidate store (`store.ts`), its audit log (`audit.ts`) and the
 *      one-time drain of the four queues it replaces (`import-legacy.ts`).
 *   2. Frozen replay cases (`cases.ts`) — the past tasks a candidate is
 *      measured against, written once so replay does not depend on
 *      `sessions.db` retention.
 *   3. The replay isolation layer (`overlay-storage.ts`) — the `Storage` a
 *      replay arm reads through: one shadowed path, and every write refused.
 *      The loop it decorates is assembled by
 *      `packages/wiring/src/learning-replay.ts` (L-T3), which is where the
 *      Expression shadow's bytes are computed.
 *   4. The replay runner and scorer (`replay.ts`, L-T4): case selection, a
 *      dry-run baseline arm and candidate arm per case, per-assertion scores,
 *      and the budget stop. The arm's loop arrives through `createArm`, since
 *      building an `AgentLoop` is wiring's job.
 *   5. The promotion rule (`verdict.ts`, L-T4) — pure: scores in,
 *      `pass` / `regress` / `incomplete` out.
 *   6. Promotion and rollback (`promote.ts`, L-T5) — the one path that changes a
 *      live skill file or an Expression, with its snapshot and refusals.
 *
 * Nothing submits candidates or runs replay on a schedule yet; rerouting the
 * seven learning paths through this package is L-T6.
 *
 * Dependencies are `@ethosagent/types`, `@ethosagent/eval-harness` (the scorers
 * and `collectDryRunPlan`, used directly by `replay.ts`), and one predicate from
 * `@ethosagent/safety-groundtruth` (`isCheckLine`). Still injected rather than
 * imported: `liveSkillDir` (`@ethosagent/skill-evolver`),
 * `checkSkillFrontmatter` (`@ethosagent/skills`) and the Expression registry
 * (`@ethosagent/personalities`), all through `PromoteDeps`. Once L-T6 lands those
 * packages call into this one, so importing them here would be a dependency
 * cycle.
 */

export {
  appendAudit,
  type LearningAuditAction,
  type LearningAuditEntry,
  readAudit,
} from './audit';
export {
  type AssertionKind,
  CASE_CONTEXT_MESSAGES,
  CASE_FREEZE_BATCH,
  CASE_POOL_CAP,
  type CaptureCasesOptions,
  type CaptureCasesResult,
  type CaseAssertion,
  type CaseSource,
  captureCases,
  caseFromEvalTask,
  caseFromKanbanTask,
  caseFromSessionTurn,
  caseIdFor,
  type EvalCaseTask,
  enforceCasePoolCap,
  freezeCase,
  isExcludedSessionKey,
  type KanbanCaseTask,
  LEARNING_EXCLUDED_KEY_PREFIXES,
  type LearningCase,
  listCases,
  readCase,
  type SessionCaseTurn,
} from './cases';
export {
  hasImportedLegacy,
  importLegacyQueues,
  type LegacyImportDeps,
  type LegacyImportResult,
  readTargetFile,
} from './import-legacy';
export { type OverlayShadow, OverlayStorage } from './overlay-storage';
export {
  auditPath,
  candidateDir,
  candidatePath,
  candidatesDir,
  casePath,
  casesDir,
  LEARNING_DIR,
  learningDir,
  legacyImportMarkerPath,
  replayRunIdFromFilename,
  replayRunPath,
} from './paths';
export {
  checkRollback,
  type ExpressionRevisions,
  type PromoteDeps,
  type PromoteOptions,
  type PromoteRefusal,
  type PromoteResult,
  type PromotionRecord,
  priorSnapshotPath,
  promote,
  promotionRecordPath,
  type RollbackCheck,
  type RollbackRefusal,
  type RollbackResult,
  readPromotionRecord,
  rollback,
  type SkillScope,
} from './promote';
export {
  type AssertionResult,
  type CreateReplayArm,
  type CreateReplayArmInput,
  MAX_CRITERIA_PER_CASE,
  newReplayRunId,
  REPLAY_DRY_RUN_MAX_TOOL_CALLS,
  REPLAY_LIMITATIONS,
  type ReplayArm,
  type ReplayArmResult,
  type ReplayArmRuntime,
  type ReplayBaseRunOptions,
  type ReplayCandidateDeps,
  type ReplayCaseResult,
  type ReplayReport,
  type ReplayStopReason,
  type ReplayTurnOptions,
  type RunReplayInput,
  replayCandidate,
  runReplay,
  type SelectedCase,
  type SkippedCase,
  selectReplayCases,
} from './replay';
export {
  type CandidateChange,
  type CandidateEvidence,
  type CandidateFilter,
  type CandidateKind,
  type CandidateOp,
  type CandidateOrigin,
  type CandidateStatus,
  type CandidateVerdict,
  type LearningCandidate,
  listCandidates,
  listReplayRunIds,
  newCandidateId,
  readCandidate,
  readReplayRun,
  type SubmitCandidateInput,
  sha256Hex,
  submitCandidate,
  updateCandidate,
  writeReplayRun,
} from './store';
export {
  type ArmOutcome,
  type CaseRole,
  computeVerdict,
  MAX_REPLAY_CASES,
  MAX_TARGET_CASES,
  MIN_REPLAY_CASES,
  type VerdictCase,
  type VerdictInput,
  type VerdictResult,
  type VerdictRules,
} from './verdict';
