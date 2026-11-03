import { z } from 'zod';

// ---------------------------------------------------------------------------
// Learning inbox — replay-gated learning (plan `trust-before-reach.md` Part 4)
//
// WIRE shapes, named `…View`, for the one review inbox every learned change
// waits in. The authoritative types live in `@ethosagent/learning-inbox`
// (`LearningCandidate`, `ReplayReport`, `LearningAuditEntry`). The enums below
// are pinned to that package by the COMPILER at
// `apps/web-api/src/services/learning.service.ts`: `ALL_STATUSES` feeds
// `options` into the inbox's status filter (a value here the store does not
// know fails to typecheck), and `toCandidateView` assigns the store's fields
// into these enums (a value the store gained and this did not fails too).
//
// Timestamps are ISO 8601 strings — the store writes them that way, and they
// are rendered as ages, not compared against ledger windows.
// ---------------------------------------------------------------------------

export const LearningCandidateKindSchema = z.enum(['skill', 'expression']);
export const LearningCandidateOpSchema = z.enum(['create', 'rewrite', 'update']);
export const LearningCandidateOriginSchema = z.enum([
  'fork',
  'nightly',
  'chat',
  'eval',
  'web',
  'cli',
  'legacy',
]);
export const LearningCandidateStatusSchema = z.enum([
  'pending_replay',
  'pending_review',
  'promoted',
  'rejected',
  'rolled_back',
  'invalid',
  'stale',
]);
/** `incomplete` means the replay could not be scored, not that it failed. */
export const LearningVerdictSchema = z.enum(['pass', 'regress', 'incomplete']);

export const LearningCandidateViewSchema = z.object({
  id: z.string(),
  kind: LearningCandidateKindSchema,
  op: LearningCandidateOpSchema,
  personalityId: z.string(),
  origin: LearningCandidateOriginSchema,
  /** The live path the content lands on when promoted. */
  destination: z.string(),
  /** The proposed bytes: a whole skill file, or the new Expression region. */
  content: z.string(),
  /** sha256 of the live bytes when submitted; null for a create. */
  baseHash: z.string().nullable(),
  evidence: z.object({
    sessionIds: z.array(z.string()),
    taskIds: z.array(z.string()),
    digest: z.string().nullable(),
    ref: z.string().nullable(),
  }),
  targetCaseIds: z.array(z.string()),
  status: LearningCandidateStatusSchema,
  /** Null until a replay has run — "Not run" in the list. */
  verdict: LearningVerdictSchema.nullable(),
  submittedAt: z.string(),
  updatedAt: z.string(),
});
export type LearningCandidateView = z.infer<typeof LearningCandidateViewSchema>;

export const LearningAssertionResultViewSchema = z.object({
  kind: z.enum([
    'criteria',
    'contains',
    'regex',
    'exact',
    'tool_called',
    'tool_not_called',
    'completed',
  ]),
  value: z.string(),
  passed: z.boolean(),
});

export const LearningReplayArmViewSchema = z.object({
  arm: z.enum(['baseline', 'candidate']),
  text: z.string(),
  /** The dry-run tool plan: what the arm WOULD have called. Tools were stubbed. */
  plan: z.array(z.object({ toolCallId: z.string(), toolName: z.string(), args: z.unknown() })),
  errors: z.array(z.object({ error: z.string(), code: z.string() })),
  halts: z.array(
    z.object({ kind: z.enum(['budget', 'watcher']), rule: z.string(), message: z.string() }),
  ),
  costUsd: z.number(),
  completed: z.boolean(),
  assertions: z.array(LearningAssertionResultViewSchema),
  /** Assertions passed ÷ total, in [0, 1]. */
  score: z.number(),
});

export const LearningReplayCaseViewSchema = z.object({
  caseId: z.string(),
  role: z.enum(['target', 'regression']),
  source: z.enum(['kanban', 'eval', 'session']),
  sourceRef: z.string(),
  prompt: z.string(),
  baseline: LearningReplayArmViewSchema.nullable(),
  candidate: LearningReplayArmViewSchema.nullable(),
  /** candidate.score − baseline.score, when both arms ran. */
  delta: z.number().nullable(),
});

/** The scorecard. `limitations` carries the dry-run caveat (L-D4) — render it on every card. */
export const LearningReplayReportViewSchema = z.object({
  runId: z.string(),
  candidateId: z.string(),
  /** L-D11: the only personality this replay measured. */
  testedOn: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  verdict: LearningVerdictSchema,
  rules: z.object({ a: z.boolean(), b: z.boolean(), c: z.boolean(), d: z.boolean() }),
  targetMeanDelta: z.number().nullable(),
  regressionMeanDelta: z.number().nullable(),
  regressionsWorse: z.number(),
  regressionCount: z.number(),
  costUsd: z.number(),
  maxCostUsd: z.number(),
  stopReason: z.enum(['budget', 'error', 'insufficient_cases']).nullable(),
  error: z.string().nullable(),
  cases: z.array(LearningReplayCaseViewSchema),
  skipped: z.array(z.object({ caseId: z.string(), reason: z.string() })),
  limitations: z.array(z.string()),
});
export type LearningReplayReportView = z.infer<typeof LearningReplayReportViewSchema>;

/** One line of the candidate's `audit.jsonl` — the Timeline section. */
export const LearningTimelineEntryViewSchema = z.object({
  at: z.string(),
  action: z.string(),
  from: LearningCandidateStatusSchema.nullable(),
  to: LearningCandidateStatusSchema.nullable(),
  verdict: LearningVerdictSchema.nullable(),
  actor: z.string().nullable(),
  reason: z.string().nullable(),
});
export type LearningTimelineEntryView = z.infer<typeof LearningTimelineEntryViewSchema>;

// ---------------------------------------------------------------------------
// Amendments — a personality's request to change its own toolset (plan
// personality-memory-boundary-and-self-amendment G2), or its identity lines —
// name, vibe, emoji, avatar choice — in config.yaml (plan
// personality-presence-and-initiative §1, the birth ritual). Read-only on the
// web in v1 (D30): the owner applies, declines and rolls back from the CLI.
//
// These mirror `AmendmentRecord` and `AmendmentReview` from
// `@ethosagent/types` / `@ethosagent/wiring` field for field. Zod strips
// unknown keys, so a field the type gains and this schema lacks would vanish
// on the wire in silence; packages/web-contracts/src/__tests__/
// amendments-contract.test.ts round-trips a fully populated `AmendmentRecord`
// to catch that.
// ---------------------------------------------------------------------------

export const AmendmentStatusSchema = z.enum([
  'pending',
  'applied',
  'declined',
  'auto_rejected',
  'stale',
  'rolled_back',
]);
export type AmendmentStatusView = z.infer<typeof AmendmentStatusSchema>;

export const AmendmentFlagSchema = z.enum([
  'tool-unavailable',
  'no-recorded-refusal',
  'local-terminal',
  'high-risk',
  'team-workflow',
]);

export const AmendmentRecordViewSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  personalityId: z.string(),
  target: z.enum(['toolset', 'identity']),
  /** Toolset ops carry `tool`; identity ops carry `value` (`AmendmentOp`). */
  ops: z.array(
    z.union([
      z.object({ op: z.enum(['add_tool', 'remove_tool']), tool: z.string() }),
      z.object({
        op: z.enum(['set_name', 'set_description', 'set_display_emoji']),
        /** Written by the personality. Untrusted: render as text. */
        value: z.string(),
      }),
      z.object({ op: z.literal('set_display_avatar'), value: z.enum(['generated', 'upload']) }),
    ]),
  ),
  opsHash: z.string(),
  baseHash: z.string(),
  /** Written by the personality. Untrusted: render as text, never as markup. */
  rationale: z.string(),
  evidence: z.array(
    z.object({
      sessionId: z.string(),
      toolCallId: z.string(),
      toolName: z.string(),
      messageId: z.string(),
      /** Capped and redacted at filing. Untrusted text. */
      excerpt: z.string(),
    }),
  ),
  provenance: z.object({
    sessionId: z.string(),
    sessionKey: z.string(),
    platform: z.string(),
    origin: z.string().optional(),
    initiator: z.enum(['user', 'system']),
    roomAudience: z.enum(['private', 'shared']),
    turn: z.number().optional(),
    traceId: z.string().optional(),
    executionPosture: z.enum(['docker', 'ssh', 'local', 'none']),
    holdsShellTool: z.boolean(),
  }),
  preCheck: z.union([z.literal('ok'), z.object({ reason: z.string() })]),
  status: AmendmentStatusSchema,
  history: z.array(
    z.object({
      action: z.enum(['filed', 'auto_reject', 'approve', 'decline', 'stale', 'rollback']),
      actor: z.enum(['intake', 'cli', 'web']),
      decidedBy: z.string().optional(),
      at: z.string(),
      reason: z.string().optional(),
    }),
  ),
  applied: z.object({ appliedHash: z.string(), at: z.string() }).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AmendmentRecordView = z.infer<typeof AmendmentRecordViewSchema>;

/** One changed permission row (`PermissionChange`, extensions/personalities/src/permission-surface.ts). */
export const AmendmentPermissionChangeViewSchema = z.object({
  section: z.string(),
  field: z.string(),
  direction: z.enum(['widens', 'narrows', 'changes']),
  detail: z.string(),
  flag: z.enum(['high-risk', 'team-workflow']).optional(),
});

/**
 * What the reviewer sees (`AmendmentReview`, packages/wiring/src/amendments.ts),
 * recomputed from live state on every read. The raw live and after bytes are
 * left out: `textDiff` carries the change.
 */
export const AmendmentReviewViewSchema = z.object({
  record: AmendmentRecordViewSchema,
  /** The definition file the record's target writes. */
  file: z.enum(['toolset.yaml', 'config.yaml']),
  personality: z.enum(['ok', 'not_found', 'builtin']),
  liveHash: z.string().nullable(),
  stale: z.boolean(),
  interruptedApply: z.boolean(),
  opsProblem: z.string().optional(),
  expectedAfterHash: z.string().nullable(),
  /** `file`, live → after; each line prefixed `' '`, `'-'` or `'+'`. */
  textDiff: z.array(z.string()),
  permissionDiff: z
    .object({ changes: z.array(AmendmentPermissionChangeViewSchema), widens: z.boolean() })
    .nullable(),
  notCompared: z.string(),
  flags: z.array(AmendmentFlagSchema),
});
export type AmendmentReviewView = z.infer<typeof AmendmentReviewViewSchema>;
