import { z } from 'zod';

// ---------------------------------------------------------------------------
// Goals — convergence-loop execution
// ---------------------------------------------------------------------------

export const GoalStatusSchema = z.enum([
  'planning',
  'running',
  'judging',
  'retrying',
  'needs_clarification',
  'completed',
  'exhausted',
  'failed',
  'cancelled',
  'interrupted',
]);
export type GoalStatusWire = z.infer<typeof GoalStatusSchema>;

export const CriterionResultSchema = z.object({
  id: z.string(),
  pass: z.boolean().optional(),
  score: z.number().optional(),
  evidence: z.string(),
  gap: z.string().optional(),
});

export const VerdictSchema = z.object({
  score: z.number(),
  perCriterion: z.array(CriterionResultSchema),
});

export const GoalAttemptSchema = z.object({
  id: z.string(),
  goalId: z.string(),
  n: z.number().int(),
  sessionKey: z.string(),
  outputMd: z.string().nullable(),
  artifacts: z.unknown().nullable(),
  verdict: VerdictSchema.nullable(),
  strategyUsed: z.enum(['first', 'patch', 'pivot']),
  costUsd: z.number().nullable(),
  traceId: z.string().nullable(),
  startedAt: z.number(),
  completedAt: z.number().nullable(),
});
export type GoalAttemptWire = z.infer<typeof GoalAttemptSchema>;

export const GoalEventTypeSchema = z.enum([
  'run_start',
  'plan_start',
  'plan_ready',
  'attempt_start',
  'turn_text',
  'tool_start',
  'tool_end',
  'steer',
  'usage',
  'complete_attempt',
  'complete_rejected',
  'error',
  'done',
]);

export const GoalEventSchema = z.object({
  id: z.number().int(),
  goalId: z.string(),
  seq: z.number().int(),
  eventType: GoalEventTypeSchema,
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.number(),
});
export type GoalEventWire = z.infer<typeof GoalEventSchema>;

export const GoalSchema = z.object({
  id: z.string(),
  userId: z.string(),
  personalityId: z.string(),
  origin: z.string(),
  sourceSession: z.string().nullable(),
  title: z.string(),
  goalText: z.string(),
  acceptanceCriteria: z.unknown().nullable(),
  planMd: z.string().nullable(),
  status: GoalStatusSchema,
  maxAttempts: z.number().int(),
  maxCostUsd: z.number().nullable(),
  deadline: z.string().nullable(),
  outputMd: z.string().nullable(),
  outputPartial: z.string().nullable(),
  errorText: z.string().nullable(),
  startedAt: z.number(),
  completedAt: z.number().nullable(),
  resumeCount: z.number().int(),
  turnCount: z.number().int().nullable(),
  toolCount: z.number().int().nullable(),
  tokenCount: z.number().int().nullable(),
  costUsd: z.number().nullable(),
  maxToolCallsPerTurn: z.number().int().min(1).nullable().optional(),
  maxIdenticalToolCalls: z.number().int().min(1).nullable().optional(),
  allowDangerousToolCalls: z.boolean().nullable().optional(),
  maxRecoveryAttempts: z.number().int().min(0).nullable().optional(),
});
export type GoalWire = z.infer<typeof GoalSchema>;

// ---------------------------------------------------------------------------
// Background jobs — detached spawn-and-continue delegation (Tasks surface)
//
// Wire-format mirror of `@ethosagent/types` BackgroundJob / BackgroundJobEvent.
// Epoch-ms timestamps pass through as numbers (the Tasks page formats them
// client-side); optional columns are surfaced as `null` rather than absent.
// The `tasks` RPC namespace lists jobs, reads one job with its ordered event
// trail, and requests cancellation.
// ---------------------------------------------------------------------------

// `blocked` — the run is parked on a human answer. Non-terminal, still holding
// its concurrency slot, and never swept stale. Mirrors `BackgroundJobStatus`.
export const BackgroundJobStatusSchema = z.enum([
  'queued',
  'running',
  'blocked',
  'done',
  'failed',
  'aborted',
  'stale',
  'expired',
]);
export type BackgroundJobStatusWire = z.infer<typeof BackgroundJobStatusSchema>;

export const BackgroundJobEventTypeSchema = z.enum([
  'queued',
  'claimed',
  'running',
  'heartbeat',
  'spend',
  'cancel_requested',
  'tool_headline',
  'tool_end',
  'text',
  'blocked',
  'resumed',
  // One file a runner changed. Payload is an `ArtifactChange` — artifacts never
  // enter the AgentEvent stream, so this row IS the Diff tab's source.
  'artifact_change',
  // A batch of the runner subprocess's own stdout/stderr lines (I-LOG1).
  // Payload carries `lines` and an optional `dropped` count.
  'runner_log',
  // A steer was queued for the job (payload: steerId, chars, source).
  'steer',
  'done',
  'failed',
  'aborted',
  'stale',
  'expired',
  'recovered',
]);
export type BackgroundJobEventTypeWire = z.infer<typeof BackgroundJobEventTypeSchema>;

export const BackgroundJobEventSchema = z.object({
  id: z.number().int(),
  jobId: z.string(),
  seq: z.number().int(),
  eventType: BackgroundJobEventTypeSchema,
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.number(),
});
export type BackgroundJobEventWire = z.infer<typeof BackgroundJobEventSchema>;

export const BackgroundJobSummarySchema = z.object({
  id: z.string(),
  status: BackgroundJobStatusSchema,
  label: z.string().nullable(),
  personalityId: z.string().nullable(),
  spendUsd: z.number(),
  maxCostUsd: z.number().nullable(),
  depth: z.number().int(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  heartbeatAt: z.number().nullable(),
  owner: z.string(),
  rootSessionKey: z.string(),
  parentSessionKey: z.string(),
  /**
   * `JobRunner.name`. Null on rows written before the runner seam existed.
   *
   * On the SUMMARY (not just the detail) because `tasks.list` is what a
   * freshly-mounted chat page reads to rediscover the runs it was not
   * connected for, and a run card cannot draw its runner badge without it.
   */
  runner: z.string().nullable(),
});
export type BackgroundJobSummaryWire = z.infer<typeof BackgroundJobSummarySchema>;

/**
 * One row of the run card's session detail grid (pi-delegation §4.2/D18). The
 * UI owns the 12 shared rows; these are whatever `JobRunner.describe(job)`
 * returned, so a second harness adds its vocabulary without a component change.
 *
 * `tone` is a claim about the value, not decoration: `safe` is a fact something
 * enforces, `warn` is a claim nothing does. Mirrors `DetailRow` in
 * `@ethosagent/types`.
 */
export const RunDetailRowSchema = z.object({
  label: z.string(),
  value: z.string(),
  tone: z.enum(['accent', 'safe', 'warn']).optional(),
});
export type RunDetailRowWire = z.infer<typeof RunDetailRowSchema>;

/**
 * What a runner can actually do. Surfaces hide affordances a runner does not
 * support rather than offering a button that throws. Mirrors
 * `RunnerCapabilities` in `@ethosagent/types`; `interactionKinds` and
 * `answerScopes` are open strings by design (D16).
 */
export const RunnerCapabilitiesSchema = z.object({
  interactionKinds: z.array(z.string()),
  answerScopes: z.array(z.enum(['once', 'run', 'always'])),
  takeover: z.enum(['pty', 'none']),
  resume: z.enum(['session', 'fork', 'none']),
  steer: z.boolean(),
  sandbox: z.enum(['process', 'external', 'none']),
  transport: z.string(),
});
export type RunnerCapabilitiesWire = z.infer<typeof RunnerCapabilitiesSchema>;

/** Mirror of `@ethosagent/types` `JobSteer`. `pending` = queued, `read` = the run took it, `unread` = the run ended first. */
export const JobSteerSchema = z.object({
  id: z.number().int(),
  jobId: z.string(),
  text: z.string(),
  state: z.enum(['pending', 'read', 'unread']),
  source: z.enum(['cli', 'gateway', 'web', 'tool']),
  requesterUserId: z.string().nullable(),
  createdAt: z.number(),
  readAt: z.number().nullable(),
});
export type JobSteerWire = z.infer<typeof JobSteerSchema>;

export const BackgroundJobDetailSchema = BackgroundJobSummarySchema.extend({
  prompt: z.string(),
  summary: z.string().nullable(),
  error: z.string().nullable(),
  events: z.array(BackgroundJobEventSchema),
  // --- Run-card detail grid (pi-delegation §4.2). Everything below feeds a row
  // the card renders; none of it is read by the Tasks list.
  childSessionKey: z.string(),
  originPlatform: z.string().nullable(),
  originChatId: z.string().nullable(),
  /** The pending question a `blocked` run is parked on — same id space as `clarify.request`. */
  blockedRequestId: z.string().nullable(),
  /** `runner.describe(job)` output. Empty when the runner is not resolved in this process. */
  detailRows: z.array(RunDetailRowSchema),
  /** Null when the runner that executed this row is not resolved in this process. */
  capabilities: RunnerCapabilitiesSchema.nullable(),
  /** Every steer sent to this job, oldest first. Empty when the store has no steer queue. */
  steers: z.array(JobSteerSchema),
});
export type BackgroundJobDetailWire = z.infer<typeof BackgroundJobDetailSchema>;

// ---------------------------------------------------------------------------
// Digest — weekly governed-learning report (read-only)
//
// The CLI / cron writes Markdown to `~/.ethos/digests/<ISO-week>.md`.
// `digest.latest` returns the newest file's body, its `<ISO-week>` label
// (filename minus `.md`), and the file mtime as an ISO-8601 string.
// ---------------------------------------------------------------------------

export const DigestLatestSchema = z.object({
  /** Filename minus `.md`, e.g. `2026-W07`. */
  label: z.string(),
  /** Full Markdown body of the digest file. */
  markdown: z.string(),
  /** File mtime as ISO-8601. */
  generatedAt: z.string(),
});
export type DigestLatest = z.infer<typeof DigestLatestSchema>;
