import { z } from 'zod';

// ---------------------------------------------------------------------------
// Kanban — Plan B Control Center surface
//
// Wire-format mirrors of `@ethosagent/kanban-store` types, with epoch-ms
// timestamps converted to ISO-8601 strings and snake_case columns mapped to
// camelCase for the client. Mutations route through the server (the human
// "actor" is `human:<sessionLabel>`).
// ---------------------------------------------------------------------------

export const KanbanTaskStatusSchema = z.enum([
  'todo',
  'ready',
  'running',
  'blocked',
  'done',
  'archived',
  'scheduled',
  'failed',
  'needs_revision',
]);
export type KanbanTaskStatus = z.infer<typeof KanbanTaskStatusSchema>;

export const KanbanTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  status: KanbanTaskStatusSchema,
  assignee: z.string().nullable(),
  priority: z.number().int(),
  workspaceMode: z.enum(['scratch', 'worktree', 'dir']),
  workspacePath: z.string().nullable(),
  scheduledFor: z.string().nullable(), // ISO-8601
  currentRunId: z.string().nullable(),
  /** Times the task has been re-claimed after a prior run ended. */
  retryCount: z.number().int().nonnegative(),
  /** Retry budget; `null` = unlimited. */
  maxRetries: z.number().int().nonnegative().nullable(),
  /** Acceptance criteria a `before_ticket_complete` verifier checks; `null` = none set. */
  acceptanceCriteria: z.string().nullable(),
  createdAt: z.string(), // ISO-8601
  updatedAt: z.string(), // ISO-8601
});
export type KanbanTask = z.infer<typeof KanbanTaskSchema>;

export const KanbanCommentSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  author: z.string(),
  body: z.string(),
  createdAt: z.string(), // ISO-8601
});
export type KanbanComment = z.infer<typeof KanbanCommentSchema>;

export const KanbanRunSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  startedAt: z.string(), // ISO-8601
  endedAt: z.string().nullable(), // ISO-8601
  outcome: z.enum(['completed', 'blocked', 'stalled', 'cancelled']).nullable(),
  summary: z.string().nullable(),
  lastHeartbeatAt: z.string(), // ISO-8601
  completedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
});
export type KanbanRun = z.infer<typeof KanbanRunSchema>;

export const KanbanEventSchema = z.object({
  id: z.number().int(),
  taskId: z.string(),
  kind: z.enum([
    'created',
    'status_changed',
    'commented',
    'assigned',
    'linked',
    'unlinked',
    'run_started',
    'run_completed',
    'heartbeat',
    'archived',
  ]),
  actor: z.string(),
  data: z.record(z.string(), z.unknown()),
  createdAt: z.string(), // ISO-8601
});
export type KanbanEvent = z.infer<typeof KanbanEventSchema>;

export const KanbanLinkSchema = z.object({
  parentId: z.string(),
  childId: z.string(),
});
export type KanbanLink = z.infer<typeof KanbanLinkSchema>;

export const KanbanTeamSummarySchema = z.object({
  name: z.string(),
  description: z.string(),
  dispatchMode: z.enum(['coordinator', 'self-routing', 'broadcast']),
  /** Health label derived from the runtime file: `running`, `stopped`, `stale`. */
  health: z.enum(['running', 'stopped', 'stale']),
  memberCount: z.number().int().nonnegative(),
  /** Members whose runtime status is `running`. */
  runningCount: z.number().int().nonnegative(),
  /** ISO-8601 mtime of the board.db, or null when no board exists. */
  boardModifiedAt: z.string().nullable(),
});
export type KanbanTeamSummary = z.infer<typeof KanbanTeamSummarySchema>;

export const KanbanMemberStatsSchema = z.object({
  teamId: z.string(),
  memberId: z.string(),
  /** Tasks this member completed (`done`). */
  ticketsCompleted: z.number().int().nonnegative(),
  /** Tasks that ended `failed` or `needs_revision` while claimed by this member. */
  ticketsFailed: z.number().int().nonnegative(),
  /** Tasks whose claim by this member was reclaimed by another agent. */
  ticketsOrphaned: z.number().int().nonnegative(),
  /** ISO-8601 timestamp of the most recent counter bump. */
  lastUpdatedAt: z.string(),
});
export type KanbanMemberStats = z.infer<typeof KanbanMemberStatsSchema>;

export const KanbanBoardSnapshotSchema = z.object({
  team: KanbanTeamSummarySchema,
  tasks: z.array(KanbanTaskSchema),
  links: z.array(KanbanLinkSchema),
  /** Most-recent events, oldest→newest, capped at 100. */
  recentEvents: z.array(KanbanEventSchema),
  /** Per-member work-outcome stats for the team. Empty on solo boards. */
  memberStats: z.array(KanbanMemberStatsSchema),
});
export type KanbanBoardSnapshot = z.infer<typeof KanbanBoardSnapshotSchema>;

export const KanbanAgentSchema = z.object({
  personalityId: z.string(),
  displayName: z.string(),
  agentId: z.string(),
  online: z.boolean(),
});
export type KanbanAgent = z.infer<typeof KanbanAgentSchema>;

// ---------------------------------------------------------------------------
// Teams — the team altitude (plan/phases/teams-as-a-scope.md §7, §9)
//
// A team as the browser sees it: the kanban summary plus what the manifest
// and `<team>.runtime.json` say about its members. Everything here is derived
// from files the supervisor already writes; nothing is stored for the UI.
// ---------------------------------------------------------------------------

/** `MemberStatus` from the runtime file, plus `offline` for "not in it". */
export const TeamMemberStatusSchema = z.enum([
  'starting',
  'running',
  'degraded',
  'restarting',
  'failed',
  'stopped',
  'offline',
]);
export type TeamMemberStatus = z.infer<typeof TeamMemberStatusSchema>;

export const TeamMemberSummarySchema = z.object({
  personalityId: z.string(),
  role: z.enum(['coordinator', 'member']),
  /** Autonomy tier from the board's member stats; null when the team has no board yet. */
  tier: z.enum(['probationary', 'standard', 'trusted']).nullable(),
  /** From the runtime file; `offline` when the team is not started or the member is absent. */
  status: TeamMemberStatusSchema,
  capabilities: z.array(z.string()),
});
export type TeamMemberSummary = z.infer<typeof TeamMemberSummarySchema>;

export const TeamChannelSchema = z.object({
  platform: z.string(),
  botKey: z.string(),
});
export type TeamChannel = z.infer<typeof TeamChannelSchema>;

export const TeamSummarySchema = KanbanTeamSummarySchema.extend({
  /** `manifest.coordinator ?? members[0]`; null for an empty broadcast/self-routing team. */
  coordinator: z.string().nullable(),
  members: z.array(TeamMemberSummarySchema),
  channels: z.array(TeamChannelSchema),
  /** ISO-8601 supervisor start time from the runtime file; null when stopped. */
  startedAt: z.string().nullable(),
});
export type TeamSummary = z.infer<typeof TeamSummarySchema>;

export const TeamTrustPolicySchema = z.object({
  mode: z.enum(['flat', 'tiered']),
  thresholds: z
    .object({
      standard_min_completed: z.number().int().nonnegative().optional(),
      standard_min_ratio: z.number().min(0).max(1).optional(),
      trusted_min_completed: z.number().int().nonnegative().optional(),
      trusted_min_ratio: z.number().min(0).max(1).optional(),
    })
    .optional(),
});
export type TeamTrustPolicy = z.infer<typeof TeamTrustPolicySchema>;

export const TeamRuntimeSchema = z.object({
  supervisorPid: z.number().int(),
  startedAt: z.string(),
  members: z.array(
    z.object({
      personality: z.string(),
      port: z.number().int(),
      pid: z.number().int().nullable(),
      status: z.string(),
      failureCount: z.number().int(),
    }),
  ),
});
export type TeamRuntimeView = z.infer<typeof TeamRuntimeSchema>;

export const TeamDetailSchema = TeamSummarySchema.extend({
  /** The manifest source file, verbatim — not a re-serialisation. */
  manifestYaml: z.string(),
  manifestPath: z.string(),
  trustPolicy: TeamTrustPolicySchema.nullable(),
  /** Dispatcher tuning with the supervisor's defaults filled in. */
  kanban: z.object({
    staleMs: z.number().int(),
    pollMs: z.number().int(),
    stalenessThresholdMs: z.number().int(),
  }),
  /** Team-memory topic names (`<topic>.md` under `teams/<name>/memory/`, without the suffix). */
  memoryTopics: z.array(z.string()),
  runtime: TeamRuntimeSchema.nullable(),
});
export type TeamDetail = z.infer<typeof TeamDetailSchema>;

export const LedgerSeveritySchema = z.enum(['ok', 'warn', 'err', 'info', 'dim']);
export type LedgerSeverity = z.infer<typeof LedgerSeveritySchema>;

/** One supervisor-voiced line derived from a `task_events` row (§7). */
export const LedgerEventSchema = z.object({
  /** The underlying `task_events.id`. */
  id: z.number().int(),
  at: z.string(), // ISO-8601
  kind: z.string(),
  taskId: z.string().nullable(),
  taskTitle: z.string().nullable(),
  personalityId: z.string().nullable(),
  headline: z.string(),
  detail: z.string(),
  severity: LedgerSeveritySchema,
});
export type LedgerEvent = z.infer<typeof LedgerEventSchema>;
