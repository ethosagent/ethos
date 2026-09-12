/**
 * `@ethosagent/learning-inbox` — one queue for every learned change
 * (plan `trust-before-reach.md` Part 4).
 *
 * Two pieces ship here:
 *   1. The candidate store (`store.ts`), its audit log (`audit.ts`) and the
 *      one-time drain of the four queues it replaces (`import-legacy.ts`).
 *   2. Frozen replay cases (`cases.ts`) — the past tasks a candidate is
 *      measured against, written once so replay does not depend on
 *      `sessions.db` retention.
 *
 * The replay runner, scoring, promotion and rollback are L-T3 to L-T5 and are
 * not here yet. Nothing in this package promotes anything.
 *
 * Dependencies are `@ethosagent/types` and one predicate from
 * `@ethosagent/safety-groundtruth` (`isCheckLine`). Everything else — the
 * kanban store, the eval harness, the session store, `liveSkillDir` — arrives
 * as an injected function, so this package sits below all of them.
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
