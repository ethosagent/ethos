import { oc } from '@orpc/contract';
import { z } from 'zod';
import {
  BatchRunInfoSchema,
  EvalRunInfoSchema,
  EvalScorerSchema,
  IdentityMapEntrySchema,
  KanbanAgentSchema,
  KanbanBoardSnapshotSchema,
  KanbanCommentSchema,
  KanbanRunSchema,
  KanbanTaskSchema,
  KanbanTaskStatusSchema,
  KanbanTeamSummarySchema,
  LedgerEventSchema,
  MemoryFileSchema,
  MemoryHistoryEntrySchema,
  MemoryHistorySourceSchema,
  MemoryStoreSchema,
  MeshAgentSchema,
  MeshRouteResultSchema,
  PendingMemorySchema,
  TeamDetailSchema,
  TeamSummarySchema,
} from '../schemas';

// ---------------------------------------------------------------------------
// Memory (v1)
//
// Two markdown files MarkdownFileMemoryProvider reads at agent-loop
// prefetch: MEMORY.md (rolling project context) and USER.md (who you
// are — persistent across sessions). The web tab is the editor for
// both. Vector-mode chunk CRUD lands later.
// ---------------------------------------------------------------------------

const MemoryListInput = z.object({
  personalityId: z.string().min(1),
  /** Page size. */
  limit: z.number().int().positive().optional(),
  /** Opaque cursor from the previous response's `nextCursor`. */
  cursor: z.string().optional(),
  /** When present and store is 'user', reads user-scoped memory. */
  userId: z.string().optional(),
});
const MemoryListOutput = z.object({
  items: z.array(MemoryFileSchema),
  nextCursor: z.string().nullable(),
});

const MemoryGetInput = z.object({
  store: MemoryStoreSchema,
  personalityId: z.string().min(1),
  /** When present and store is 'user', reads user-scoped memory. */
  userId: z.string().optional(),
});
const MemoryGetOutput = z.object({ file: MemoryFileSchema });

const MemoryWriteInput = z.object({
  store: MemoryStoreSchema,
  content: z.string(),
  personalityId: z.string().min(1),
  /** When present and store is 'user', writes user-scoped memory. */
  userId: z.string().optional(),
});
const MemoryWriteOutput = z.object({ file: MemoryFileSchema });

const MemoryListUsersOutput = z.object({
  users: z.array(IdentityMapEntrySchema),
});

// Timeline sub-view (pillar D, §5). Read-only over the personality-scoped
// provenance history; paginated newest-first with an opaque offset cursor so
// a 1k-entry history loads a page at a time.
const MemoryHistoryInput = z.object({
  personalityId: z.string().min(1),
  /** Filter to one memory file (e.g. `MEMORY.md`, `memory-archive.md`). */
  key: z.string().optional(),
  source: MemoryHistorySourceSchema.optional(),
  /** Lower time bound (epoch-ms, inclusive) — the start of the date range. */
  sinceMs: z.number().optional(),
  /** Upper time bound (epoch-ms, inclusive) — the end of the date range. */
  untilMs: z.number().optional(),
  /** Page size; max 200 to keep payloads bounded. Default 50. */
  limit: z.number().int().min(1).max(200).optional(),
  /** Opaque offset cursor from the previous response's `nextCursor`. */
  cursor: z.string().nullable().optional(),
});
const MemoryHistoryOutput = z.object({
  entries: z.array(MemoryHistoryEntrySchema),
  nextCursor: z.string().nullable(),
  /** Count of torn/malformed JSONL lines the tolerant reader skipped. */
  corruptLines: z.number(),
});

const MemoryHistoryBlobInput = z.object({
  personalityId: z.string().min(1),
  /** Content-address from a history entry's `blob` field. */
  blob: z.string().min(1),
});
const MemoryHistoryBlobOutput = z.object({
  /** Full pre-mutation content, or null when the blob is missing. */
  content: z.string().nullable(),
});

const MemoryRestoreInput = z.object({
  personalityId: z.string().min(1),
  /** Stable slug of the archived section to restore. */
  slug: z.string().min(1),
});
const MemoryRestoreOutput = z.object({
  ok: z.literal(true),
  /** The live file the section was restored into (e.g. `MEMORY.md`). */
  restoredTo: z.string(),
});

// Pending sub-view (approve-before-store, L3 §3b). Mirrors the skill-evolver
// pending contract: list the parked candidates for a personality's scope,
// approve (replay through durable memory under the original source + approvedBy)
// or reject (tombstone the fact-hash so capture never re-proposes it).
const MemoryPendingListInput = z.object({
  personalityId: z.string().min(1),
});
const MemoryPendingListOutput = z.object({ pending: z.array(PendingMemorySchema) });

const MemoryPendingActionInput = z.object({
  personalityId: z.string().min(1),
  /** Opaque queue id from a `pendingList` entry. */
  id: z.string().min(1),
});
const MemoryPendingActionOutput = z.object({ ok: z.literal(true) });

/** @stable v1 */
export const memory = {
  list: oc.input(MemoryListInput).output(MemoryListOutput),
  get: oc.input(MemoryGetInput).output(MemoryGetOutput),
  write: oc.input(MemoryWriteInput).output(MemoryWriteOutput),
  listUsers: oc.input(z.object({})).output(MemoryListUsersOutput),
  history: oc.input(MemoryHistoryInput).output(MemoryHistoryOutput),
  historyBlob: oc.input(MemoryHistoryBlobInput).output(MemoryHistoryBlobOutput),
  restore: oc.input(MemoryRestoreInput).output(MemoryRestoreOutput),
  pendingList: oc.input(MemoryPendingListInput).output(MemoryPendingListOutput),
  pendingApprove: oc.input(MemoryPendingActionInput).output(MemoryPendingActionOutput),
  pendingReject: oc.input(MemoryPendingActionInput).output(MemoryPendingActionOutput),
};

// ---------------------------------------------------------------------------
// Mesh (v0.5 — the swarm pillar)
//
// Read-only view of the agent-mesh registry (file-backed at
// ~/.ethos/mesh-registry.json). `routeTest` runs the mesh's own least-
// busy router against a capability so the user can verify discovery
// without dispatching real work.
// ---------------------------------------------------------------------------

const MeshListOutput = z.object({ agents: z.array(MeshAgentSchema) });

const MeshRouteTestInput = z.object({
  /** Capability the synthetic task should route to (e.g. `code`, `web`). */
  capability: z.string().min(1),
});
const MeshRouteTestOutput = MeshRouteResultSchema;

/** @experimental */
export const mesh = {
  list: oc.output(MeshListOutput),
  routeTest: oc.input(MeshRouteTestInput).output(MeshRouteTestOutput),
};

// ---------------------------------------------------------------------------
// Lab — Batch (v1)
//
// Submits the runner with a tasks JSONL string + concurrency, returns
// a run id. The frontend polls `batch.list` / `batch.get` for live
// progress. `batch.output` returns the on-disk Atropos JSONL as a
// string for download. Cancel deferred — re-running with the same id
// resumes via the runner's checkpoint mechanism.
// ---------------------------------------------------------------------------

const BatchListOutput = z.object({ runs: z.array(BatchRunInfoSchema) });

const BatchStartInput = z.object({
  /** Newline-delimited JSON; each line `{ id, prompt, personalityId? }`. */
  tasksJsonl: z.string().min(1),
  /** Default 4. Max 16 to keep a single-user local app polite. */
  concurrency: z.number().int().min(1).max(16).optional(),
  /** Personality id used for tasks that don't pin one. */
  defaultPersonalityId: z.string().optional(),
});
const BatchStartOutput = z.object({ run: BatchRunInfoSchema });

const BatchGetInput = z.object({ id: z.string() });
const BatchGetOutput = z.object({ run: BatchRunInfoSchema });

const BatchOutputInput = z.object({ id: z.string() });
const BatchOutputOutput = z.object({ content: z.string() });

/** @experimental */
export const batch = {
  list: oc.output(BatchListOutput),
  start: oc.input(BatchStartInput).output(BatchStartOutput),
  get: oc.input(BatchGetInput).output(BatchGetOutput),
  output: oc.input(BatchOutputInput).output(BatchOutputOutput),
};

// ---------------------------------------------------------------------------
// Lab — Eval (v1)
//
// Like batch, but with an expected JSONL + a scorer (defaults to
// `contains`). The runner's per-task scores land in the output file;
// `eval.get` surfaces the aggregate stats so the UI can render
// pass/fail counts + average score without parsing the JSONL.
// ---------------------------------------------------------------------------

const EvalListOutput = z.object({ runs: z.array(EvalRunInfoSchema) });

const EvalStartInput = z.object({
  tasksJsonl: z.string().min(1),
  /** Newline-delimited JSON: `{ id, expected, match? }`. */
  expectedJsonl: z.string().min(1),
  scorer: EvalScorerSchema.optional(),
  concurrency: z.number().int().min(1).max(16).optional(),
});
const EvalStartOutput = z.object({ run: EvalRunInfoSchema });

const EvalGetInput = z.object({ id: z.string() });
const EvalGetOutput = z.object({ run: EvalRunInfoSchema });

const EvalOutputInput = z.object({ id: z.string() });
const EvalOutputOutput = z.object({ content: z.string() });

/** @experimental */
export const evalNs = {
  list: oc.output(EvalListOutput),
  start: oc.input(EvalStartInput).output(EvalStartOutput),
  get: oc.input(EvalGetInput).output(EvalGetOutput),
  output: oc.input(EvalOutputInput).output(EvalOutputOutput),
};

// ---------------------------------------------------------------------------
// Kanban — Plan B Control Center surface
//
// Read-only for now (`list`, `getBoard`); mutations are deferred to a later
// pass so the Codex-driven correctness guarantees in `@ethosagent/kanban-store`
// stay the single source of truth. The board itself lives at
// `~/.ethos/teams/<name>/board.db`; the service opens it read-only.
// ---------------------------------------------------------------------------

const KanbanListOutput = z.object({ teams: z.array(KanbanTeamSummarySchema) });

const KanbanGetBoardInput = z.object({
  team: z.string().min(1),
});
const KanbanGetBoardOutput = z.object({ board: KanbanBoardSnapshotSchema });

const KanbanUpdateStatusInput = z.object({
  team: z.string().min(1),
  taskId: z.string().min(1),
  status: KanbanTaskStatusSchema,
  reason: z.string().optional(),
});
const KanbanUpdateStatusOutput = z.object({ task: KanbanTaskSchema });

const KanbanBulkUpdateStatusInput = z.object({
  team: z.string().min(1),
  taskIds: z.array(z.string().min(1)).min(1),
  status: KanbanTaskStatusSchema,
});
const KanbanBulkUpdateStatusOutput = z.object({ tasks: z.array(KanbanTaskSchema) });

const KanbanCreateTaskInput = z.object({
  team: z.string().min(1),
  title: z.string().min(1),
  body: z.string().optional(),
  priority: z.number().int().min(0).max(9).default(0),
  assignee: z.string().optional(),
  acceptanceCriteria: z.string().optional(),
});
const KanbanCreateTaskOutput = z.object({ task: KanbanTaskSchema });

const KanbanListAgentsInput = z.object({
  team: z.string().min(1),
});
const KanbanListAgentsOutput = z.object({ agents: z.array(KanbanAgentSchema) });

const KanbanAssignInput = z.object({
  team: z.string().min(1),
  taskId: z.string().min(1),
  assignee: z.string().min(1),
});
const KanbanAssignOutput = z.object({ task: KanbanTaskSchema });

const KanbanBulkAssignInput = z.object({
  team: z.string().min(1),
  taskIds: z.array(z.string().min(1)).min(1),
  assignee: z.string().min(1),
});
const KanbanBulkAssignOutput = z.object({ tasks: z.array(KanbanTaskSchema) });

const KanbanGetTaskInput = z.object({ team: z.string().min(1), taskId: z.string().min(1) });
const KanbanGetTaskOutput = z.object({
  task: KanbanTaskSchema,
  comments: z.array(KanbanCommentSchema),
  runs: z.array(KanbanRunSchema),
});
const KanbanAddCommentInput = z.object({
  team: z.string().min(1),
  taskId: z.string().min(1),
  body: z.string().min(1),
});
const KanbanAddCommentOutput = z.object({ comment: KanbanCommentSchema });

/** @experimental */
export const kanban = {
  list: oc.output(KanbanListOutput),
  getBoard: oc.input(KanbanGetBoardInput).output(KanbanGetBoardOutput),
  updateStatus: oc.input(KanbanUpdateStatusInput).output(KanbanUpdateStatusOutput),
  bulkUpdateStatus: oc.input(KanbanBulkUpdateStatusInput).output(KanbanBulkUpdateStatusOutput),
  createTask: oc.input(KanbanCreateTaskInput).output(KanbanCreateTaskOutput),
  listAgents: oc.input(KanbanListAgentsInput).output(KanbanListAgentsOutput),
  assign: oc.input(KanbanAssignInput).output(KanbanAssignOutput),
  bulkAssign: oc.input(KanbanBulkAssignInput).output(KanbanBulkAssignOutput),
  getTask: oc.input(KanbanGetTaskInput).output(KanbanGetTaskOutput),
  addComment: oc.input(KanbanAddCommentInput).output(KanbanAddCommentOutput),
};

// ---------------------------------------------------------------------------
// Teams — the team altitude (plan/phases/teams-as-a-scope.md §9)
//
// Read-only over the manifest, runtime file and board, plus thin wrappers
// over the team-scoped memory provider (`scopeId = team:<name>`). The
// supervisor ledger is a labelling of `task_events` rows, newest first.
// ---------------------------------------------------------------------------

const TeamsListOutput = z.object({ items: z.array(TeamSummarySchema) });

const TeamsGetInput = z.object({ team: z.string().min(1) });

const TeamsLedgerInput = z.object({
  team: z.string().min(1),
  /** Newest-first cap. */
  limit: z.number().int().min(1).max(200).default(50),
  /** Only lines that concern this member (the member sheet's filter). */
  personalityId: z.string().min(1).optional(),
});
const TeamsLedgerOutput = z.object({ items: z.array(LedgerEventSchema) });

/** A team-memory topic name: the file's basename without `.md`. */
const TeamMemoryKeySchema = z.string().regex(/^[A-Za-z0-9_-]+$/);

const TeamsMemoryListInput = z.object({ team: z.string().min(1) });
const TeamsMemoryListOutput = z.object({ items: z.array(z.object({ key: z.string() })) });

const TeamsMemoryReadInput = z.object({ team: z.string().min(1), key: TeamMemoryKeySchema });
/** `content` is `''` when the topic does not exist. */
const TeamsMemoryReadOutput = z.object({ key: z.string(), content: z.string() });

const TeamsMemoryWriteInput = z.object({
  team: z.string().min(1),
  key: TeamMemoryKeySchema,
  /** `add` appends, `replace` overwrites, `delete` removes the topic file. */
  action: z.enum(['add', 'replace', 'delete']),
  /** Required for `add` and `replace`. */
  content: z.string().optional(),
});
const TeamsMemoryWriteOutput = z.object({ ok: z.literal(true) });

/** @experimental */
export const teams = {
  list: oc.output(TeamsListOutput),
  get: oc.input(TeamsGetInput).output(TeamDetailSchema),
  ledger: oc.input(TeamsLedgerInput).output(TeamsLedgerOutput),
  memoryList: oc.input(TeamsMemoryListInput).output(TeamsMemoryListOutput),
  memoryRead: oc.input(TeamsMemoryReadInput).output(TeamsMemoryReadOutput),
  memoryWrite: oc.input(TeamsMemoryWriteInput).output(TeamsMemoryWriteOutput),
};
