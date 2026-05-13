import { oc } from '@orpc/contract';
import { z } from 'zod';
import {
  ApiKeyMetadataSchema,
  ApiKeyScopeSchema,
  ApprovalScopeSchema,
  BatchRunInfoSchema,
  BotBindingSchema,
  CronJobSchema,
  CronRunSchema,
  EvalRunInfoSchema,
  EvalScorerSchema,
  EvolveConfigSchema,
  EvolverRunSchema,
  KanbanBoardSnapshotSchema,
  KanbanTaskSchema,
  KanbanTaskStatusSchema,
  KanbanTeamSummarySchema,
  McpServerInfoSchema,
  MemoryFileSchema,
  MemoryStoreSchema,
  MeshAgentSchema,
  MeshRouteResultSchema,
  MissedRunPolicySchema,
  OnboardingStepSchema,
  PendingSkillSchema,
  PersonalitySchema,
  PersonalitySkillSchema,
  PlatformIdSchema,
  PlatformStatusSchema,
  PluginInfoSchema,
  ProviderIdSchema,
  SessionSchema,
  SkillSchema,
  SlackAppEntrySchema,
  StoredMessageSchema,
  TelegramBotEntrySchema,
} from './schemas';

// oRPC contract — single source of truth for the web control plane.
// `apps/web-api` (server) calls `implement(contract)` against this.
// `apps/web` (client) calls `createORPCClient(link)` typed as
// `ContractRouterClient<typeof contract>`. Both ends fail to compile if the
// shapes drift.
//
// v0 surface: sessions / personalities (read-only) / chat / tools /
// onboarding / config. v0.5 (cron, skills, mesh) and v1 (memory, comms,
// plugins, settings, batch, eval) namespaces land in their own phases.

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const SessionListInput = z.object({
  /** Full-text query (FTS5). Empty / omitted returns recent sessions. */
  q: z.string().optional(),
  /** Page size; max 200 to keep payloads bounded. */
  limit: z.number().int().min(1).max(200).optional(),
  /** Opaque rowid cursor from the previous response's `nextCursor`. */
  cursor: z.string().nullable().optional(),
  personalityId: z.string().optional(),
});
const SessionListOutput = z.object({
  sessions: z.array(SessionSchema),
  nextCursor: z.string().nullable(),
});

const SessionGetInput = z.object({ id: z.string() });
const SessionGetOutput = z.object({
  session: SessionSchema,
  messages: z.array(StoredMessageSchema),
});

const SessionForkInput = z.object({
  id: z.string(),
  personalityId: z.string().optional(),
});
const SessionForkOutput = z.object({ session: SessionSchema });

const SessionDeleteInput = z.object({ id: z.string() });
const SessionDeleteOutput = z.object({ ok: z.literal(true) });

const SessionUpdateInput = z.object({
  id: z.string(),
  /** New human-readable title. Pass null to clear the title. */
  title: z.string().max(200).nullable(),
});
const SessionUpdateOutput = z.object({ session: SessionSchema });

/** @stable v1 */
const sessions = {
  list: oc.input(SessionListInput).output(SessionListOutput),
  get: oc.input(SessionGetInput).output(SessionGetOutput),
  fork: oc.input(SessionForkInput).output(SessionForkOutput),
  delete: oc.input(SessionDeleteInput).output(SessionDeleteOutput),
  update: oc.input(SessionUpdateInput).output(SessionUpdateOutput),
};

// ---------------------------------------------------------------------------
// Personalities (v0 read-only — create/edit lands in v1)
// ---------------------------------------------------------------------------

const PersonalityListOutput = z.object({
  personalities: z.array(PersonalitySchema),
  defaultId: z.string(),
});
const PersonalityGetInput = z.object({ id: z.string() });
const PersonalityGetOutput = z.object({
  personality: PersonalitySchema,
  /** Markdown body of ETHOS.md. Empty string when the file isn't present. */
  ethosMd: z.string(),
});

const PersonalityCharacterSheetInput = z.object({ id: z.string() });
const PersonalityCharacterSheetOutput = z.object({
  /** Generated Markdown character sheet — the same artifact `ethos personality
   *  show` prints. Regenerated on each call; see `renderCharacterSheet` in
   *  @ethosagent/personalities. */
  markdown: z.string(),
});

const PersonalityIdRegex = /^[a-z0-9_-]+$/;

const PersonalityCreateInput = z.object({
  /** Lowercase id; becomes the directory name. */
  id: z.string().min(1).regex(PersonalityIdRegex),
  name: z.string().min(1),
  description: z.string().optional(),
  model: z.string().optional(),
  toolset: z.array(z.string()),
  /** Markdown body of ETHOS.md. May be empty. */
  ethosMd: z.string(),
  memoryScope: z.enum(['global', 'per-personality']).optional(),
});
const PersonalityCreateOutput = z.object({ personality: PersonalitySchema });

const PersonalityUpdateInput = z.object({
  id: z.string().min(1),
  /** Patch — only present fields are written. */
  name: z.string().optional(),
  description: z.string().optional(),
  model: z.string().optional(),
  toolset: z.array(z.string()).optional(),
  ethosMd: z.string().optional(),
  memoryScope: z.enum(['global', 'per-personality']).optional(),
  mcp_servers: z.array(z.string()).optional(),
  plugins: z.array(z.string()).optional(),
});
const PersonalityUpdateOutput = z.object({ personality: PersonalitySchema });

const PersonalityDeleteInput = z.object({ id: z.string().min(1) });
const PersonalityOkOutput = z.object({ ok: z.literal(true) });

const PersonalityDuplicateInput = z.object({
  id: z.string().min(1),
  newId: z.string().min(1).regex(PersonalityIdRegex),
});
const PersonalityDuplicateOutput = z.object({ personality: PersonalitySchema });

// Per-personality skills (gate 19).
const PersonalitySkillsListInput = z.object({ personalityId: z.string().min(1) });
const PersonalitySkillsListOutput = z.object({ skills: z.array(PersonalitySkillSchema) });

const PersonalitySkillsGetInput = z.object({
  personalityId: z.string().min(1),
  skillId: z.string().min(1),
});
const PersonalitySkillsGetOutput = z.object({ skill: PersonalitySkillSchema });

const PersonalitySkillsCreateInput = z.object({
  personalityId: z.string().min(1),
  skillId: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_-]+$/),
  body: z.string(),
});
const PersonalitySkillsCreateOutput = z.object({ skill: PersonalitySkillSchema });

const PersonalitySkillsUpdateInput = z.object({
  personalityId: z.string().min(1),
  skillId: z.string().min(1),
  body: z.string(),
});
const PersonalitySkillsUpdateOutput = z.object({ skill: PersonalitySkillSchema });

const PersonalitySkillsDeleteInput = z.object({
  personalityId: z.string().min(1),
  skillId: z.string().min(1),
});

const PersonalitySkillsImportInput = z.object({
  personalityId: z.string().min(1),
  /** Global skill ids to copy from ~/.ethos/skills/<id>.md into the personality's skills/. */
  skillIds: z.array(z.string().min(1)),
});
const PersonalitySkillsImportOutput = z.object({ imported: z.array(PersonalitySkillSchema) });

/** @stable v1 — read-only at v1 */
const personalities = {
  list: oc.output(PersonalityListOutput),
  get: oc.input(PersonalityGetInput).output(PersonalityGetOutput),
  characterSheet: oc.input(PersonalityCharacterSheetInput).output(PersonalityCharacterSheetOutput),
  create: oc.input(PersonalityCreateInput).output(PersonalityCreateOutput),
  update: oc.input(PersonalityUpdateInput).output(PersonalityUpdateOutput),
  delete: oc.input(PersonalityDeleteInput).output(PersonalityOkOutput),
  duplicate: oc.input(PersonalityDuplicateInput).output(PersonalityDuplicateOutput),
  skillsList: oc.input(PersonalitySkillsListInput).output(PersonalitySkillsListOutput),
  skillsGet: oc.input(PersonalitySkillsGetInput).output(PersonalitySkillsGetOutput),
  skillsCreate: oc.input(PersonalitySkillsCreateInput).output(PersonalitySkillsCreateOutput),
  skillsUpdate: oc.input(PersonalitySkillsUpdateInput).output(PersonalitySkillsUpdateOutput),
  skillsDelete: oc.input(PersonalitySkillsDeleteInput).output(PersonalityOkOutput),
  skillsImportGlobal: oc.input(PersonalitySkillsImportInput).output(PersonalitySkillsImportOutput),
};

// ---------------------------------------------------------------------------
// Chat
//
// `chat.send` is fire-and-(quickly)-forget — it returns once the turn has
// been kicked off on the server. The agent's actual response streams over
// SSE on `/sse/sessions/:sessionId`. `clientId` distinguishes multiple
// browser tabs writing to the same session (CEO finding 4.1).
// ---------------------------------------------------------------------------

const ChatSendInput = z.object({
  /** Existing session ID, or omit to start a new session. */
  sessionId: z.string().optional(),
  clientId: z.string().min(1),
  text: z.string().min(1),
  personalityId: z.string().optional(),
});
const ChatSendOutput = z.object({
  sessionId: z.string(),
  /** Echoed back so a tab knows which turn the SSE stream belongs to. */
  turnId: z.string(),
});

const ChatAbortInput = z.object({ sessionId: z.string() });
const ChatAbortOutput = z.object({ ok: z.literal(true) });

/** @stable v1 */
const chat = {
  send: oc.input(ChatSendInput).output(ChatSendOutput),
  abort: oc.input(ChatAbortInput).output(ChatAbortOutput),
};

// ---------------------------------------------------------------------------
// Tools — approval workflow for dangerous tool calls
// ---------------------------------------------------------------------------

const ToolApproveInput = z.object({
  approvalId: z.string(),
  /** Tab identity. Other tabs viewing this session see `decidedBy: clientId`
   *  on the `approval.resolved` SSE event so the modal auto-dismisses with
   *  "approved by another window." */
  clientId: z.string().min(1),
  scope: ApprovalScopeSchema,
});
const ToolApproveOutput = z.object({ ok: z.literal(true) });

const ToolDenyInput = z.object({
  approvalId: z.string(),
  clientId: z.string().min(1),
  reason: z.string().optional(),
});
const ToolDenyOutput = z.object({ ok: z.literal(true) });

/** @experimental */
const tools = {
  approve: oc.input(ToolApproveInput).output(ToolApproveOutput),
  deny: oc.input(ToolDenyInput).output(ToolDenyOutput),
};

// ---------------------------------------------------------------------------
// Clarify — resolve a pending `clarify` request (the agent asked the user a
// question mid-turn). The request side flows out over SSE; this is the answer
// path back, mirroring the tool-approval transport.
// ---------------------------------------------------------------------------

const ClarifyRespondInput = z.object({
  requestId: z.string(),
  /** The user's answer — free-form text, or one of the offered options. */
  answer: z.string(),
  /** `user` for a real answer, `cancel` when the user dismissed the card. */
  source: z.enum(['user', 'cancel']),
});
const ClarifyRespondOutput = z.object({ ok: z.literal(true) });

/** @experimental */
const clarify = {
  respond: oc.input(ClarifyRespondInput).output(ClarifyRespondOutput),
};

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

const OnboardingStateOutput = z.object({
  step: OnboardingStepSchema,
  /** True once `~/.ethos/config.yaml` has a valid provider + key. */
  hasProvider: z.boolean(),
  /** Set after step 3. */
  selectedPersonalityId: z.string().nullable(),
});

const OnboardingValidateProviderInput = z.object({
  provider: ProviderIdSchema,
  apiKey: z.string().min(1),
  baseUrl: z.string().optional(),
});
const OnboardingValidateProviderOutput = z.object({
  ok: z.boolean(),
  /** Models returned by the provider's catalog endpoint when validation succeeds. */
  models: z.array(z.string()).nullable(),
  error: z.string().nullable(),
});

const OnboardingCompleteInput = z.object({
  provider: ProviderIdSchema,
  model: z.string().min(1),
  apiKey: z.string().min(1),
  baseUrl: z.string().optional(),
  personalityId: z.string().min(1),
});
const OnboardingCompleteOutput = z.object({ ok: z.literal(true) });

/** @experimental */
const onboarding = {
  state: oc.output(OnboardingStateOutput),
  validateProvider: oc
    .input(OnboardingValidateProviderInput)
    .output(OnboardingValidateProviderOutput),
  complete: oc.input(OnboardingCompleteInput).output(OnboardingCompleteOutput),
};

// ---------------------------------------------------------------------------
// Config
//
// Read-only view of the parts of `~/.ethos/config.yaml` the web UI can edit.
// The full file (with raw API keys) never crosses the wire — `apiKey` is
// returned as a redacted preview ("sk-…abc1") so users can confirm which key
// is active without leaking it to the browser.
// ---------------------------------------------------------------------------

const ConfigGetOutput = z.object({
  provider: z.string(),
  model: z.string(),
  apiKeyPreview: z.string(), // e.g. "sk-…abc1"
  baseUrl: z.string().nullable(),
  personality: z.string(),
  memory: z.enum(['markdown', 'vector']),
  modelRouting: z.record(z.string(), z.string()),
  /** Currently selected skin (one of the BUILTIN_SKINS names). */
  skin: z.string(),
});

const ConfigUpdateInput = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  personality: z.string().optional(),
  memory: z.enum(['markdown', 'vector']).optional(),
  modelRouting: z.record(z.string(), z.string()).optional(),
  skin: z.string().optional(),
});
const ConfigUpdateOutput = z.object({ ok: z.literal(true) });

/** @experimental */
const config = {
  get: oc.output(ConfigGetOutput),
  update: oc.input(ConfigUpdateInput).output(ConfigUpdateOutput),
};

// ---------------------------------------------------------------------------
// Cron (v0.5 — the proactive pillar)
//
// Web tab manages jobs.json on disk and reads run-output files from
// `<dataDir>/cron/output/<jobId>/<timestamp>.md`. The actual ticker
// lives in `serve.ts` when --web-experimental is enabled.
// ---------------------------------------------------------------------------

const CronListOutput = z.object({ jobs: z.array(CronJobSchema) });

const CronGetInput = z.object({ id: z.string().min(1) });
const CronGetOutput = z.object({ job: CronJobSchema });

const CronCreateInput = z.object({
  name: z.string().min(1),
  schedule: z.string().min(1),
  prompt: z.string().min(1),
  personality: z.string().optional(),
  deliver: z.string().optional(),
  missedRunPolicy: MissedRunPolicySchema.optional(),
});
const CronCreateOutput = z.object({ job: CronJobSchema });

const CronIdOnlyInput = z.object({ id: z.string().min(1) });
const CronOkOutput = z.object({ ok: z.literal(true) });

const CronRunNowInput = z.object({ id: z.string().min(1) });
const CronRunNowOutput = z.object({
  ok: z.literal(true),
  /** Full output body from this synchronous run. */
  output: z.string(),
  ranAt: z.string(),
});

const CronHistoryInput = z.object({
  id: z.string().min(1),
  /** Page size; max 100 to keep payloads bounded. Default 20. */
  limit: z.number().int().min(1).max(100).optional(),
});
const CronHistoryOutput = z.object({ runs: z.array(CronRunSchema) });

/** @experimental */
const cron = {
  list: oc.output(CronListOutput),
  get: oc.input(CronGetInput).output(CronGetOutput),
  create: oc.input(CronCreateInput).output(CronCreateOutput),
  delete: oc.input(CronIdOnlyInput).output(CronOkOutput),
  pause: oc.input(CronIdOnlyInput).output(CronOkOutput),
  resume: oc.input(CronIdOnlyInput).output(CronOkOutput),
  runNow: oc.input(CronRunNowInput).output(CronRunNowOutput),
  history: oc.input(CronHistoryInput).output(CronHistoryOutput),
};

// ---------------------------------------------------------------------------
// Skills (v0.5 — the learning pillar)
//
// Library panel CRUD over `~/.ethos/skills/*.md`. Per-personality skill
// directories arrive in v1 as part of the Personalities tab — for now the
// surface is the global library only.
// ---------------------------------------------------------------------------

const SkillListOutput = z.object({
  skills: z.array(SkillSchema),
  /** Approval queue size — surfaced as a sidebar badge so the user can
   *  see pending candidates without opening the Evolver panel. */
  pendingCount: z.number().int().nonnegative(),
});

const SkillGetInput = z.object({ id: z.string().min(1) });
const SkillGetOutput = z.object({ skill: SkillSchema });

const SkillCreateInput = z.object({
  /** Plain filename (no path, no `.md`). Letters, digits, dash, underscore. */
  id: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_-]+$/),
  /** Markdown body. May start with a YAML frontmatter block. */
  body: z.string(),
});
const SkillCreateOutput = z.object({ skill: SkillSchema });

const SkillUpdateInput = z.object({
  id: z.string().min(1),
  body: z.string(),
});
const SkillUpdateOutput = z.object({ skill: SkillSchema });

const SkillDeleteInput = z.object({ id: z.string().min(1) });
const SkillOkOutput = z.object({ ok: z.literal(true) });

/** @experimental */
const skills = {
  list: oc.output(SkillListOutput),
  get: oc.input(SkillGetInput).output(SkillGetOutput),
  create: oc.input(SkillCreateInput).output(SkillCreateOutput),
  update: oc.input(SkillUpdateInput).output(SkillUpdateOutput),
  delete: oc.input(SkillDeleteInput).output(SkillOkOutput),
};

// ---------------------------------------------------------------------------
// Evolver (v0.5 — companion to Skills)
//
// Three operations: configure thresholds, manage the pending approval
// queue produced by `SkillEvolver.evolve()`, and read the run history log.
// The actual evolve loop runs out-of-band (CLI / cron); this namespace
// only exposes its inputs and outputs to the web tab.
// ---------------------------------------------------------------------------

const EvolverConfigGetOutput = z.object({ config: EvolveConfigSchema });
const EvolverConfigUpdateInput = EvolveConfigSchema;
const EvolverConfigUpdateOutput = z.object({ config: EvolveConfigSchema });

const EvolverPendingListOutput = z.object({ pending: z.array(PendingSkillSchema) });
const EvolverPendingActionInput = z.object({ id: z.string().min(1) });
const EvolverHistoryInput = z.object({ limit: z.number().int().min(1).max(100).optional() });
const EvolverHistoryOutput = z.object({ runs: z.array(EvolverRunSchema) });

/** @experimental */
const evolver = {
  configGet: oc.output(EvolverConfigGetOutput),
  configUpdate: oc.input(EvolverConfigUpdateInput).output(EvolverConfigUpdateOutput),
  pendingList: oc.output(EvolverPendingListOutput),
  pendingApprove: oc.input(EvolverPendingActionInput).output(SkillOkOutput),
  pendingReject: oc.input(EvolverPendingActionInput).output(SkillOkOutput),
  history: oc.input(EvolverHistoryInput).output(EvolverHistoryOutput),
};

// ---------------------------------------------------------------------------
// Communications (v1)
//
// Per-platform connection state + setup form. Read returns only
// configured-ness flags; secrets never cross the wire. Update accepts
// per-field plaintext; empty / omitted fields preserve the existing
// value (so users can rotate one secret without re-entering all).
// ---------------------------------------------------------------------------

const PlatformsListOutput = z.object({ platforms: z.array(PlatformStatusSchema) });

const PlatformsSetInput = z.object({
  id: PlatformIdSchema,
  /** Per-field plaintext. Field names match the schema each platform
   *  declares — e.g. telegram = { token }, slack = { botToken,
   *  appToken, signingSecret }. Empty / missing keys preserve the
   *  current value. */
  fields: z.record(z.string(), z.string()),
});
const PlatformsSetOutput = z.object({ platform: PlatformStatusSchema });

const PlatformsClearInput = z.object({ id: PlatformIdSchema });
const PlatformsClearOutput = z.object({ platform: PlatformStatusSchema });

/** @experimental */
const platforms = {
  list: oc.output(PlatformsListOutput),
  set: oc.input(PlatformsSetInput).output(PlatformsSetOutput),
  clear: oc.input(PlatformsClearInput).output(PlatformsClearOutput),
  botsListTelegram: oc.output(z.object({ bots: z.array(TelegramBotEntrySchema) })),
  botsAddTelegram: oc
    .input(
      z.object({
        token: z.string().min(1),
        bind: BotBindingSchema,
      }),
    )
    .output(z.object({ bot: TelegramBotEntrySchema })),
  botsRemoveTelegram: oc
    .input(z.object({ botKey: z.string() }))
    .output(z.object({ ok: z.literal(true) })),

  botsListSlack: oc.output(z.object({ bots: z.array(SlackAppEntrySchema) })),
  botsAddSlack: oc
    .input(
      z.object({
        botToken: z.string().min(1),
        appToken: z.string().min(1),
        signingSecret: z.string().min(1),
        bind: BotBindingSchema,
      }),
    )
    .output(z.object({ bot: SlackAppEntrySchema })),
  botsRemoveSlack: oc
    .input(z.object({ botKey: z.string() }))
    .output(z.object({ ok: z.literal(true) })),
};

// ---------------------------------------------------------------------------
// Plugins + MCP (v1 — read-only inventory)
//
// Returns the union of installed plugins (discovered in user / project
// / npm dirs) and configured MCP servers. CRUD is out of scope for v1
// — the CLI (`ethos plugin install / add-mcp`) remains the editor.
// ---------------------------------------------------------------------------

const PluginsListOutput = z.object({
  plugins: z.array(PluginInfoSchema),
  mcpServers: z.array(McpServerInfoSchema),
});

/** @experimental */
const plugins = {
  list: oc.output(PluginsListOutput),
};

// ---------------------------------------------------------------------------
// Memory (v1)
//
// Two markdown files MarkdownFileMemoryProvider reads at agent-loop
// prefetch: MEMORY.md (rolling project context) and USER.md (who you
// are — persistent across sessions). The web tab is the editor for
// both. Vector-mode chunk CRUD lands later.
// ---------------------------------------------------------------------------

const MemoryListOutput = z.object({ files: z.array(MemoryFileSchema) });

const MemoryGetInput = z.object({ store: MemoryStoreSchema });
const MemoryGetOutput = z.object({ file: MemoryFileSchema });

const MemoryWriteInput = z.object({
  store: MemoryStoreSchema,
  content: z.string(),
});
const MemoryWriteOutput = z.object({ file: MemoryFileSchema });

/** @stable v1 */
const memory = {
  list: oc.output(MemoryListOutput),
  get: oc.input(MemoryGetInput).output(MemoryGetOutput),
  write: oc.input(MemoryWriteInput).output(MemoryWriteOutput),
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
const mesh = {
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
const batch = {
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
const evalNs = {
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

/** @experimental */
const kanban = {
  list: oc.output(KanbanListOutput),
  getBoard: oc.input(KanbanGetBoardInput).output(KanbanGetBoardOutput),
  updateStatus: oc.input(KanbanUpdateStatusInput).output(KanbanUpdateStatusOutput),
};

// ---------------------------------------------------------------------------
// API Keys — admin CRUD (cookie-auth-gated only)
//
// Minting, listing, and revoking API keys for external Mission Controls.
// The plaintext secret is returned only from `create` — subsequent reads
// never expose the raw key. This namespace rejects bearer-token auth to
// prevent privilege escalation (a stolen key must not mint more keys).
// ---------------------------------------------------------------------------

const OriginSchema = z
  .string()
  .transform((s) => {
    try {
      const u = new URL(s);
      return u.origin;
    } catch {
      return s;
    }
  })
  .refine((s) => {
    try {
      const u = new URL(s);
      return u.origin === s;
    } catch {
      return false;
    }
  }, 'Must be a valid origin (scheme + host + optional port, no path/query/fragment)');

const ApiKeyCreateInput = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(ApiKeyScopeSchema).min(1),
  allowedOrigins: z.array(OriginSchema).min(1),
});
const ApiKeyCreateOutput = z.object({
  /** Plaintext secret — shown once, then never again. */
  secret: z.string(),
  key: ApiKeyMetadataSchema,
});

const ApiKeyListOutput = z.object({ keys: z.array(ApiKeyMetadataSchema) });

const ApiKeyRevokeInput = z.object({ id: z.string() });
const ApiKeyRevokeOutput = z.object({ ok: z.literal(true) });

/** @experimental */
const apiKeys = {
  create: oc.input(ApiKeyCreateInput).output(ApiKeyCreateOutput),
  list: oc.output(ApiKeyListOutput),
  revoke: oc.input(ApiKeyRevokeInput).output(ApiKeyRevokeOutput),
};

// ---------------------------------------------------------------------------
// Meta — server capabilities (stable from v1)
//
// Open-shape `Record<string, boolean>` describing what this server
// supports. Today: `{ byok: true }`. Absence means unsupported. Keys
// are added additively — the shape never changes, only its contents grow.
// ---------------------------------------------------------------------------

const MetaCapabilitiesOutput = z.object({
  capabilities: z.record(z.string(), z.boolean()),
});

/** @stable v1 */
const meta = {
  capabilities: oc.output(MetaCapabilitiesOutput),
};

// ---------------------------------------------------------------------------
// Root contract — every namespace mounted under one symbol
// ---------------------------------------------------------------------------

export const contract = {
  sessions,
  personalities,
  chat,
  tools,
  clarify,
  onboarding,
  config,
  cron,
  skills,
  evolver,
  mesh,
  memory,
  plugins,
  platforms,
  batch,
  eval: evalNs,
  kanban,
  apiKeys,
  meta,
};

export type Contract = typeof contract;
