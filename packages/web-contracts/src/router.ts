// The ONE runtime import from `@ethosagent/types` this contract takes: the
// voice-mode list is a closed enum every layer names (the decision function in
// voice-text, `LaneVoiceModeStore` in core, the gateway's `/voice` command, and
// the chat header), and a second spelling here is exactly the drift the shared
// constant exists to prevent. `@ethosagent/types` is zero-dep, so importing it
// costs the published contract nothing.
import { VOICE_MODES } from '@ethosagent/types';
import { oc } from '@orpc/contract';
import { z } from 'zod';
import { SessionCardSchema } from './cards';
import {
  A2aIdentityViewSchema,
  A2aPeerRowSchema,
  ApiKeyMetadataSchema,
  ApiKeyScopeSchema,
  ApprovalLeaseSchema,
  ApprovalScopeSchema,
  BackgroundJobDetailSchema,
  BackgroundJobSummarySchema,
  BatchRunInfoSchema,
  BotBindingSchema,
  ChannelPlatformFilterSchema,
  CredentialKeyInfoSchema,
  CronDeliverToSchema,
  CronDeliveryTargetSchema,
  CronJobSchema,
  CronRunSchema,
  DigestLatestSchema,
  EvalRunInfoSchema,
  EvalScorerSchema,
  EvolveConfigSchema,
  EvolverRunSchema,
  GoalAttemptSchema,
  GoalEventSchema,
  GoalSchema,
  GoalStatusSchema,
  IdentityMapEntrySchema,
  KanbanAgentSchema,
  KanbanBoardSnapshotSchema,
  KanbanCommentSchema,
  KanbanRunSchema,
  KanbanTaskSchema,
  KanbanTaskStatusSchema,
  KanbanTeamSummarySchema,
  KeyCategorySchema,
  LearningCandidateKindSchema,
  LearningCandidateStatusSchema,
  LearningCandidateViewSchema,
  LearningReplayReportViewSchema,
  LearningTimelineEntryViewSchema,
  LedgerEventSchema,
  McpAddServerInputSchema,
  McpAddServerOutputSchema,
  McpAttachInputSchema,
  McpAttachOutputSchema,
  McpCancelInputSchema,
  McpCatalogOutputSchema,
  McpCompleteInputSchema,
  McpCompleteOutputSchema,
  McpDeleteInputSchema,
  McpExportViewSchema,
  McpListOutputSchema,
  McpPersonalityServersInputSchema,
  McpPersonalityServersOutputSchema,
  McpPolicySchema,
  McpReconnectInputSchema,
  McpRefreshTokenInputSchema,
  McpRefreshTokenOutputSchema,
  McpRenameInputSchema,
  McpRenameOutputSchema,
  McpScopeStatusInputSchema,
  McpScopeStatusOutputSchema,
  McpServerInfoSchema,
  McpServerToolsInputSchema,
  McpServerToolsOutputSchema,
  McpStartInputSchema,
  McpStartOutputSchema,
  McpStatusOutputSchema,
  McpUpdateTokenInputSchema,
  McpUpdateTokenOutputSchema,
  McpValidateConfigInputSchema,
  McpValidateConfigOutputSchema,
  MemoryFileSchema,
  MemoryHistoryEntrySchema,
  MemoryHistorySourceSchema,
  MemoryStoreSchema,
  MeshAgentSchema,
  MeshRouteResultSchema,
  MissedRunPolicySchema,
  ModelTierConfigSchema,
  NamedSecretProviderNameSchema,
  OnboardingStepSchema,
  OutboxItemViewSchema,
  OutboxRevisionViewSchema,
  OutboxStateSchema,
  PendingMemorySchema,
  PendingSkillSchema,
  PersonalitySchema,
  PersonalitySkillSchema,
  PlatformIdSchema,
  PlatformStatusSchema,
  PluginInfoSchema,
  ProviderEntrySchema,
  ProviderIdSchema,
  RecipeBundleWireSchema,
  RecipeChannelSetupSchema,
  RecipeDiscoverChatsOutputSchema,
  RecipeInstallModeSchema,
  RecipeInstallReportSchema,
  RecipeListItemSchema,
  RecipePreflightSchema,
  RecipeSecretBindingsSchema,
  SessionSchema,
  SkillSchema,
  SlackAppEntrySchema,
  StoredMessageSchema,
  TeamDetailSchema,
  TeamSummarySchema,
  TelegramBotEntrySchema,
  WhatsAppChannelModeSchema,
  WhatsAppEntrySchema,
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
  /** Only sessions whose origin platform is exactly this (`cli`, `web`, `mcp`, …). */
  platform: z.string().optional(),
  /** Only the direct forks of this session (`parentSessionId`) — the branch switcher. */
  parentSessionId: z.string().optional(),
});
const SessionListOutput = z.object({
  items: z.array(SessionSchema),
  nextCursor: z.string().nullable(),
});

const SessionGetInput = z.object({
  id: z.string(),
  /**
   * Default `true`: `messages` and `cards` carry the WHOLE session. `false`
   * skips reading them, and both arrays are then `[]` meaning "not requested",
   * not "none" — page the history with `sessions.messages` instead.
   */
  withMessages: z.boolean().default(true),
});
const SessionGetOutput = z.object({
  session: SessionSchema,
  /** Every message, oldest first. `[]` when `withMessages: false` (not requested). */
  messages: z.array(StoredMessageSchema),
  /** Card envelopes emitted during this session, for replay. Empty when none, or when not requested. */
  cards: z.array(SessionCardSchema),
});

// Turn-based, cursor-paged history, newest page first. A turn starts at a
// `user` message (`user_steer` does not start one) and is never split across
// pages; rows before the first user message ride with the page that reaches the
// start. A page also stops adding older turns at ~500 KB of message content,
// but always carries at least one whole turn.
const SessionMessagesInput = z.object({
  id: z.string(),
  /** Opaque cursor from a previous response's `nextCursor`. Absent = the newest turns. */
  before: z.string().optional(),
  /** Whole turns per page. */
  turns: z.number().int().min(1).max(100).default(20),
});
const SessionMessagesOutput = z.object({
  /** The page's messages, oldest first. */
  messages: z.array(StoredMessageSchema),
  /** Only the cards whose tool call belongs to a message in this page. */
  cards: z.array(SessionCardSchema),
  /** Pass as `before` for the next-older page. `null` once the page reaches the start of the session. */
  nextCursor: z.string().nullable(),
});

const SessionForkInput = z.object({
  id: z.string(),
  personalityId: z.string().optional(),
  /** Optimistic-concurrency guard. v1 ignores this. */
  expectedVersion: z.number().int().optional(),
});
const SessionForkOutput = z.object({ session: SessionSchema });

const SessionDeleteInput = z.object({
  id: z.string(),
  /** Optimistic-concurrency guard. v1 ignores this. */
  expectedVersion: z.number().int().optional(),
});
const SessionDeleteOutput = z.object({ ok: z.literal(true) });

const SessionUpdateInput = z.object({
  id: z.string(),
  /** New human-readable title. Pass null to clear the title. */
  title: z.string().max(200).nullable(),
  /** Optimistic-concurrency guard. v1 ignores this. */
  expectedVersion: z.number().int().optional(),
});
const SessionUpdateOutput = z.object({ session: SessionSchema });

const SessionExportInput = z.object({
  id: z.string(),
  format: z.enum(['markdown']),
});
const SessionExportOutput = z.object({
  content: z.string(),
  filename: z.string(),
});

const SessionPinInput = z.object({ id: z.string() });
const SessionPinOutput = z.object({ session: SessionSchema });

// Phase 0 — per-session context anatomy, aggregated from observability.db
// `llm_call` spans (never the sessions.db message rows, so nothing
// double-counts). Null when there is no span data yet.
const ContextAnatomySchema = z.object({
  system: z.number(),
  tools: z.number(),
  messages: z.number(),
  total: z.number(),
  inputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheHitRate: z.number(),
  llmCallCount: z.number(),
});
const SessionContextAnatomyInput = z.object({ id: z.string() });
const SessionContextAnatomyOutput = z.object({ anatomy: ContextAnatomySchema.nullable() });
export type ContextAnatomyWire = z.infer<typeof ContextAnatomySchema>;

/** @stable v1 */
const sessions = {
  list: oc.input(SessionListInput).output(SessionListOutput),
  get: oc.input(SessionGetInput).output(SessionGetOutput),
  messages: oc.input(SessionMessagesInput).output(SessionMessagesOutput),
  fork: oc.input(SessionForkInput).output(SessionForkOutput),
  delete: oc.input(SessionDeleteInput).output(SessionDeleteOutput),
  update: oc.input(SessionUpdateInput).output(SessionUpdateOutput),
  export: oc.input(SessionExportInput).output(SessionExportOutput),
  pin: oc.input(SessionPinInput).output(SessionPinOutput),
  unpin: oc.input(SessionPinInput).output(SessionPinOutput),
  contextAnatomy: oc.input(SessionContextAnatomyInput).output(SessionContextAnatomyOutput),
  undoTurns: oc
    .input(z.object({ id: z.string(), n: z.number().int().min(1).default(1) }))
    .output(z.object({ removed: z.number() })),
  // Phase 2 — manual `/compact`. Forces a compaction outside a turn and persists
  // a watermark so it survives into later turns. `instructions` is the optional
  // `/compact <focus…>` hint threaded into the summarizer.
  compact: oc.input(z.object({ id: z.string(), instructions: z.string().optional() })).output(
    z.object({
      ok: z.boolean(),
      engineName: z.string(),
      droppedCount: z.number(),
      preTotalTokens: z.number(),
      postTotalTokens: z.number(),
      summariesEnabled: z.boolean(),
    }),
  ),
};

// ---------------------------------------------------------------------------
// Activity — durable history read from observability.db (spans / turn traces /
// events), merged into one newest-first timeline. `personalityId` scopes it to
// one agent; omitting it is the global (Library-altitude) view.
// ---------------------------------------------------------------------------

const ActivityHistoryItemSchema = z.object({
  id: z.string(),
  kind: z.enum(['tool_call', 'llm_call', 'turn', 'event']),
  name: z.string(),
  sessionId: z.string().nullable(),
  personalityId: z.string().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  status: z.string().nullable(),
  details: z.record(z.string(), z.unknown()).nullable(),
});
const ActivityHistoryInput = z.object({
  personalityId: z.string().nullable().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  /**
   * Exclusive cursor from the previous page — BOTH halves, round-tripped
   * together. A bare ms-epoch cursor is not enough: parallel tool calls share a
   * millisecond, so a page boundary inside a tied group would skip the rest of
   * it. `beforeId` breaks the tie against the same `(startedAt, id)` order the
   * server pages by.
   */
  before: z.number().optional(),
  beforeId: z.string().optional(),
});
const ActivityHistoryOutput = z.object({
  items: z.array(ActivityHistoryItemSchema),
  nextBefore: z.number().nullable(),
  nextBeforeId: z.string().nullable(),
});
export type ActivityHistoryItemWire = z.infer<typeof ActivityHistoryItemSchema>;

const activity = {
  history: oc.input(ActivityHistoryInput).output(ActivityHistoryOutput),
};

// ---------------------------------------------------------------------------
// Personalities (v0 read-only — create/edit lands in v1)
// ---------------------------------------------------------------------------

const PersonalityListInput = z.object({
  /** Page size. */
  limit: z.number().int().positive().optional(),
  /** Opaque cursor from the previous response's `nextCursor`. */
  cursor: z.string().optional(),
});
const PersonalityListOutput = z.object({
  items: z.array(PersonalitySchema),
  nextCursor: z.string().nullable(),
  defaultId: z.string(),
});
const PersonalityGetInput = z.object({ id: z.string() });
const PersonalityGetOutput = z.object({
  personality: PersonalitySchema,
  /** Markdown body of SOUL.md. Empty string when the file isn't present. */
  soulMd: z.string(),
  /** Per-personality MCP tool policy from `mcp.yaml`. Null when the
   *  personality has no `mcp.yaml`. A server with no `tools` entry means
   *  "all tools allowed" (default-allow). */
  mcpPolicy: McpPolicySchema.nullable(),
});

const PersonalityCharacterSheetInput = z.object({ id: z.string() });

// Structured execution posture (Phase 2a, lane E1). Mirrors the
// `ExecutionPosture` / `DockerAbsentDecision` contracts in
// `@ethosagent/types`; the web Execution UI consumes this directly rather than
// re-computing posture from the toolset (single source of truth = the resolver
// behind `buildExecutionPosture`).
const DockerAbsentSchema = z.object({
  blocked: z.literal(true),
  canInstall: z.literal(true),
  canConsentLocal: z.boolean(),
  consentForbiddenReason: z.string().optional(),
});
const ExecutionPostureSchema = z.object({
  backend: z.enum(['docker', 'local', 'ssh', 'none']),
  /**
   * What the PERSONALITY required (`execution:` in its `config.yaml`), absent
   * when it required nothing. Carried BESIDE `backend` because `ExecutionPosture`
   * in `@ethosagent/types` says a surface must be able to show both — what was
   * asked for and what this machine provides. Without it a `backend: 'none'`
   * that declared `execution: none` is indistinguishable from one that simply
   * has no exec-bearing tool, which are different facts about the personality;
   * `postureWhy` in `apps/web/src/lib/execution-posture.ts` reads this to tell
   * them apart, the same split `character-sheet.ts` makes for the CLI sheet.
   */
  requirement: z.enum(['remote', 'none']).optional(),
  networkMode: z.enum(['none', 'bridge']),
  memoryMb: z.number(),
  containerized: z.boolean(),
  mounts: z.array(
    z.object({
      hostPath: z.string(),
      containerPath: z.string(),
      mode: z.enum(['ro', 'rw']),
    }),
  ),
  scratchPaths: z.array(z.string()),
  dockerAbsent: DockerAbsentSchema.optional(),
  /**
   * Honest host fallback (Phase 2a F1) — the requested sandbox or remote
   * backend could not run and the constitution permitted `local`, so `backend`
   * says `local` and this says why. Without it the UI cannot tell an intended
   * host posture from a demoted one.
   */
  hostFallback: z
    .object({
      reason: z.enum(['docker-disabled', 'docker-unavailable', 'ssh-unavailable']),
    })
    .optional(),
  /**
   * The remote target, ALREADY FORMATTED by the resolver — display only, the
   * resolver never dials it. It prints exactly what the operator configured, so
   * a host with no explicit port renders `build-01` and never `build-01:22`.
   * Nothing downstream may default a port back in.
   */
  sshTarget: z.string().optional(),
  /**
   * Why an `ssh` posture will not reach its target. `message` is the canonical
   * wording — render it verbatim rather than composing a second explanation of
   * the same fact.
   */
  sshRefused: z
    .object({
      reason: z.enum(['unconfigured', 'constitution-requires-sandbox']),
      message: z.string(),
    })
    .optional(),
});
/** Wire shape of the resolved execution posture (Phase 2a, lane E1). */
export type ExecutionPostureWire = z.infer<typeof ExecutionPostureSchema>;
export type DockerAbsentWire = z.infer<typeof DockerAbsentSchema>;
const PersonalityCharacterSheetOutput = z.object({
  /** Generated Markdown character sheet — the same artifact `ethos personality
   *  show` prints. Regenerated on each call; see `renderCharacterSheet` in
   *  @ethosagent/personalities. */
  markdown: z.string(),
  /** Resolved execution posture (Phase 2a, lane E1). Null when the server has
   *  no data directory wired and therefore cannot resolve the posture. */
  posture: ExecutionPostureSchema.nullable(),
});

const PersonalityIdRegex = /^[a-z0-9_-]+$/;

/** Nightly governed-learning gates. Defaults reproduce today's behavior
 *  (pass + judge + expression all run). Shared by create + update. */
const PersonalityNightlyInput = z
  .object({
    enabled: z.boolean().optional(),
    judge: z
      .object({
        enabled: z.boolean().optional(),
        minInteractions: z.number().int().min(1).optional(),
      })
      .optional(),
    expression: z.boolean().optional(),
  })
  .optional();

/**
 * A `voice.languages.<tag>` key. The tag is written into config.yaml as part of
 * a dotted key, so the charset is BCP-47's own (letters, digits, hyphen) and
 * nothing else — a tag carrying a separator or a newline would serialize into
 * lines the loader never meant to read.
 */
const VoiceLanguageTagSchema = z.string().regex(/^[A-Za-z0-9-]+$/);

/**
 * The editable slice of a personality's `voice` block — how it sounds and what
 * it listens through.
 *
 * `tts_provider` / `stt_provider` / `realtime_provider` name entries in the
 * deployment's `voice.tts.providers.*` / `voice.stt.providers.*` /
 * `voice.realtime.providers.*` rosters (LABELS, never credentials); `tts_voice`
 * is the TTS provider's voice id. `''` clears the key, so "Default" is
 * expressible.
 *
 * `call_style` is how the personality LOOKS on a call — the visual sibling of
 * `tts_voice`, and editable for the same reason. `''` clears it, which hands
 * the choice back to `display.call_style` and then to the id derivation.
 *
 * `tier` picks which voice stack serves this personality, `model` names its
 * fast-lane model, and `languages` maps a BCP-47 tag to the voice that speaks
 * it. All three are existing sub-keys of the frozen `voice` block — no new
 * top-level `PersonalityConfig` field is introduced by exposing them.
 *
 * `languages` REPLACES the stored map (an empty object clears it), unlike the
 * scalars beside it, because a per-key merge would leave no way to delete a tag.
 */
const PersonalityVoiceInput = z
  .object({
    tts_provider: z.string().optional(),
    stt_provider: z.string().optional(),
    realtime_provider: z.string().optional(),
    tts_voice: z.string().optional(),
    call_style: z.enum(['liquid', 'orb', 'rings', '']).optional(),
    tier: z.enum(['pipeline', 'realtime', '']).optional(),
    model: z.string().optional(),
    languages: z.record(VoiceLanguageTagSchema, z.string().min(1)).optional(),
  })
  .optional();

const PersonalityCreateInput = z.object({
  /** Lowercase id; becomes the directory name. */
  id: z.string().min(1).regex(PersonalityIdRegex),
  name: z.string().min(1),
  description: z.string().optional(),
  model: z.union([z.string(), ModelTierConfigSchema]).optional(),
  toolset: z.array(z.string()),
  /** Markdown body of SOUL.md. May be empty. */
  soulMd: z.string(),
  provider: ProviderIdSchema.or(z.literal('')).optional(),
  capabilities: z.array(z.string()).optional(),
  mcp_servers: z.array(z.string()).optional(),
  plugins: z.array(z.string()).optional(),
  fs_reach: z
    .object({
      read: z.array(z.string()).optional(),
      write: z.array(z.string()).optional(),
      /** Declared working director(ies). Tokens (`${ETHOS_HOME}`, `${self}`,
       *  `${CWD}`) are stored verbatim and resolved at turn setup. A list
       *  declares several Documents roots; a bare string is one. */
      workdir: z.union([z.string(), z.array(z.string())]).optional(),
    })
    .optional(),
  skill_evolution: z
    .object({
      enabled: z.boolean().optional(),
      min_tool_calls: z.number().int().min(1).max(20).optional(),
      cooldown_minutes: z.number().int().min(0).optional(),
      evolve_existing: z.boolean().optional(),
      promotion: z.enum(['review', 'auto']).optional(),
      scope: z.enum(['personality', 'shared']).optional(),
    })
    .optional(),
  /** Governed-learning approval dial. 'auto' applies evolved Expression
   *  automatically; 'user' holds it for human approval. */
  evolution_approval_mode: z.enum(['auto', 'user']).optional(),
  nightly: PersonalityNightlyInput,
  voice: PersonalityVoiceInput,
  /**
   * Per-personality network reach (Ch.7). Not a frozen-schema addition —
   * `safety.network` already exists on `PersonalityConfig`; this exposes it on
   * the create path, which had no way to express a network policy at all.
   *
   * It has to be settable in the FIRST write: a personality with no
   * `safety.network` resolves every `allowedHosts: ['*']` tool to an EMPTY host
   * set (`packages/core/src/capability-resolver.ts`), so `web_extract` denies
   * every host until someone edits config.yaml by hand.
   *
   * Narrowing only (ARCHITECTURE.md §V S6). Whatever is listed here sits UNDER
   * the non-overridable floor: cloud-metadata and private/RFC1918 ranges stay
   * blocked, and only http/https schemes are permitted.
   */
  safety: z
    .object({
      network: z
        .object({
          allow: z.array(z.string()).optional(),
          deny: z.array(z.string()).optional(),
          allow_private_urls: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
});
const PersonalityCreateOutput = z.object({ personality: PersonalitySchema });

/** One `mcp_export.expose_tools` entry. Written verbatim onto one space-joined
 *  config.yaml line, so whitespace, quotes and newlines are refused here and
 *  again by the registry (`MCP_EXPORT_TOOL_NAME`, extensions/personalities). */
const McpExportToolNameInput = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/);

/** Every sub-key optional: the registry shallow-merges this onto the stored
 *  declaration, so `{ enabled: false }` turns export off and keeps the rest. */
const PersonalityMcpExportPatchInput = z.object({
  enabled: z.boolean().optional(),
  /** `'all'` is the personality's full reach, `'none'` conversation only; a
   *  list must name at least one tool. */
  expose_tools: z
    .union([z.literal('all'), z.literal('none'), z.array(McpExportToolNameInput).min(1).max(512)])
    .optional(),
  expose_memory: z.enum(['none', 'scoped', 'full']).optional(),
  expose_sessions: z.boolean().optional(),
  auth: z.enum(['localhost', 'bearer']).optional(),
});

const PersonalityUpdateInput = z.object({
  id: z.string().min(1),
  /** Patch — only present fields are written. */
  name: z.string().optional(),
  description: z.string().optional(),
  model: z.union([z.string(), ModelTierConfigSchema]).optional(),
  toolset: z.array(z.string()).optional(),
  soulMd: z.string().optional(),
  mcp_servers: z.array(z.string()).optional(),
  /** Per-server MCP tool subsets, written to `mcp.yaml`. Maps a server name
   *  to the BARE tool names that server may expose. Only include a server
   *  here when it is a STRICT subset — a server with every tool selected
   *  should be omitted (that records "all tools allowed"). Servers attached
   *  via `mcp_servers` but absent here have any prior `tools` entry cleared.
   *  Ignored unless `mcp_servers` is also present. */
  mcp_tools: z.record(z.string(), z.array(z.string())).optional(),
  plugins: z.array(z.string()).optional(),
  capabilities: z.array(z.string()).optional(),
  provider: ProviderIdSchema.or(z.literal('')).optional(),
  /** Sub-keys are shallow-merged onto the stored block, so a patch carrying
   *  only `read`/`write` leaves an existing `workdir` in place. `''` (or an
   *  empty list) clears the workdir; a list declares several Documents roots. */
  fs_reach: z
    .object({
      read: z.array(z.string()).optional(),
      write: z.array(z.string()).optional(),
      workdir: z.union([z.string(), z.array(z.string())]).optional(),
    })
    .optional(),
  /** Idle-time dreaming controls. `enable` toggles dreaming; idleMinutes /
   *  maxPerDay tune the cadence (kept at their persisted values when omitted). */
  dreaming: z
    .object({
      enable: z.boolean(),
      idleMinutes: z.number().int().min(0).optional(),
      maxPerDay: z.number().int().min(0).optional(),
    })
    .optional(),
  /** Governed-learning approval dial. 'auto' applies evolved Expression
   *  automatically; 'user' holds it for human approval. */
  evolution_approval_mode: z.enum(['auto', 'user']).optional(),
  /** Skill-evolution tuning. Retunable after creation. */
  skill_evolution: z
    .object({
      enabled: z.boolean().optional(),
      min_tool_calls: z.number().int().min(1).max(20).optional(),
      cooldown_minutes: z.number().int().min(0).optional(),
      model: z.string().optional(),
      evolve_existing: z.boolean().optional(),
      promotion: z.enum(['review', 'auto']).optional(),
      scope: z.enum(['personality', 'shared']).optional(),
    })
    .optional(),
  /** Per-personality safety dial. `approvalMode` and `network` are editable
   *  from the web; sibling safety fields are preserved by the registry merge.
   *
   *  `network` is narrowing only (ARCHITECTURE.md §V S6) — whatever is listed
   *  sits UNDER the non-overridable floor, and `allow` is intersected with each
   *  tool's own declared hosts. A `network` object with no lists clears the
   *  policy back to none. */
  safety: z
    .object({
      approvalMode: z.enum(['manual', 'smart', 'off']).optional(),
      network: z
        .object({
          allow: z.array(z.string()).optional(),
          deny: z.array(z.string()).optional(),
          allow_private_urls: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
  /** Per-personality memory backend. Built-ins: 'markdown', 'vector'. */
  memory: z.object({ provider: z.string().optional() }).optional(),
  /** Avatar sub-key of the `display` identity block. `''` clears
   *  `avatar_url` back to unset; the avatar upload/delete routes are the
   *  usual way to change it, but a curated-icon pick goes through here
   *  directly (it's just a static URL, no bytes to upload). */
  display: z.object({ avatar_url: z.string().optional() }).optional(),
  /** Nightly governed-learning gates. The UI sends the FULL nightly object
   *  (including the full judge sub-object); the registry one-level-merges it. */
  nightly: PersonalityNightlyInput,
  /** Sub-keys are shallow-merged onto the stored `voice` block, so a patch
   *  carrying only `tts_voice` leaves a hand-written `languages` map alone.
   *  `''` clears that sub-key. */
  voice: PersonalityVoiceInput,
  /** `mcp_export.*` — see `PersonalityMcpExportPatchInput`. */
  mcp_export: PersonalityMcpExportPatchInput.optional(),
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

// Renderer capabilities (`ethos.renders`) declared by the personality's
// resolved skill set — `<renderer>@<spec-version>` entries a chat surface
// checks against its own curated registry before upgrading a fenced block
// from a code block. Empty array = code block, which is also the failure mode.
const PersonalityRenderersInput = z.object({ id: z.string().min(1) });
const PersonalityRenderersOutput = z.object({ renderers: z.array(z.string()) });

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

// Pending skill-candidate review queue — a legacy adapter over the learning
// inbox (L-T8). Lists this personality's waiting skill candidates by the file
// each lands as; approve promotes one only when its replay passed (otherwise
// `INVALID_INPUT`, naming `ethos learning approve <id> --override`); reject marks
// it rejected.
const PersonalitySkillCandidateFileName = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9_-]+\.md$/);
const PersonalitySkillCandidatesListInput = z.object({ personalityId: z.string().min(1) });
const PersonalitySkillCandidatesListOutput = z.object({
  candidates: z.array(z.object({ fileName: z.string(), content: z.string() })),
});
const PersonalitySkillCandidateActionInput = z.object({
  personalityId: z.string().min(1),
  fileName: PersonalitySkillCandidateFileName,
});
const PersonalitySkillCandidateApproveOutput = z.object({
  ok: z.literal(true),
  promotedTo: z.string(),
});

// Per-personality MCP bearer-token management (headless gap 4).
const PersonalityMcpSetTokenInput = z.object({
  personalityId: z.string().min(1),
  server: z.string().min(1),
  token: z.string().min(1),
});
const PersonalityMcpSetTokenOutput = z.object({ ok: z.literal(true) });

const PersonalityMcpDeleteTokenInput = z.object({
  personalityId: z.string().min(1),
  server: z.string().min(1),
});
const PersonalityMcpDeleteTokenOutput = z.object({ ok: z.literal(true) });

const LearningLogEntrySchema = z.object({
  revisionId: z.string(),
  at: z.string(),
  summary: z.string(),
  evidenceRef: z.string(),
  prevExpressionRef: z.string(),
});

const PersonalityJudgeSchema = z.object({
  alignmentScore: z.number(),
  signal: z.enum(['drift', 'underspecified_soul']).nullable(),
  lowStreak: z.number(),
  at: z.string().optional(),
  perDimension: z.array(z.object({ dimension: z.string(), score: z.number() })).optional(),
});

const PersonalityNightlySchema = z.object({
  windowEnd: z.string(),
  completed: z.array(z.string()),
});

const PersonalityLivingSoulInput = z.object({ id: z.string().min(1) });
const PersonalityLivingSoulOutput = z.object({
  core: z.string(),
  expression: z.string(),
  learningLog: z.array(LearningLogEntrySchema),
  /** Latest Personality-Judge alignment read from
   *  `.judge-history/state.json`. Omitted when no judge run is recorded. */
  judge: PersonalityJudgeSchema.optional(),
  /** Latest nightly-pass status read from `.nightly-state.json`. Omitted when
   *  no nightly pass has run (missing or malformed file). */
  nightly: PersonalityNightlySchema.optional(),
});

const PersonalityProposeExpressionInput = z.object({ id: z.string().min(1) });
const PersonalityProposeExpressionOutput = z.object({
  currentExpression: z.string(),
  newExpression: z.string(),
  rationale: z.string(),
  evidence: z.string(),
});

const PersonalityApplyExpressionInput = z.object({
  id: z.string().min(1),
  newExpression: z.string(),
  summary: z.string(),
  evidenceRef: z.string(),
  /**
   * Apply is an approval of a learning candidate that has not been replayed,
   * so it needs a human reason (plan `trust-before-reach.md` Design §6). Absent
   * → `OVERRIDE_REQUIRED`, the learning inbox's refusal code, mapped by
   * `learningRpcError` (`apps/web-api/src/rpc/learning.ts`) like every other
   * refusal (`STALE`, …). `summary` is the drafter's text and does not count.
   */
  overrideReason: z.string().trim().min(1).optional(),
});
const PersonalityApplyExpressionOutput = z.object({ revisionId: z.string() });

const PersonalityRevertExpressionInput = z.object({ id: z.string().min(1) });
const PersonalityRevertExpressionOutput = z.object({
  ok: z.literal(true),
  revertedTo: z.string(),
});

// M-T9 — the MCP export section. A read: mapped to `personalities:read`, so the
// output carries no secret (see `McpExportViewSchema`).
const PersonalityMcpExportInput = z.object({ id: z.string().min(1) });

const PersonalityProposeSoulSplitInput = z.object({ soulMd: z.string() });
const PersonalityProposeSoulSplitOutput = z.object({
  core: z.string(),
  expression: z.string(),
  rationale: z.string(),
});

/** @stable v1 */
const personalities = {
  list: oc.input(PersonalityListInput).output(PersonalityListOutput),
  get: oc.input(PersonalityGetInput).output(PersonalityGetOutput),
  characterSheet: oc.input(PersonalityCharacterSheetInput).output(PersonalityCharacterSheetOutput),
  create: oc.input(PersonalityCreateInput).output(PersonalityCreateOutput),
  update: oc.input(PersonalityUpdateInput).output(PersonalityUpdateOutput),
  delete: oc.input(PersonalityDeleteInput).output(PersonalityOkOutput),
  duplicate: oc.input(PersonalityDuplicateInput).output(PersonalityDuplicateOutput),
  renderers: oc.input(PersonalityRenderersInput).output(PersonalityRenderersOutput),
  skillsList: oc.input(PersonalitySkillsListInput).output(PersonalitySkillsListOutput),
  skillsGet: oc.input(PersonalitySkillsGetInput).output(PersonalitySkillsGetOutput),
  skillsCreate: oc.input(PersonalitySkillsCreateInput).output(PersonalitySkillsCreateOutput),
  skillsUpdate: oc.input(PersonalitySkillsUpdateInput).output(PersonalitySkillsUpdateOutput),
  skillsDelete: oc.input(PersonalitySkillsDeleteInput).output(PersonalityOkOutput),
  skillsImportGlobal: oc.input(PersonalitySkillsImportInput).output(PersonalitySkillsImportOutput),
  skillCandidatesList: oc
    .input(PersonalitySkillCandidatesListInput)
    .output(PersonalitySkillCandidatesListOutput),
  skillCandidateApprove: oc
    .input(PersonalitySkillCandidateActionInput)
    .output(PersonalitySkillCandidateApproveOutput),
  skillCandidateReject: oc.input(PersonalitySkillCandidateActionInput).output(PersonalityOkOutput),
  mcpSetToken: oc.input(PersonalityMcpSetTokenInput).output(PersonalityMcpSetTokenOutput),
  mcpDeleteToken: oc.input(PersonalityMcpDeleteTokenInput).output(PersonalityMcpDeleteTokenOutput),
  livingSoul: oc.input(PersonalityLivingSoulInput).output(PersonalityLivingSoulOutput),
  mcpExport: oc.input(PersonalityMcpExportInput).output(McpExportViewSchema),
  proposeExpression: oc
    .input(PersonalityProposeExpressionInput)
    .output(PersonalityProposeExpressionOutput),
  applyExpression: oc
    .input(PersonalityApplyExpressionInput)
    .output(PersonalityApplyExpressionOutput),
  revertExpression: oc
    .input(PersonalityRevertExpressionInput)
    .output(PersonalityRevertExpressionOutput),
  proposeSoulSplit: oc
    .input(PersonalityProposeSoulSplitInput)
    .output(PersonalityProposeSoulSplitOutput),
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
  userId: z.string().optional(),
  /** When true, the agent plans tool calls without executing them. The SSE
   *  stream emits a `dry_run_summary` event with the tool plan instead of
   *  running the tools. */
  dryRun: z.boolean().optional(),
  /**
   * How this turn's text reached the client. `voice` means `text` is a
   * transcript of the user speaking (talk-mode), which the server turns into a
   * MESSAGE-LEVEL voice-origin annotation on the turn — never a system-prompt
   * section, because one session mixes typed and spoken turns. Default `text`.
   */
  origin: z.enum(['text', 'voice']).optional(),
  attachments: z
    .array(
      z.object({
        type: z.enum(['image', 'file']),
        data: z.string(),
        mimeType: z.string(),
        name: z.string().optional(),
      }),
    )
    .optional(),
});
const ChatSendOutput = z.object({
  sessionId: z.string(),
  /** Echoed back so a tab knows which turn the SSE stream belongs to. */
  turnId: z.string(),
});

const ChatAbortInput = z.object({ sessionId: z.string() });
const ChatAbortOutput = z.object({ ok: z.literal(true) });

const ChatSteerInput = z.object({ sessionId: z.string(), text: z.string().min(1) });
const ChatSteerOutput = z.object({ ok: z.boolean() });

/** @stable v1 */
const chat = {
  send: oc.input(ChatSendInput).output(ChatSendOutput),
  abort: oc.input(ChatAbortInput).output(ChatAbortOutput),
  steer: oc.input(ChatSteerInput).output(ChatSteerOutput),
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

// ---------------------------------------------------------------------------
// Approvals — time-limited grants (reach-and-containment 3b). Listed and
// revoked from Settings → Approvals; granted through `tools.approve` with
// scope `lease-1h`. Not in the API-key SCOPE_MAP, so cookie-only.
// ---------------------------------------------------------------------------

const ApprovalLeasesListOutput = z.object({ leases: z.array(ApprovalLeaseSchema) });
const ApprovalLeasesRevokeInput = z.object({ id: z.string().min(1) });
const ApprovalLeasesRevokeOutput = z.object({ ok: z.literal(true) });

/** @stable v1 */
const approvals = {
  leases: {
    list: oc.output(ApprovalLeasesListOutput),
    revoke: oc.input(ApprovalLeasesRevokeInput).output(ApprovalLeasesRevokeOutput),
  },
};

const ToolsCatalogInput = z.object({});
const ToolsCatalogOutput = z.object({
  groups: z.array(
    z.object({
      group: z.string(),
      tools: z.array(
        z.object({
          name: z.string(),
          description: z.string().optional(),
        }),
      ),
    }),
  ),
});

/** Mirrors `ToolCapabilities` in `@ethosagent/types` — the declared reach a
 *  tool asks for. Surfaced verbatim so the Personality Edit modal can show what
 *  a tool is allowed to touch before it is added to a toolset. */
const ToolCapabilitiesSchema = z.object({
  network: z.object({ allowedHosts: z.array(z.string()) }).optional(),
  secrets: z.array(z.string()).optional(),
  storage: z
    .object({
      scope: z.enum(['tool-private', 'session', 'personality']),
      kind: z.literal('kv'),
      ttlSecondsDefault: z.number().optional(),
    })
    .optional(),
  fs_reach: z
    .object({
      read: z.union([z.array(z.string()), z.literal('from-personality')]).optional(),
      write: z.union([z.array(z.string()), z.literal('from-personality')]).optional(),
    })
    .optional(),
  process: z.object({ allowedBinaries: z.array(z.string()) }).optional(),
  attachments: z
    .object({ kinds: z.union([z.array(z.enum(['image', 'file'])), z.literal('*')]) })
    .optional(),
});

/** Whether this tool may be ACTUALLY EXECUTED by `tools.test`. Computed
 *  server-side from the tool's declared capabilities; the client never gets to
 *  assert it. `reason` is populated only when `canRun` is false. */
const ToolTestEligibilitySchema = z.object({
  canRun: z.boolean(),
  reason: z.string().optional(),
});

const ToolsDetailInput = z.object({
  name: z.string().min(1),
  /** When supplied, `inPersonalityToolset` reports whether this personality's
   *  toolset reaches the tool. Omitted → the field is absent. */
  personalityId: z.string().optional(),
});
/** Full detail for ONE tool. An unregistered name is not an error: it comes
 *  back well-formed with `registered: false`, which is how the modal tells a
 *  user that their toolset names a tool this deployment does not have. */
const ToolsDetailOutput = z.object({
  name: z.string(),
  description: z.string(),
  toolset: z.string().optional(),
  /** Capitalised `toolset`, or `'Other'` — the same grouping `catalog` uses. */
  group: z.string(),
  /** The tool's JSON schema, passed through untouched. */
  schema: z.record(z.string(), z.unknown()),
  capabilities: ToolCapabilitiesSchema,
  maxResultChars: z.number().optional(),
  requiresApproval: z.boolean().optional(),
  outputIsUntrusted: z.boolean().optional(),
  alwaysInclude: z.boolean().optional(),
  returnDirect: z.boolean().optional(),
  /** The schema itself is NOT dumped here — the tool-settings UI owns it. */
  hasSettingsSchema: z.boolean(),
  pluginId: z.string().optional(),
  /** False when no tool of this name is registered in this deployment. */
  registered: z.boolean(),
  /** False when the tool is registered but its `isAvailable()` says no
   *  (missing API key, absent binary). Always false when `registered` is. */
  available: z.boolean(),
  /** Present only when the request carried a `personalityId`. */
  inPersonalityToolset: z.boolean().optional(),
  testEligibility: ToolTestEligibilitySchema,
});

const ToolsTestInput = z.object({
  name: z.string().min(1),
  personalityId: z.string().min(1),
  /** `'run'` is a REQUEST, not a grant: the server re-derives eligibility and
   *  silently degrades to verify-only for anything it will not execute. */
  mode: z.enum(['verify', 'run']),
});
const ToolsTestOutput = z.object({
  /** Always populated, in both modes, in this order: `registered`,
   *  `available`, `in-toolset`, `args-valid`. A check downstream of a failure
   *  reports `skip`. */
  checks: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      status: z.enum(['pass', 'fail', 'skip']),
      detail: z.string().optional(),
    }),
  ),
  /** True only when the tool was actually executed. */
  ran: z.boolean(),
  /** Present only when `ran` is true. */
  result: z
    .object({
      ok: z.boolean(),
      value: z.string().optional(),
      error: z.string().optional(),
      code: z.string().optional(),
    })
    .optional(),
  /** Wall clock of the execution. Present only when `ran` is true. */
  durationMs: z.number().optional(),
  /** Why a `mode: 'run'` request did or did not execute. */
  testEligibility: ToolTestEligibilitySchema,
});

/** @experimental */
const tools = {
  approve: oc.input(ToolApproveInput).output(ToolApproveOutput),
  deny: oc.input(ToolDenyInput).output(ToolDenyOutput),
  catalog: oc.input(ToolsCatalogInput).output(ToolsCatalogOutput),
  detail: oc.input(ToolsDetailInput).output(ToolsDetailOutput),
  test: oc.input(ToolsTestInput).output(ToolsTestOutput),
};

// ---------------------------------------------------------------------------
// Clarify — resolve a pending `clarify` request (the agent asked the user a
// question mid-turn). The request side flows out over SSE; this is the answer
// path back, mirroring the tool-approval transport.
//
// `listPending` is the catch-up read for the request side, the same role
// `tasks.list` plays for the run digest: the `clarify.request` push is live
// only, so a page that mounts after a delegated run parked on a question has
// no way to learn the question exists. `ClarifyBridge.listPersisted` was
// built for exactly this and had no route to the browser until now.
// ---------------------------------------------------------------------------

const ClarifyRespondInput = z.object({
  requestId: z.string(),
  /** The user's answer — free-form text, or one of the offered options. */
  answer: z.string(),
  /** `user` for a real answer, `cancel` when the user dismissed the card. */
  source: z.enum(['user', 'cancel']),
});
const ClarifyRespondOutput = z.object({ ok: z.literal(true) });

/** Scoped by root session, never by clarify `sessionId`: a delegated run asks
 *  on its CHILD session key (`clarify-escalator.ts`), which no browser is ever
 *  subscribed to. The lane a surface can actually join on is the job (G1). */
const ClarifyListPendingInput = z.object({ rootSessionKey: z.string().min(1) });
/** One open question, shaped so the client can fold it straight into the same
 *  queue the `clarify.request` event feeds. `jobId` is required — every row
 *  here belongs to one of this session's runs by construction. */
const ClarifyListPendingOutput = z.array(
  z.object({
    requestId: z.string(),
    jobId: z.string(),
    question: z.string(),
    options: z.array(z.string()).optional(),
    default: z.string().optional(),
    /** Never null here: only PRESENTED rows are returned, and presentation is
     *  what starts the clock (D2). A row still queued behind another question
     *  in its lane has been shown to nobody and is not offered for answering. */
    defaultDeadlineAt: z.string(),
  }),
);

/** @experimental */
const clarify = {
  respond: oc.input(ClarifyRespondInput).output(ClarifyRespondOutput),
  listPending: oc.input(ClarifyListPendingInput).output(ClarifyListPendingOutput),
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
  completionTested: z.boolean(),
});

const OnboardingCompleteInput = z.object({
  provider: ProviderIdSchema,
  model: z.string().min(1),
  apiKey: z.string().optional(),
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

// -- Settings sub-schemas (Settings page groups without another UI home) ----

/** Retention duration grammar (extensions/observability-sqlite `parseDuration`):
 *  `forever` or `<n>` + d(ays) | w(eeks) | m(onths) | y(ears), e.g. `90d`. */
const RetentionDurationSchema = z.string().regex(/^(forever|\d+[dwmy])$/);

/** Flat retention subkeys — the `<subkey>` in `retention.<subkey>` and
 *  `personalities.<id>.retention.<subkey>` config.yaml keys. */
const RetentionSubkeySchema = z.enum([
  'messages',
  'traces',
  'spans',
  'blobs',
  'archive',
  'channelTranscript',
  'events.error',
  'events.audit',
  'events.channel',
  'events.install',
]);

/** Record keys written as `<prefix>.<key>.<field>` config.yaml lines must
 *  round-trip through the line-based format — same identifier rule as bot ids. */
const ConfigRecordKeySchema = z.string().regex(/^[A-Za-z0-9_-]+$/);

/** One inbound webhook as returned by `config.get` (`webhooks.<hookId>.*`).
 *  The bearer secret NEVER round-trips — only a redacted preview. */
const WebhookGetSchema = z.object({
  /** config.yaml: `webhooks.<hookId>.personalityId` */
  personalityId: z.string(),
  /** Redacted preview of `webhooks.<hookId>.secret` (e.g. "abc…wxyz"). */
  secretPreview: z.string(),
  /** config.yaml: `webhooks.<hookId>.sessionKey` */
  sessionKey: z.string().nullable(),
  /** config.yaml: `webhooks.<hookId>.prefilter` (script under ~/.ethos/scripts/) */
  prefilter: z.string().nullable(),
  /** config.yaml: `webhooks.<hookId>.prefilterTimeoutSeconds` (1-600) */
  prefilterTimeoutSeconds: z.number().nullable(),
  /** config.yaml: `webhooks.<hookId>.mode` — default 'sync'. */
  mode: z.enum(['sync', 'ack']),
});

/** One inbound webhook as accepted by `config.update`. `secret` is write-only:
 *  omit it to keep the stored secret (a brand-new hook gets a generated one). */
const WebhookUpdateSchema = z
  .object({
    personalityId: z.string().min(1),
    /** Write-only bearer secret; never echoed back. Omit to keep/generate. */
    secret: z.string().min(8).optional(),
    sessionKey: z.string().optional(),
    prefilter: z.string().optional(),
    prefilterTimeoutSeconds: z.number().int().min(1).max(600).optional(),
    mode: z.enum(['sync', 'ack']).optional(),
  })
  .refine((h) => h.prefilterTimeoutSeconds === undefined || h.prefilter !== undefined, {
    message: "prefilterTimeoutSeconds requires 'prefilter'",
  });

/** One `/name` quick command (`quick_commands.<name>.*`). `exec` runs an
 *  operator-authored shell command; `reply` returns a canned string. */
const QuickCommandGetSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('exec'),
    command: z.string(),
    gateway: z.boolean(),
    channels: z.array(z.string()),
  }),
  z.object({
    type: z.literal('reply'),
    reply: z.string(),
    gateway: z.boolean(),
    channels: z.array(z.string()),
  }),
]);
const QuickCommandUpdateSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('exec'),
    command: z.string().min(1),
    gateway: z.boolean().optional(),
    channels: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal('reply'),
    reply: z.string().min(1),
    gateway: z.boolean().optional(),
    channels: z.array(z.string()).optional(),
  }),
]);

/** Auxiliary model wiring (`auxiliary.<slot>.*` where slot is compression /
 *  vision / web). API key never round-trips — preview only. */
const AuxModelGetSchema = z.object({
  model: z.string().nullable(),
  provider: z.string().nullable(),
  apiKeyPreview: z.string().nullable(),
  baseUrl: z.string().nullable(),
});
/** Update shape for an auxiliary model slot. `null` clears the stored key. */
const AuxModelUpdateSchema = z.object({
  model: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  /** Write-only; never echoed back. Null deletes the stored key. */
  apiKey: z.string().nullable().optional(),
  baseUrl: z.string().nullable().optional(),
});

/** Roster-entry key. The parser in `@ethosagent/config` matches
 *  `voice.<tts|stt>.providers.([A-Za-z0-9_-]+).<field>`, so a name outside that
 *  charset would serialize to a line the loader silently drops. */
const VoiceProviderNameRegex = /^[A-Za-z0-9_-]+$/;

/** One entry of the named TTS roster (`voice.tts.providers.<name>.*`). Same
 *  field set as the default `auxiliary.tts` entry, because it IS one — the entry
 *  a personality gets when it names no other. API key never round-trips. */
const VoiceProviderEntryGetSchema = z.object({
  /** Registered provider id (`openai-tts`, `local-tts`, `command-tts`, …). */
  provider: z.string(),
  model: z.string().nullable(),
  apiKeyPreview: z.string().nullable(),
  voice: z.string().nullable(),
  baseUrl: z.string().nullable(),
  command: z.string().nullable(),
  outputFormat: z.enum(['opus', 'mp3', 'wav', 'pcm']).nullable(),
  /** `voice.tts.providers.<name>.timeout` — seconds, `command-tts`'s unit. */
  timeout: z.number().nullable(),
  maxTextLength: z.number().nullable(),
});
/** Write shape for one roster entry. Omitting `apiKey` KEEPS the stored key —
 *  the form never receives it, so an absent field cannot mean "clear it". */
const VoiceProviderEntryUpdateSchema = z.object({
  provider: z.string().min(1),
  model: z.string().optional(),
  /** Write-only; never echoed back. Omit to keep the stored key. */
  apiKey: z.string().optional(),
  voice: z.string().optional(),
  baseUrl: z.string().optional(),
  command: z.string().optional(),
  outputFormat: z.enum(['opus', 'mp3', 'wav', 'pcm']).optional(),
  /** Seconds. */
  timeout: z.number().int().min(1).max(3600).optional(),
  maxTextLength: z.number().int().min(100).max(100_000).optional(),
});

/** One entry of the named STT roster (`voice.stt.providers.<name>.*`). The
 *  mirror of the TTS entry over the `auxiliary.asr` field set — no `voice`,
 *  `outputFormat` or `maxTextLength`, which only mean something when producing
 *  audio. API key never round-trips. */
const VoiceSttProviderEntryGetSchema = z.object({
  /** Registered provider id (`openai-stt`, `local-stt`, `command-stt`, …). */
  provider: z.string(),
  model: z.string().nullable(),
  apiKeyPreview: z.string().nullable(),
  baseUrl: z.string().nullable(),
  command: z.string().nullable(),
  /** `voice.stt.providers.<name>.timeout` — seconds, `command-stt`'s unit. */
  timeout: z.number().nullable(),
});
const VoiceSttProviderEntryUpdateSchema = z.object({
  provider: z.string().min(1),
  model: z.string().optional(),
  /** Write-only; never echoed back. Omit to keep the stored key. */
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  command: z.string().optional(),
  /** Seconds. */
  timeout: z.number().int().min(1).max(3600).optional(),
});

/** One entry of the named REALTIME roster (`voice.realtime.providers.<name>.*`)
 *  — hosted speech-to-speech. No `command` or `timeout`: a realtime provider is
 *  a duplex session, not a request you shell out for. `costPerMinuteUsd` is the
 *  provider's published rate, which is what turns session minutes into the cost
 *  `voiceRealtimeSessionBudgetUsd` halts on. API key never round-trips. */
const VoiceRealtimeProviderEntryGetSchema = z.object({
  /** Registered provider id (`openai-realtime`, `gemini-live`, …). */
  provider: z.string(),
  model: z.string().nullable(),
  apiKeyPreview: z.string().nullable(),
  baseUrl: z.string().nullable(),
  voice: z.string().nullable(),
  costPerMinuteUsd: z.number().nullable(),
});
const VoiceRealtimeProviderEntryUpdateSchema = z.object({
  provider: z.string().min(1),
  model: z.string().optional(),
  /** Write-only; never echoed back. Omit to keep the stored key. */
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  voice: z.string().optional(),
  /** USD per minute of audio. Fractional — 6 cents a minute is `0.06`. */
  costPerMinuteUsd: z.number().positive().max(100).optional(),
});

// -- Telephony (`voice.trunk` / `voice.livekit` / `voice.inbound` /
//    `voice.bargeIn` / `voice.bots`) ------------------------------------------
//
// Every one of these keys was previously reachable only by hand-editing
// config.yaml. A phone number is the surface strangers can dial, so its
// allowlist, its budget and the personality that answers it must be visible and
// editable where the operator already manages the deployment — a yaml-only
// telephony key is a guard nobody can see.
//
// Same closed sets the CLI parser enforces, restated as Zod so a bad value is
// refused at the RPC boundary instead of turning into a parse error the next
// time the agent loads its config.

const VoiceTrunkProviderSchema = z.enum(['twilio', 'telnyx', 'generic', 'livekit']);
const VoiceTrunkCodecSchema = z.enum(['opus', 'g711']);
const VoiceInboundPrewarmSchema = z.enum(['allowlisted', 'none', 'all']);

/** One surface's barge-in thresholds, as stored. Every field independently
 *  nullable: an operator tunes the one knob a room is wrong about. */
const VoiceBargeInTuningGetSchema = z.object({
  energyThreshold: z.number().nullable(),
  minSpeechMs: z.number().nullable(),
  silenceMs: z.number().nullable(),
});

/** The write side of one surface's thresholds. Bounds mirror the CLI parser,
 *  which REFUSES an out-of-range value rather than dropping it. */
const VoiceBargeInTuningUpdateSchema = z.object({
  /** Input energy above which the caller counts as speaking, 0 < x <= 1. */
  energyThreshold: z.number().gt(0).max(1).optional(),
  /** Milliseconds of speech before a barge-in is believed. */
  minSpeechMs: z.number().int().min(1).optional(),
  /** Milliseconds of silence that end an utterance. */
  silenceMs: z.number().int().min(1).optional(),
});

/** One `voice.bots[]` entry as stored — the number → bot → personality map. */
const VoiceBotGetSchema = z.object({
  /** `voice.bots.<n>.id`; null when the operator left it to the derived
   *  sha256-of-`match` default. */
  id: z.string().nullable(),
  /** E.164 number or room name (`*` wildcards allowed) this bot answers. */
  match: z.string(),
  bind: z.object({
    type: z.enum(['personality', 'team']),
    name: z.string(),
    /** `voice.bots.<n>.bind.allowSlashSwitch`; false when the key is absent. */
    allowSlashSwitch: z.boolean(),
  }),
});

const VoiceBotUpdateSchema = z.object({
  /** Omit to let the loader derive one from `match`. Must be an identifier
   *  (`[A-Za-z0-9_-]+`) — it becomes part of a config.yaml key. */
  id: z.string().optional(),
  match: z.string().min(1),
  bind: z.object({
    type: z.enum(['personality', 'team']),
    /** Validated against the personality registry when `type` is
     *  `personality` — a bot bound to a personality that does not exist fails
     *  silently on a ringing phone, and this is the last place to catch it. */
    name: z.string().min(1),
    allowSlashSwitch: z.boolean().optional(),
  }),
});

const ConfigGetOutput = z.object({
  provider: z.string(),
  model: z.string(),
  apiKeyPreview: z.string(), // e.g. "sk-…abc1"
  baseUrl: z.string().nullable(),
  personality: z.string(),
  memory: z.enum(['markdown', 'vector', 'vault']),
  modelRouting: z.record(z.string(), z.string()),
  /** Currently selected skin (one of the BUILTIN_SKINS names). */
  skin: z.string(),
  providers: z.array(
    ProviderEntrySchema.extend({
      /** `providers.<n>.id` — the stable key a `modelRegistry.<alias>.provider`
       *  may reference (D24). Null when the entry carries none. */
      id: z.string().nullable(),
      /** `providers.<n>.failover`, resolved: absent in the file reads `true`
       *  (D23b). `false` = a credential that is not a chain hop. */
      failover: z.boolean(),
    }),
  ),
  /** Opaque token for the stored chain `providers` came from. `config.update`
   *  requires it back with a `providers` list and refuses a stale one with
   *  `CONFIG_CONFLICT` (409). */
  providersVersion: z.string(),
  /** What the provider-chain codec dropped out of config.yaml and why (a
   *  `providers.<n>` index with no `provider` line loses the whole entry). */
  providersNotices: z.array(z.string()),
  approvalMode: z.enum(['manual', 'smart', 'off']),
  verbosity: z.enum(['concise', 'balanced', 'verbose']),
  debugMode: z.boolean(),
  contextLayering: z.boolean(),
  debugPanelEnabled: z.boolean(),
  debugPanelModel: z.string().nullable(),
  adminEnabled: z.boolean(),
  /** Channel streaming draft edits (display.streaming_edits). */
  streamingEdits: z.enum(['off', 'dms', 'all']),
  /** Call Stage treatment (display.call_style). `personality` — the default —
   *  lets each personality draw its own, declared or derived from its id. */
  callStyle: z.enum(['liquid', 'orb', 'rings', 'personality']),
  /** In-call overlay color (display.call_accent): `personality` or `#RRGGBB`. */
  callAccent: z.string(),
  /** Auto-compact long sessions near the model window (compaction.autoCompact). */
  autoCompact: z.boolean(),
  /** Silent memory-flush turn (memoryConsolidation.enabled). */
  memoryConsolidationEnabled: z.boolean(),
  /** Proactive mid-conversation fact capture (memoryCapture.enabled). */
  memoryCaptureEnabled: z.boolean(),
  /** Cheap model for capture extraction (memoryCapture.model); null = default. */
  memoryCaptureModel: z.string().nullable(),
  /** CLI "· remembered: …" capture notice (display.memory_notices). */
  memoryNotices: z.boolean(),
  /** Talk-mode processing chime / earcon (display.voice_chime); default true. */
  voiceChime: z.boolean(),
  /** VAD endpoint silence in ms (display.voice_endpoint_silence_ms); default 700. */
  voiceEndpointSilenceMs: z.number(),
  /** Barge-in RMS threshold during playout (display.voice_barge_threshold); default 0.06. */
  voiceBargeThreshold: z.number(),
  /** Sustained-speech ms before barge-in (display.voice_barge_sustain_ms); default 250. */
  voiceBargeSustainMs: z.number(),
  /** Listening speech RMS threshold (display.voice_speech_threshold); default 0.02. */
  voiceSpeechThreshold: z.number(),
  /** Minimum speech ms before an utterance counts (display.voice_speech_min_ms); default 150. */
  voiceSpeechMinMs: z.number(),
  voiceProvider: z.string().nullable(),
  voiceApiKeyPreview: z.string().nullable(),
  voiceBaseUrl: z.string().nullable(),
  voiceModel: z.string().nullable(),
  voiceTtsProvider: z.string().nullable(),
  voiceTtsApiKeyPreview: z.string().nullable(),
  voiceTtsVoice: z.string().nullable(),
  voiceTtsBaseUrl: z.string().nullable(),
  voiceTtsModel: z.string().nullable(),
  /** `auxiliary.asr.command` — shell template the `command-stt` provider runs. */
  voiceSttCommand: z.string().nullable(),
  /** `auxiliary.tts.command` — shell template the `command-tts` provider runs. */
  voiceTtsCommand: z.string().nullable(),
  /** `auxiliary.tts.outputFormat` — container the TTS provider is asked for. */
  voiceTtsOutputFormat: z.enum(['opus', 'mp3', 'wav', 'pcm']).nullable(),
  /** `auxiliary.tts.timeout`, seconds. */
  voiceTtsTimeoutMs: z.number().nullable(),
  /** `auxiliary.tts.maxTextLength` — chars per synthesis request. */
  voiceTtsMaxTextLength: z.number().nullable(),
  /** `auxiliary.asr.timeout`, seconds. */
  voiceSttTimeoutMs: z.number().nullable(),
  /** `voice.trustedPlugins` — the local-only egress allowlist. `null` = key
   *  absent = gate OFF; a list arms it (providers with `caps.local` always pass). */
  voiceTrustedPlugins: z.array(z.string()).nullable(),
  /** `voice.defaultMode` — where a new channel lane starts. */
  voiceDefaultMode: z.enum(['off', 'mirror_inbound', 'all']).nullable(),
  /** `voice.channels.<platform>.ttsOut` — which channels speak their replies
   *  without being asked, keyed by platform id. A platform ABSENT from the map
   *  has no override and inherits `voiceDefaultMode`; an explicit `false` means
   *  "never speak here" and outranks a lane's own mode. */
  voiceChannelTtsOut: z.record(z.string(), z.boolean()),
  /** `voice.transcode.ffmpegPath` — null = `ffmpeg` on PATH. */
  voiceTranscodeFfmpegPath: z.string().nullable(),
  /** `voice.transcode.bitrateKbps` — null = the built-in 32 kbps. */
  voiceTranscodeBitrateKbps: z.number().nullable(),
  /** `voice.transcode.timeout`, SECONDS (the unit ffmpeg's budget is set in);
   *  null = the built-in 30s. */
  voiceTranscodeTimeoutSec: z.number().nullable(),
  /** `voice.artifacts.abandonAfterDays` — null = the built-in 7 days. */
  voiceArtifactAbandonAfterDays: z.number().nullable(),
  /** `voice.artifacts.maxTotalMb` — null = the built-in 512 MiB. */
  voiceArtifactMaxTotalMb: z.number().nullable(),
  /** `voice.tts.providers.<name>.*` — the named TTS roster, keyed by the
   *  operator's label. `auxiliary.tts` (the `voiceTts*` fields above) stays the
   *  DEFAULT entry and is NOT repeated here. Empty object = no roster.
   *  The older `voice.providers.*` spelling is read into this same map. */
  voiceTtsProviders: z.record(z.string(), VoiceProviderEntryGetSchema),
  /** `voice.stt.providers.<name>.*` — the named STT roster. `auxiliary.asr`
   *  (the `voiceProvider` / `voiceModel` / … fields above) stays the DEFAULT
   *  entry and is NOT repeated here. */
  voiceSttProviders: z.record(z.string(), VoiceSttProviderEntryGetSchema),
  /** `voice.realtime.providers.<name>.*` — the named realtime roster. Unlike
   *  the other two this roster has no `auxiliary.*` default entry; the default
   *  is `voiceRealtimeDefault`, which NAMES one of these. */
  voiceRealtimeProviders: z.record(z.string(), VoiceRealtimeProviderEntryGetSchema),
  /** `voice.realtime.default` — the realtime roster entry a personality that
   *  names none gets. A label from `voiceRealtimeProviders`, never a provider
   *  id. Null = key absent. */
  voiceRealtimeDefault: z.string().nullable(),
  /** `voice.tier` — the deployment's default voice engine. Null = key absent
   *  (the surface decides). */
  voiceTier: z.enum(['pipeline', 'realtime']).nullable(),
  /** `voice.realtime.sessionBudgetUsd` — USD cap on ONE realtime session's
   *  accrued cost. Null = no cap. */
  voiceRealtimeSessionBudgetUsd: z.number().nullable(),
  // -- Telephony read side (see the block above the schemas) -----------------
  /** `voice.trunk.provider` — selects the inbound webhook signature scheme. */
  voiceTrunkProvider: VoiceTrunkProviderSchema.nullable(),
  /** `voice.trunk.trunkId` — the LiveKit SIP trunk the number is attached to. */
  voiceTrunkId: z.string().nullable(),
  /** `voice.trunk.fromNumber` — caller ID presented on outbound calls (E.164). */
  voiceTrunkFromNumber: z.string().nullable(),
  /** `voice.trunk.username` — SIP registrar/auth username. */
  voiceTrunkUsername: z.string().nullable(),
  /** `voice.trunk.password`, REDACTED (`sk-…abc1`). The raw value never leaves
   *  the service layer, so the browser is never handed a credential to type
   *  back — which is why a blank incoming `voiceTrunkPassword` KEEPS the stored
   *  secret instead of erasing it. Null = unset. */
  voiceTrunkPasswordPreview: z.string().nullable(),
  /** `voice.trunk.webhookSecret`, REDACTED. Same rule as the password: this one
   *  authenticates the TRUNK to us on an inbound leg, so it rotates
   *  independently. Null = unset. */
  voiceTrunkWebhookSecretPreview: z.string().nullable(),
  /** `voice.trunk.webhookPath` — where the inbound listener mounts, e.g.
   *  `/voice/inbound`. Null = the listener's own default. */
  voiceTrunkWebhookPath: z.string().nullable(),
  /** `voice.trunk.codec` — null leaves the choice to the bridge's negotiation. */
  voiceTrunkCodec: VoiceTrunkCodecSchema.nullable(),
  /** `voice.livekit.url` — the LiveKit server the SIP leg bridges into. */
  voiceLivekitUrl: z.string().nullable(),
  /** `voice.livekit.apiKey`, REDACTED. */
  voiceLivekitApiKeyPreview: z.string().nullable(),
  /** `voice.livekit.apiSecret`, REDACTED. */
  voiceLivekitApiSecretPreview: z.string().nullable(),
  /** `voice.inbound.allowlist` — caller numbers that reach the owner's own
   *  personality. Null = key absent, which the consumer reads as "screen
   *  everyone through the receptionist". An explicitly EMPTY allowlist is not
   *  expressible on disk; `voiceInboundReceptionist` IS that policy. */
  voiceInboundAllowlist: z.array(z.string()).nullable(),
  /** `voice.inbound.receptionist` — personality answering non-allowlisted
   *  callers, in a restricted scope. */
  voiceInboundReceptionist: z.string().nullable(),
  /** `voice.inbound.concurrencyCap` — ceiling on concurrent inbound calls. */
  voiceInboundConcurrencyCap: z.number().nullable(),
  /** `voice.inbound.perCallerPerHour` — per-caller ceiling in a rolling hour. */
  voiceInboundPerCallerPerHour: z.number().nullable(),
  /** `voice.inbound.dailyBudgetUsd` — daily spend ceiling across inbound calls. */
  voiceInboundDailyBudgetUsd: z.number().nullable(),
  /** `voice.inbound.prewarm` — which callers get the realtime socket opened
   *  during ring. */
  voiceInboundPrewarm: VoiceInboundPrewarmSchema.nullable(),
  /** `voice.inbound.owner.platform` — where call summaries and refusal notices
   *  are delivered. Required together with the chat id. */
  voiceInboundOwnerPlatform: z.string().nullable(),
  /** `voice.inbound.owner.chatId`. */
  voiceInboundOwnerChatId: z.string().nullable(),
  /** `voice.inbound.owner.botKey` — which bot delivers the notice in a
   *  multi-bot deployment. Null = the default bot. */
  voiceInboundOwnerBotKey: z.string().nullable(),
  /** `voice.bargeIn.<surface>.*`, keyed by surface (`call` / `satellite` /
   *  `browser`; an unset `browser` reads through the legacy `display.voice_*`
   *  keys as a fallback — see `readLegacyBrowserBargeInTuning`). A surface
   *  ABSENT from the map was never tuned — which is a different fact from
   *  "tuned to the defaults" and is why this is a map and not fixed objects. */
  voiceBargeIn: z.record(z.string(), VoiceBargeInTuningGetSchema),
  /**
   * `voice.filler.*` — the tool-call filler/tick keep-alive `VoiceSession`
   * plays during a long tool call. Global, applied to every lane the same
   * way — unlike `voiceBargeIn`, there is no per-surface split. `enabled` is
   * never null (absent = true = on); the other three are null when unset, so
   * the built-in default applies.
   */
  voiceFiller: z.object({
    enabled: z.boolean(),
    afterMs: z.number().nullable(),
    text: z.string().nullable(),
    tickIntervalMs: z.number().nullable(),
  }),
  /** `voice.bots[]` — the number → bot → personality table, in file order. */
  voiceBots: z.array(VoiceBotGetSchema),
  // -- Settings-page additions (keys with no other UI home) ------------------
  /** Azure-only REST API version (`apiVersion`); null when unset. */
  apiVersion: z.string().nullable(),
  /** Per-turn timing summary after every response (`verbose`); default false. */
  verbose: z.boolean(),
  /** Chat-surface verbosity (`display.verbosity`); default 'default'. */
  displayVerbosity: z.enum(['quiet', 'default', 'verbose', 'debug']),
  /** What Enter does mid-turn (`display.busy_input_mode`); default 'interrupt'. */
  displayBusyInputMode: z.enum(['interrupt', 'queue', 'steer']),
  /** Tool feed arg truncation, 0 = none (`display.tool_preview_length`); default 0. */
  displayToolPreviewLength: z.number(),
  /** Show resume hint on chat exit (`display.resume_hint`); default true. */
  displayResumeHint: z.boolean(),
  /** Turn pairs in the resume recap panel, 0 disables (`display.resume_recap_turns`); default 3. */
  displayResumeRecapTurns: z.number(),
  /** Terminal bell when a background task finishes (`display.bell_on_complete`); default false. */
  displayBellOnComplete: z.boolean(),
  /** Context-compaction gate thresholds (`compaction.*`). `autoCompact` is the
   *  sibling top-level field above; the rest of the group lives here. */
  compaction: z.object({
    /** `compaction.pressure` — gate fraction in (0,1]; null = 0.8 default. */
    pressure: z.number().nullable(),
    /** `compaction.target` — shrink-to fraction in (0,1]; null = 0.7 default. */
    target: z.number().nullable(),
    /** `compaction.gateDelta` — token headroom, integer >= 0; null = unset. */
    gateDelta: z.number().nullable(),
    /** `compaction.retryOnOverflow` — compact-and-retry on overflow; default true. */
    retryOnOverflow: z.boolean(),
    /** `compaction.abortOnSummaryFailure` — surface a failed emergency summary
     *  as its own error instead of the generic overflow rejection; default false. */
    abortOnSummaryFailure: z.boolean(),
    /** `compaction.smallWindow` — small-window-mode override; default 'auto'. */
    smallWindow: z.enum(['auto', 'on', 'off']),
  }),
  /** Bring-your-own-vault backend (`memoryVault.*`); read when memory = 'vault'. */
  memoryVault: z.object({
    /** `memoryVault.path` — absolute vault root; null = unset. */
    path: z.string().nullable(),
    /** `memoryVault.agentDir` — subtree the agent owns; null = 'Ethos' default. */
    agentDir: z.string().nullable(),
    /** `memoryVault.prefetch` — keys prefetched into the prompt tail. */
    prefetch: z.array(z.string()),
    /** `memoryVault.exclude` — names hidden from list + search. */
    exclude: z.array(z.string()),
  }),
  /** Approve-before-store gate (`memoryApproval.*`). */
  memoryApproval: z.object({
    /** `memoryApproval.mode` — default 'off'. */
    mode: z.enum(['off', 'automated', 'all']),
    /** `memoryApproval.cap` — per-scope pending-queue cap; default 200. */
    cap: z.number(),
    /** `memoryApproval.ttlDays` — pending-candidate TTL; default 30. */
    ttlDays: z.number(),
  }),
  /** Decay tuning + silent-flush tunables (`memoryConsolidation.*`). The
   *  `enabled` flag is the sibling `memoryConsolidationEnabled` field above. */
  memoryConsolidation: z.object({
    /** `memoryConsolidation.halfLifeDays` — recency half-life; default 30. */
    halfLifeDays: z.number(),
    /** `memoryConsolidation.threshold` — archive-below weight; default 0.05. */
    threshold: z.number(),
    /** `memoryConsolidation.exemptUser` — exempt USER.md from decay; default true. */
    exemptUser: z.boolean(),
    /** `memoryConsolidation.flushThreshold` — flush trigger fraction; default 0.7. */
    flushThreshold: z.number(),
    /** `memoryConsolidation.timeboxMs` — flush-turn timebox; default 30000. */
    timeboxMs: z.number(),
    /** `memoryConsolidation.maxTokens` — flush-turn token cap; default 1024. */
    maxTokens: z.number(),
    /** `memoryConsolidation.maxDeltaChars` — max chars written per flush; default 4000. */
    maxDeltaChars: z.number(),
    /** `memoryConsolidation.minMessagesSinceFlush` — flush spacing; default 8. */
    minMessagesSinceFlush: z.number(),
  }),
  /** Proactive capture wiring (`memoryCapture.*`). `enabled`/`model` are the
   *  sibling `memoryCaptureEnabled`/`memoryCaptureModel` fields above. */
  memoryCapture: z.object({
    /** `memoryCapture.provider` — aux provider; null = primary provider. */
    provider: z.string().nullable(),
    /** Redacted preview of `memoryCapture.apiKey`; null when unset. */
    apiKeyPreview: z.string().nullable(),
    /** `memoryCapture.baseUrl`; null = primary baseUrl. */
    baseUrl: z.string().nullable(),
    /** `memoryCapture.maxPerHour` — captures/hour per scope; default 6. */
    maxPerHour: z.number(),
    /** `memoryCapture.maxPerDay` — captures/day per scope; default 30. */
    maxPerDay: z.number(),
  }),
  /** Background sub-agent job pool (`background.<snake_case>` keys). */
  background: z.object({
    /** `background.enabled`; default false. */
    enabled: z.boolean(),
    /** `background.max_concurrent_jobs`; default 2. */
    maxConcurrentJobs: z.number(),
    /** `background.max_jobs_per_root`; default 3. */
    maxJobsPerRoot: z.number(),
    /** `background.max_jobs_per_personality`; default 5. */
    maxJobsPerPersonality: z.number(),
    /** `background.default_max_cost_usd`; default 1. */
    defaultMaxCostUsd: z.number(),
    /** `background.max_root_background_usd`; default 5. */
    maxRootBackgroundUsd: z.number(),
    /** `background.queued_ttl_ms`; default 900000. */
    queuedTtlMs: z.number(),
    /** `background.stale_ms`; default 90000. */
    staleMs: z.number(),
    /** `background.heartbeat_ms`; default 30000. */
    heartbeatMs: z.number(),
    /** `background.retention_days`; default 30. */
    retentionDays: z.number(),
  }),
  /** Global retention TTLs (`retention.<subkey>`), only the keys actually set. */
  retention: z.partialRecord(RetentionSubkeySchema, RetentionDurationSchema),
  /** Per-personality retention overrides (`personalities.<id>.retention.<subkey>`). */
  personalityRetention: z.record(
    z.string(),
    z.partialRecord(RetentionSubkeySchema, RetentionDurationSchema),
  ),
  /** Inbound webhooks (`webhooks.<hookId>.*`); secrets redacted. */
  webhooks: z.record(z.string(), WebhookGetSchema),
  /** User-defined `/name` shortcuts (`quick_commands.<name>.*`). */
  quickCommands: z.record(z.string(), QuickCommandGetSchema),
  /** Per-channel toolset narrowing (`channel_toolsets.<platform>`). */
  channelToolsets: z.record(z.string(), z.array(z.string())),
  /**
   * Scheduled local snapshots of `~/.ethos` (`backup.*`, plan
   * agent-state-backup.md §3). Reported RAW, as config.yaml carries it —
   * `null` / `[]` mean the key is unset, not that the feature is off. The
   * effective values are computed by `resolveBackupSettings` in
   * `@ethosagent/wiring` and reported by `backup.status`; this namespace
   * transports what the operator wrote, and nothing else.
   */
  backup: z.object({
    /** `backup.enabled`; default true — on unless explicitly disabled. */
    enabled: z.boolean(),
    /** `backup.cron` — 5-field cron; null = built-in default (`0 4 * * *`). */
    cron: z.string().nullable(),
    /** `backup.scope`; empty = the built-in default scopes. Scope NAMES are
     *  validated where the backup runs (`parseScopes`), never here — the
     *  roster lives in `@ethosagent/wiring` and a copy of it is the drift
     *  the D1 gate exists to prevent. */
    scope: z.array(z.string()),
    /** `backup.keep` — archives rotation keeps; null = built-in default (7). */
    keep: z.number().nullable(),
    /** `backup.dir`; null = `<ethosDir>/backups`, computed in code (D5).
     *  `${ETHOS_HOME}` is NOT expanded in config.yaml. */
    dir: z.string().nullable(),
  }),
  /** Governed-learning nightly pass (`nightlyPass.*`). */
  nightlyPass: z.object({
    /** `nightlyPass.enabled`; default false. */
    enabled: z.boolean(),
    /** `nightlyPass.cron` — 5-field cron; default '0 3 * * *'. */
    cron: z.string(),
  }),
  /** Weekly governed-learning digest (`weeklyDigest.*`). */
  weeklyDigest: z.object({
    /** `weeklyDigest.enabled`; default false. */
    enabled: z.boolean(),
    /** `weeklyDigest.cron`; default '0 9 * * 1'. */
    cron: z.string(),
    /** `weeklyDigest.recipients` — email allowlist for --email delivery. */
    recipients: z.array(z.string()),
  }),
  /** Remote model catalog (`modelCatalog.*`); per-provider URL overrides stay file-only. */
  modelCatalog: z.object({
    /** `modelCatalog.enabled`; default true. */
    enabled: z.boolean(),
    /** `modelCatalog.url`; null = built-in endpoint. */
    url: z.string().nullable(),
    /** `modelCatalog.ttlHours`; default 24. */
    ttlHours: z.number(),
  }),
  /** Error-log rotation (`logs.rotation.*`). */
  logsRotation: z.object({
    /** `logs.rotation.enabled`; default true. */
    enabled: z.boolean(),
    /** `logs.rotation.maxBytes`; null = built-in default. */
    maxBytes: z.number().nullable(),
    /** `logs.rotation.maxFiles`; null = built-in default. */
    maxFiles: z.number().nullable(),
  }),
  /** `web.search_backend` — web_search backend; null = auto. */
  webSearchBackend: z.enum(['exa', 'tavily', 'brave']).nullable(),
  /** `web.extract_backend` — web_extract backend; null = auto. */
  webExtractBackend: z.enum(['htmltext']).nullable(),
  /** `web.searxng.url` — self-hosted metasearch endpoint; null = not configured. */
  webSearxngUrl: z.string().nullable(),
  /** Context-compression summarizer model (`auxiliary.compression.*`). */
  auxCompression: AuxModelGetSchema,
  /** Vision fallback model (`auxiliary.vision.*`). */
  auxVision: AuxModelGetSchema,
  /** web_extract summarizer model (`auxiliary.web.*`). */
  auxWeb: AuxModelGetSchema,
  /** Agent-to-Agent surface gate (`a2a.enabled`); default false. */
  a2aEnabled: z.boolean(),
  /** Auto-install plugins from plugins.lock (`plugins.auto_install`); null = unset. */
  pluginsAutoInstall: z.boolean().nullable(),
  /** Public web UI URL, OAuth redirect base (`webBaseUrl`); null = localhost default. */
  webBaseUrl: z.string().nullable(),
  /** `retention.vacuumAfterPrune` — VACUUM the session DB after a prune sweep;
   *  default false (opt-in). */
  retentionVacuumAfterPrune: z.boolean(),
  /** `retention.minVacuumIntervalDays` — days that must pass between VACUUMs;
   *  null = no minimum interval. */
  retentionMinVacuumIntervalDays: z.number().nullable(),
  /** `logs.level` — lowest severity `ConsoleLogger` prints; default 'debug',
   *  which is the ungated behaviour the level tier replaced. */
  logsLevel: z.enum(['debug', 'info', 'warn', 'error']),
  /** `memory.charLimits.*` — per-key ceilings for the markdown memory backend. */
  memoryCharLimits: z.object({
    /** `memory.charLimits.memory` — MEMORY.md ceiling; default 524288. */
    memory: z.number(),
    /** `memory.charLimits.user` — USER.md ceiling; default 524288. */
    user: z.number(),
  }),
  /** `execution.docker.*` — container resource caps for the docker backend. */
  executionDocker: z.object({
    /** `execution.docker.cpu` — core count, may be fractional; default 2. */
    cpu: z.number(),
    /** `execution.docker.diskMb` — best-effort `--storage-opt size=<N>m` quota,
     *  enforceable only on btrfs/zfs/devicemapper or overlay2-on-xfs; null = no
     *  quota. */
    diskMb: z.number().nullable(),
  }),
  /**
   * `execution.ssh.*` — the deployment's single remote execution target
   * (plan/phases/remote-execution-routing.md D2). Reported RAW, as config.yaml
   * carries it: `host` being non-null is the switch that makes the ssh backend
   * configurable at all, so a defaulted value here would claim a target that
   * does not exist.
   */
  executionSsh: z.object({
    /** `execution.ssh.host`; null = no remote target on this deployment. */
    host: z.string().nullable(),
    /** `execution.ssh.user`; null = the local username, as ssh(1) defaults. */
    user: z.string().nullable(),
    /** `execution.ssh.port`; null = 22. */
    port: z.number().nullable(),
    /** `execution.ssh.identityFile` — key PATH or a running ssh-agent (D3). */
    identityFile: z.string().nullable(),
    /** `execution.ssh.knownHostsFile`; null = ssh's own default. */
    knownHostsFile: z.string().nullable(),
    /** `execution.ssh.strictHostKeys`; null = the backend's default. */
    strictHostKeys: z.enum(['accept-new', 'yes']).nullable(),
    /** `execution.ssh.remoteWorkdir`; null = the remote login directory (D8). */
    remoteWorkdir: z.string().nullable(),
  }),
  /** `kanban.*` — board WIP caps. Null = uncapped. */
  kanban: z.object({
    /** `kanban.maxInProgress` — running tasks across the whole board. */
    maxInProgress: z.number().nullable(),
    /** `kanban.maxInProgressPerProfile` — running tasks per assignee. */
    maxInProgressPerProfile: z.number().nullable(),
  }),
  /** `cron.maxParallelJobs` — concurrent cron firings; null = uncapped. */
  cronMaxParallelJobs: z.number().nullable(),
  /** `toolLoop.*` — soft-warn tiers below the hard per-turn caps. Null = no
   *  warn tier, which is the default. */
  toolLoop: z.object({
    /** `toolLoop.maxToolCallsWarnAt` */
    maxToolCallsWarnAt: z.number().nullable(),
    /** `toolLoop.maxIdenticalToolCallsWarnAt` */
    maxIdenticalToolCallsWarnAt: z.number().nullable(),
  }),
  /** `browser.*` — Playwright budgets plus launch posture. */
  browser: z.object({
    /** `browser.navigationTimeoutMs`; default 30000. */
    navigationTimeoutMs: z.number(),
    /** `browser.commandTimeoutMs`; default 10000. */
    commandTimeoutMs: z.number(),
    /** `browser.headed` — three-state; `'auto'` (the default) is carried
     *  verbatim and resolved by the session factory, never here. */
    headed: z.union([z.boolean(), z.literal('auto')]),
    /** `browser.idleTimeoutMs`; default 600000. */
    idleTimeoutMs: z.number(),
    /** `browser.stealth.enabled`; default false — absence is never on. */
    stealthEnabled: z.boolean(),
    /** `browser.profiles.enabled`; default false — absence is never on, the
     *  same as `stealthEnabled`. The runtime agrees: `buildLaunchOptions` in
     *  `@ethosagent/tools-browser` requires an explicit `=== true`. */
    profilesEnabled: z.boolean(),
    /** `browser.proxy.server`; null = no upstream proxy. */
    proxyServer: z.string().nullable(),
    /** `browser.proxy.username`; null = unauthenticated proxy. */
    proxyUsername: z.string().nullable(),
    /** REDACTED preview of `browser.proxy.password`. The raw credential never
     *  leaves web-api. */
    proxyPasswordPreview: z.string().nullable(),
  }),
  /** `gateway.maxInboundMediaBytes` — one cap the four channel adapters read as
   *  an override; null = each adapter's own platform default, which is 25 MB on
   *  all four (Discord, Telegram, Slack, WhatsApp). */
  gatewayMaxInboundMediaBytes: z.number().nullable(),
  /** `teamSupervisor.restartLoopGuard.*` — the member auto-restart brake.
   *  Unset = 5 respawns in 60s, one more than the previous hardcoded guard,
   *  which gave up on the fifth crash and so performed four restarts. */
  teamSupervisorRestartLoopGuard: z.object({
    /** `teamSupervisor.restartLoopGuard.maxRestarts` — respawns allowed inside
     *  the window; unset = 5. */
    maxRestarts: z.number(),
    /** `teamSupervisor.restartLoopGuard.windowSeconds`; unset = 60. */
    windowSeconds: z.number(),
  }),
  /** `discord.missedMessageBackfill.*` — bounds on the channel-history read the
   *  adapter does the first time it sees a lane. */
  discordMissedMessageBackfill: z.object({
    /** `discord.missedMessageBackfill.enabled`; default true. */
    enabled: z.boolean(),
    /** `discord.missedMessageBackfill.windowSeconds`; null = no age bound. */
    windowSeconds: z.number().nullable(),
    /** `discord.missedMessageBackfill.limit`; default 50, Discord's own ceiling is 100. */
    limit: z.number(),
  }),
});

// For the Settings-page additions below, every scalar accepts `null` meaning
// "delete the config.yaml key and fall back to the built-in default" —
// `undefined`/omitted always means "leave unchanged". Record fields
// (webhooks, quickCommands, channelToolsets, retention, personalityRetention)
// are full replacements: entries absent from the provided record are removed.
const ConfigUpdateInput = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  personality: z.string().optional(),
  memory: z.enum(['markdown', 'vector', 'vault']).optional(),
  modelRouting: z.record(z.string(), z.string()).optional(),
  skin: z.string().optional(),
  providers: z
    .array(
      z.object({
        provider: z.string(),
        model: z.string().optional(),
        apiKey: z.string().optional(),
        baseUrl: z.string().optional(),
        /** `providers.<n>.id`. Omitted = keep the stored entry's id; `null` or
         *  `''` = clear it; a string = set it (`[A-Za-z0-9_-]+`, unique across
         *  the rows). Clearing or renaming an id a `modelRegistry` entry
         *  references is refused naming the aliases (`assertProviderIds`,
         *  apps/web-api config.service.ts). */
        id: z.string().max(200).nullable().optional(),
        /** `providers.<n>.failover`. Omitted = keep the stored flag; `false`
         *  writes `failover: false`; `true` restores the default (a stored
         *  `false` line is removed, a stored `true` line is kept). */
        failover: z.boolean().optional(),
        /** Index in `config.get`'s `providers` the row was loaded from; the
         *  server keeps that entry's key and provider-specific fields
         *  (`overlayProviderRow`, apps/web-api config.service.ts). Absent for
         *  a row added in the editor. */
        sourceIndex: z.number().int().nonnegative().optional(),
      }),
    )
    .optional(),
  /** `config.get`'s `providersVersion` the `providers` list was built from.
   *  Required whenever `providers` is sent — `assertProviderRows`
   *  (apps/web-api config.service.ts) refuses a list without it. */
  providersVersion: z.string().optional(),
  approvalMode: z.enum(['manual', 'smart', 'off']).optional(),
  verbosity: z.enum(['concise', 'balanced', 'verbose']).optional(),
  debugMode: z.boolean().optional(),
  contextLayering: z.boolean().optional(),
  debugPanelEnabled: z.boolean().optional(),
  debugPanelModel: z.string().nullable().optional(),
  adminEnabled: z.boolean().optional(),
  streamingEdits: z.enum(['off', 'dms', 'all']).optional(),
  callStyle: z.enum(['liquid', 'orb', 'rings', 'personality']).optional(),
  /** `personality` or `#RRGGBB`; anything else resolves to `personality`. */
  callAccent: z.string().optional(),
  autoCompact: z.boolean().optional(),
  memoryConsolidationEnabled: z.boolean().optional(),
  memoryCaptureEnabled: z.boolean().optional(),
  memoryCaptureModel: z.string().optional(),
  memoryNotices: z.boolean().optional(),
  voiceChime: z.boolean().optional(),
  voiceEndpointSilenceMs: z.number().min(300).max(1500).optional(),
  voiceBargeThreshold: z.number().min(0.02).max(0.2).optional(),
  voiceBargeSustainMs: z.number().min(100).max(800).optional(),
  voiceSpeechThreshold: z.number().min(0.005).max(0.1).optional(),
  voiceSpeechMinMs: z.number().min(100).max(500).optional(),
  voiceProvider: z.string().optional(),
  voiceApiKey: z.string().optional(),
  voiceBaseUrl: z.string().optional(),
  voiceModel: z.string().optional(),
  voiceTtsProvider: z.string().optional(),
  voiceTtsApiKey: z.string().optional(),
  voiceTtsVoice: z.string().optional(),
  voiceTtsBaseUrl: z.string().optional(),
  voiceTtsModel: z.string().optional(),
  /** `auxiliary.asr.command` — `command-stt`'s shell template; null clears the key. */
  voiceSttCommand: z.string().nullable().optional(),
  /** `auxiliary.tts.command` — `command-tts`'s shell template; null clears the key. */
  voiceTtsCommand: z.string().nullable().optional(),
  /** `auxiliary.tts.outputFormat`; null clears the key. */
  voiceTtsOutputFormat: z.enum(['opus', 'mp3', 'wav', 'pcm']).nullable().optional(),
  /** `auxiliary.tts.timeout`, seconds; null clears the key. */
  voiceTtsTimeoutMs: z.number().int().min(1).max(3600).nullable().optional(),
  /** `auxiliary.tts.maxTextLength`, chars; null clears the key. */
  voiceTtsMaxTextLength: z.number().int().min(100).max(100_000).nullable().optional(),
  /** `auxiliary.asr.timeout`, seconds; null clears the key. */
  voiceSttTimeoutMs: z.number().int().min(1).max(3600).nullable().optional(),
  /** `voice.trustedPlugins`; null (or an empty list) clears the key, which
   *  turns the local-only egress gate OFF. */
  voiceTrustedPlugins: z.array(z.string()).nullable().optional(),
  /** `voice.defaultMode`; null clears the key (back to `mirror_inbound`). */
  voiceDefaultMode: z.enum(['off', 'mirror_inbound', 'all']).nullable().optional(),
  /** `voice.channels.<platform>.ttsOut`. Present = REPLACE the whole map (every
   *  `voice.channels.` key is dropped, then these are written), so an omitted
   *  platform loses its override. Keys are validated against the platform ids
   *  `@ethosagent/config` accepts; an unknown one is REFUSED here rather than
   *  dropped, because at an RPC boundary there is a caller to tell. */
  voiceChannelTtsOut: z.record(z.string(), z.boolean()).optional(),
  /** `voice.transcode.ffmpegPath`; null clears the key. */
  voiceTranscodeFfmpegPath: z.string().nullable().optional(),
  /** `voice.transcode.bitrateKbps`, 8–320; null clears the key. */
  voiceTranscodeBitrateKbps: z.number().int().min(8).max(320).nullable().optional(),
  /** `voice.transcode.timeout`, SECONDS, 1–600; null clears the key. */
  voiceTranscodeTimeoutSec: z.number().int().min(1).max(600).nullable().optional(),
  /** `voice.artifacts.abandonAfterDays`, 1–365; null clears the key. */
  voiceArtifactAbandonAfterDays: z.number().int().min(1).max(365).nullable().optional(),
  /** `voice.artifacts.maxTotalMb`, 1–102400; null clears the key. */
  voiceArtifactMaxTotalMb: z.number().int().min(1).max(102_400).nullable().optional(),
  /** `voice.tts.providers.*` — the named TTS roster. Present = REPLACE the whole
   *  roster (every `voice.tts.providers.` key — and every legacy
   *  `voice.providers.` key — is dropped, then these are written), so an omitted
   *  entry is a deletion. Absent leaves the roster untouched. */
  voiceTtsProviders: z
    .record(z.string().regex(VoiceProviderNameRegex), VoiceProviderEntryUpdateSchema)
    .optional(),
  /** `voice.stt.providers.*` — the named STT roster. Same full-replacement rule. */
  voiceSttProviders: z
    .record(z.string().regex(VoiceProviderNameRegex), VoiceSttProviderEntryUpdateSchema)
    .optional(),
  /** `voice.realtime.providers.*` — the named realtime roster. Same
   *  full-replacement rule: an omitted entry is a deletion. */
  voiceRealtimeProviders: z
    .record(z.string().regex(VoiceProviderNameRegex), VoiceRealtimeProviderEntryUpdateSchema)
    .optional(),
  /** `voice.realtime.default`; null clears the key. */
  voiceRealtimeDefault: z.string().nullable().optional(),
  /** `voice.tier`; null clears the key. */
  voiceTier: z.enum(['pipeline', 'realtime']).nullable().optional(),
  /** `voice.realtime.sessionBudgetUsd`; null clears the cap. */
  voiceRealtimeSessionBudgetUsd: z.number().positive().max(10_000).nullable().optional(),
  // -- Telephony write side --------------------------------------------------
  // Scalars follow the null-clears rule above. The two exceptions worth reading
  // before wiring a form:
  //
  //   1. Secrets (`voiceTrunkPassword`, `voiceTrunkWebhookSecret`,
  //      `voiceLivekitApiKey`, `voiceLivekitApiSecret`) are WRITE-ONLY and never
  //      echoed back. A blank or omitted value KEEPS the stored secret — the
  //      browser only ever saw a preview, so treating blank as "erase" would
  //      delete a credential every time someone saved an unrelated field. Send
  //      null to actually clear one.
  //   2. `voiceTrunkProvider: null` drops the WHOLE `voice.trunk.*` block, and
  //      `voiceLivekitUrl: null` the whole `voice.livekit.*` block, secrets
  //      included. The CLI parser requires provider+trunkId (and url+apiKey+
  //      apiSecret) together, so a block cannot lose its anchor and stay
  //      loadable — "clear the trunk" has to mean the block, not one key.
  /** `voice.trunk.provider`; null clears the whole `voice.trunk.*` block. */
  voiceTrunkProvider: VoiceTrunkProviderSchema.nullable().optional(),
  /** `voice.trunk.trunkId`; required whenever the block exists. */
  voiceTrunkId: z.string().nullable().optional(),
  /** `voice.trunk.fromNumber`; null clears the key. */
  voiceTrunkFromNumber: z.string().nullable().optional(),
  /** `voice.trunk.username`; null clears the key. */
  voiceTrunkUsername: z.string().nullable().optional(),
  /** `voice.trunk.password`. Write-only; blank keeps the stored secret, null
   *  clears it. */
  voiceTrunkPassword: z.string().nullable().optional(),
  /** `voice.trunk.webhookSecret`. Write-only; blank keeps, null clears. */
  voiceTrunkWebhookSecret: z.string().nullable().optional(),
  /** `voice.trunk.webhookPath`; must start with `/`. Null clears the key. */
  voiceTrunkWebhookPath: z.string().regex(/^\//, 'must start with /').nullable().optional(),
  /** `voice.trunk.codec`; null clears the key. */
  voiceTrunkCodec: VoiceTrunkCodecSchema.nullable().optional(),
  /** `voice.livekit.url`; null clears the whole `voice.livekit.*` block. */
  voiceLivekitUrl: z.string().nullable().optional(),
  /** `voice.livekit.apiKey`. Write-only; blank keeps, null clears. */
  voiceLivekitApiKey: z.string().nullable().optional(),
  /** `voice.livekit.apiSecret`. Write-only; blank keeps, null clears. */
  voiceLivekitApiSecret: z.string().nullable().optional(),
  /** `voice.inbound.allowlist`; null (or an empty list) clears the key, which
   *  means "screen everyone through the receptionist". */
  voiceInboundAllowlist: z.array(z.string()).nullable().optional(),
  /** `voice.inbound.receptionist`; null clears the key. */
  voiceInboundReceptionist: z.string().nullable().optional(),
  /** `voice.inbound.concurrencyCap`, a positive integer; null clears the key. */
  voiceInboundConcurrencyCap: z.number().int().min(1).max(1000).nullable().optional(),
  /** `voice.inbound.perCallerPerHour`, a positive integer; null clears. */
  voiceInboundPerCallerPerHour: z.number().int().min(1).max(1000).nullable().optional(),
  /** `voice.inbound.dailyBudgetUsd`, a positive number; null clears the cap. */
  voiceInboundDailyBudgetUsd: z.number().positive().max(100_000).nullable().optional(),
  /** `voice.inbound.prewarm`; null clears the key. */
  voiceInboundPrewarm: VoiceInboundPrewarmSchema.nullable().optional(),
  /** `voice.inbound.owner.platform`; null clears the whole
   *  `voice.inbound.owner.*` block (platform and chatId are required together,
   *  so half a destination is a parse error rather than a route). */
  voiceInboundOwnerPlatform: z.string().nullable().optional(),
  /** `voice.inbound.owner.chatId`; required whenever the owner block exists. */
  voiceInboundOwnerChatId: z.string().nullable().optional(),
  /** `voice.inbound.owner.botKey`; null clears the key. */
  voiceInboundOwnerBotKey: z.string().nullable().optional(),
  /** `voice.bargeIn.<surface>.*`. Present = REPLACE the whole block (every
   *  `voice.bargeIn.` key is dropped, then these are written), so an omitted
   *  surface loses its tuning. Keys must be `call`, `satellite`, or `browser`;
   *  an unknown surface is REFUSED here rather than dropped, because at an RPC
   *  boundary there is a caller to tell. */
  voiceBargeIn: z.record(z.string(), VoiceBargeInTuningUpdateSchema).optional(),
  /** `voice.filler.*`. Per-field merge; null clears one key back to its
   *  built-in default. `afterMs`/`tickIntervalMs` are bounded the same as the
   *  `VoiceSession` debounce/interval they configure. */
  voiceFiller: z
    .object({
      enabled: z.boolean().nullable().optional(),
      afterMs: z.number().int().min(0).max(60_000).nullable().optional(),
      text: z.string().min(1).max(200).nullable().optional(),
      tickIntervalMs: z.number().int().min(0).max(60_000).nullable().optional(),
    })
    .optional(),
  /** `voice.bots[]` — the number → bot → personality table. Present = REPLACE
   *  the whole list (every `voice.bots.` key is dropped, then these are
   *  written, renumbered from 0), so a removed row is a deletion. Absent leaves
   *  the table untouched. */
  voiceBots: z.array(VoiceBotUpdateSchema).optional(),
  // -- Settings-page additions (see the null-clears note above) --------------
  /** Azure-only REST API version (`apiVersion`). */
  apiVersion: z.string().nullable().optional(),
  /** Per-turn timing summary (`verbose`). */
  verbose: z.boolean().nullable().optional(),
  /** `display.verbosity` */
  displayVerbosity: z.enum(['quiet', 'default', 'verbose', 'debug']).nullable().optional(),
  /** `display.busy_input_mode` */
  displayBusyInputMode: z.enum(['interrupt', 'queue', 'steer']).nullable().optional(),
  /** `display.tool_preview_length` — integer >= 0 (0 = no truncation). */
  displayToolPreviewLength: z.number().int().min(0).nullable().optional(),
  /** `display.resume_hint` */
  displayResumeHint: z.boolean().nullable().optional(),
  /** `display.resume_recap_turns` — integer 0-10. */
  displayResumeRecapTurns: z.number().int().min(0).max(10).nullable().optional(),
  /** `display.bell_on_complete` */
  displayBellOnComplete: z.boolean().nullable().optional(),
  /** `compaction.*` thresholds. Per-field merge; null clears one key. */
  compaction: z
    .object({
      /** `compaction.pressure` — fraction in (0,1]. */
      pressure: z.number().gt(0).max(1).nullable().optional(),
      /** `compaction.target` — fraction in (0,1]. */
      target: z.number().gt(0).max(1).nullable().optional(),
      /** `compaction.gateDelta` — integer >= 0. */
      gateDelta: z.number().int().min(0).nullable().optional(),
      /** `compaction.retryOnOverflow` */
      retryOnOverflow: z.boolean().nullable().optional(),
      /** `compaction.abortOnSummaryFailure` */
      abortOnSummaryFailure: z.boolean().nullable().optional(),
      /** `compaction.smallWindow` */
      smallWindow: z.enum(['auto', 'on', 'off']).nullable().optional(),
    })
    .optional(),
  /** `memoryVault.*`. Per-field merge; null / empty array clears one key. */
  memoryVault: z
    .object({
      path: z.string().nullable().optional(),
      agentDir: z.string().nullable().optional(),
      prefetch: z.array(z.string()).nullable().optional(),
      exclude: z.array(z.string()).nullable().optional(),
    })
    .optional(),
  /** `memoryApproval.*`. Per-field merge; null clears one key. */
  memoryApproval: z
    .object({
      mode: z.enum(['off', 'automated', 'all']).nullable().optional(),
      /** Positive integer. */
      cap: z.number().int().min(1).nullable().optional(),
      /** Positive integer. */
      ttlDays: z.number().int().min(1).nullable().optional(),
    })
    .optional(),
  /** `memoryConsolidation.*` decay + flush tunables. Per-field merge. */
  memoryConsolidation: z
    .object({
      halfLifeDays: z.number().gt(0).nullable().optional(),
      threshold: z.number().min(0).max(1).nullable().optional(),
      exemptUser: z.boolean().nullable().optional(),
      /** Fraction in (0,1]. */
      flushThreshold: z.number().gt(0).max(1).nullable().optional(),
      timeboxMs: z.number().int().min(0).nullable().optional(),
      maxTokens: z.number().int().min(0).nullable().optional(),
      maxDeltaChars: z.number().int().min(0).nullable().optional(),
      minMessagesSinceFlush: z.number().int().min(0).nullable().optional(),
    })
    .optional(),
  /** `memoryCapture.*` aux wiring + rate caps. `apiKey` is write-only. */
  memoryCapture: z
    .object({
      provider: z.string().nullable().optional(),
      /** Write-only; never echoed back. Null deletes the stored key. */
      apiKey: z.string().nullable().optional(),
      baseUrl: z.string().nullable().optional(),
      maxPerHour: z.number().int().min(1).nullable().optional(),
      maxPerDay: z.number().int().min(1).nullable().optional(),
    })
    .optional(),
  /** `background.<snake_case>` job-pool caps. Per-field merge. */
  background: z
    .object({
      enabled: z.boolean().nullable().optional(),
      maxConcurrentJobs: z.number().int().min(1).nullable().optional(),
      maxJobsPerRoot: z.number().int().min(1).nullable().optional(),
      maxJobsPerPersonality: z.number().int().min(1).nullable().optional(),
      defaultMaxCostUsd: z.number().min(0).nullable().optional(),
      maxRootBackgroundUsd: z.number().min(0).nullable().optional(),
      queuedTtlMs: z.number().int().min(0).nullable().optional(),
      staleMs: z.number().int().min(0).nullable().optional(),
      heartbeatMs: z.number().int().min(0).nullable().optional(),
      retentionDays: z.number().int().min(1).nullable().optional(),
    })
    .optional(),
  /** Global retention TTLs — full replacement of all `retention.<subkey>` keys. */
  retention: z.partialRecord(RetentionSubkeySchema, RetentionDurationSchema).optional(),
  /** Per-personality retention — full replacement of `personalities.<id>.retention.*`. */
  personalityRetention: z
    .record(ConfigRecordKeySchema, z.partialRecord(RetentionSubkeySchema, RetentionDurationSchema))
    .optional(),
  /** Inbound webhooks — full replacement of `webhooks.*` (secrets preserved per hook). */
  webhooks: z.record(ConfigRecordKeySchema, WebhookUpdateSchema).optional(),
  /** Quick commands — full replacement of `quick_commands.*`. */
  quickCommands: z.record(ConfigRecordKeySchema, QuickCommandUpdateSchema).optional(),
  /** Channel toolsets — full replacement of `channel_toolsets.*`. */
  channelToolsets: z.record(ConfigRecordKeySchema, z.array(z.string())).optional(),
  /**
   * `backup.*`. Per-field merge; null / empty array clears one key.
   *
   * `keep` carries NO bound here and `scope` carries no roster, deliberately:
   * `packages/config` already rejects a non-positive-integer `backup.keep`
   * (`buildBackupConfig`) and `@ethosagent/wiring`'s `parseScopes` already
   * rejects an unknown scope at run time. A second copy of either rule in
   * this layer is the drift those single sources exist to prevent, so the
   * existing error is surfaced rather than re-minted.
   */
  backup: z
    .object({
      enabled: z.boolean().nullable().optional(),
      cron: z.string().min(1).nullable().optional(),
      scope: z.array(z.string()).nullable().optional(),
      keep: z.number().nullable().optional(),
      dir: z.string().nullable().optional(),
    })
    .optional(),
  /** `nightlyPass.*`. Per-field merge; null clears one key. */
  nightlyPass: z
    .object({
      enabled: z.boolean().nullable().optional(),
      cron: z.string().min(1).nullable().optional(),
    })
    .optional(),
  /** `weeklyDigest.*`. Per-field merge; null / empty array clears one key. */
  weeklyDigest: z
    .object({
      enabled: z.boolean().nullable().optional(),
      cron: z.string().min(1).nullable().optional(),
      recipients: z.array(z.string()).nullable().optional(),
    })
    .optional(),
  /** `modelCatalog.*` scalars. Per-field merge; null clears one key. */
  modelCatalog: z
    .object({
      enabled: z.boolean().nullable().optional(),
      url: z.string().nullable().optional(),
      ttlHours: z.number().gt(0).nullable().optional(),
    })
    .optional(),
  /** `logs.rotation.*`. Per-field merge; null clears one key. */
  logsRotation: z
    .object({
      enabled: z.boolean().nullable().optional(),
      maxBytes: z.number().int().min(1).nullable().optional(),
      maxFiles: z.number().int().min(1).nullable().optional(),
    })
    .optional(),
  /** `web.search_backend` */
  webSearchBackend: z.enum(['exa', 'tavily', 'brave']).nullable().optional(),
  /** `web.extract_backend` */
  webExtractBackend: z.enum(['htmltext']).nullable().optional(),
  /** `web.searxng.url` */
  webSearxngUrl: z.string().nullable().optional(),
  /** `auxiliary.compression.*` */
  auxCompression: AuxModelUpdateSchema.optional(),
  /** `auxiliary.vision.*` */
  auxVision: AuxModelUpdateSchema.optional(),
  /** `auxiliary.web.*` */
  auxWeb: AuxModelUpdateSchema.optional(),
  /** `a2a.enabled` */
  a2aEnabled: z.boolean().nullable().optional(),
  /** `plugins.auto_install` */
  pluginsAutoInstall: z.boolean().nullable().optional(),
  /** `webBaseUrl` */
  webBaseUrl: z.string().nullable().optional(),
  /** `retention.vacuumAfterPrune` */
  retentionVacuumAfterPrune: z.boolean().nullable().optional(),
  /** `retention.minVacuumIntervalDays` — integer >= 0. */
  retentionMinVacuumIntervalDays: z.number().int().min(0).nullable().optional(),
  /** `logs.level` */
  logsLevel: z.enum(['debug', 'info', 'warn', 'error']).nullable().optional(),
  /** `memory.charLimits.*`. Per-field merge; null clears one key. */
  memoryCharLimits: z
    .object({
      /** Positive integer. */
      memory: z.number().int().min(1).nullable().optional(),
      /** Positive integer. */
      user: z.number().int().min(1).nullable().optional(),
    })
    .optional(),
  /** `execution.docker.*`. Per-field merge; null clears one key. */
  executionDocker: z
    .object({
      /** Positive core count; fractional is allowed (`--cpus 1.5`). */
      cpu: z.number().positive().nullable().optional(),
      /** Positive integer megabytes. */
      diskMb: z.number().int().min(1).nullable().optional(),
    })
    .optional(),
  /** `execution.ssh.*`. Per-field merge; null clears one key. Clearing `host`
   *  turns the remote target off — the backend refuses without it. */
  executionSsh: z
    .object({
      host: z.string().nullable().optional(),
      user: z.string().nullable().optional(),
      /** TCP port, 1–65535. */
      port: z.number().int().min(1).max(65535).nullable().optional(),
      identityFile: z.string().nullable().optional(),
      knownHostsFile: z.string().nullable().optional(),
      strictHostKeys: z.enum(['accept-new', 'yes']).nullable().optional(),
      remoteWorkdir: z.string().nullable().optional(),
    })
    .optional(),
  /** `kanban.*` WIP caps. Per-field merge; null clears one key (uncapped). */
  kanban: z
    .object({
      maxInProgress: z.number().int().min(1).nullable().optional(),
      maxInProgressPerProfile: z.number().int().min(1).nullable().optional(),
    })
    .optional(),
  /** `cron.maxParallelJobs`; null clears the cap. */
  cronMaxParallelJobs: z.number().int().min(1).nullable().optional(),
  /** `toolLoop.*` soft-warn tiers. Per-field merge; null clears one tier. */
  toolLoop: z
    .object({
      maxToolCallsWarnAt: z.number().int().min(1).nullable().optional(),
      maxIdenticalToolCallsWarnAt: z.number().int().min(1).nullable().optional(),
    })
    .optional(),
  /** `browser.*`. Per-field merge; null clears one key — except `proxyServer`,
   *  whose null clears the whole `browser.proxy.*` block (credentials
   *  included), since credentials with no server refuse boot. */
  browser: z
    .object({
      navigationTimeoutMs: z.number().int().min(1_000).max(600_000).nullable().optional(),
      commandTimeoutMs: z.number().int().min(1_000).max(600_000).nullable().optional(),
      /** Three-state. Bounds and shape mirror `buildBrowser`. */
      headed: z
        .union([z.boolean(), z.literal('auto')])
        .nullable()
        .optional(),
      /** 60000–86400000 ms — must match `buildBrowser`'s bounds. */
      idleTimeoutMs: z.number().int().min(60_000).max(86_400_000).nullable().optional(),
      stealthEnabled: z.boolean().nullable().optional(),
      profilesEnabled: z.boolean().nullable().optional(),
      /** Requires an explicit http/https/socks4/socks5 scheme. */
      proxyServer: z.string().nullable().optional(),
      proxyUsername: z.string().nullable().optional(),
      /** Write-only; blank keeps the stored secret, null clears the block. */
      proxyPassword: z.string().nullable().optional(),
    })
    .optional(),
  /** `gateway.maxInboundMediaBytes`, 1 KiB–128 MiB; null clears the override. */
  gatewayMaxInboundMediaBytes: z.number().int().min(1024).max(134_217_728).nullable().optional(),
  /** `teamSupervisor.restartLoopGuard.*`. Per-field merge; null clears one key. */
  teamSupervisorRestartLoopGuard: z
    .object({
      maxRestarts: z.number().int().min(1).max(1000).nullable().optional(),
      windowSeconds: z.number().int().min(1).max(86_400).nullable().optional(),
    })
    .optional(),
  /** `discord.missedMessageBackfill.*`. Per-field merge; null clears one key. */
  discordMissedMessageBackfill: z
    .object({
      enabled: z.boolean().nullable().optional(),
      windowSeconds: z.number().int().min(1).max(604_800).nullable().optional(),
      /** 1–100 — 100 is Discord's own `messages.fetch` ceiling. */
      limit: z.number().int().min(1).max(100).nullable().optional(),
    })
    .optional(),
});
/**
 * One model adopted into `modelRegistry.*` from a provider-chain entry that
 * declared it — by `config.update` (adopt on save) or `modelRegistry.importChain`.
 * Both run `planChainModelImport` (`@ethosagent/config`), the one importer.
 */
export const ModelRegistryAdoptedModelSchema = z.object({
  alias: z.string(),
  /** The provider entry id the alias references. */
  providerKey: z.string(),
  modelId: z.string(),
});
export type ModelRegistryAdoptedModel = z.infer<typeof ModelRegistryAdoptedModelSchema>;

const ConfigUpdateOutput = z.object({
  ok: z.literal(true),
  /**
   * Models this save adopted into the registry, in the same config.yaml write:
   * a saved provider row whose `model` had no registry entry for its
   * `(providerKey, modelId)` pair. Absent when nothing was adopted. A row sent
   * with `id: null` / `''` is never adopted (adopting would write its id back).
   */
  adoptedModels: z.array(ModelRegistryAdoptedModelSchema).optional(),
});

/** @experimental */
const config = {
  get: oc.output(ConfigGetOutput),
  update: oc.input(ConfigUpdateInput).output(ConfigUpdateOutput),
};

// ---------------------------------------------------------------------------
// Debug — sidecar assistant that inspects session events, spans, and logs
// ---------------------------------------------------------------------------

const DebugChatInput = z.object({
  mainSessionId: z.string(),
  message: z.string().min(1),
  clientId: z.string().optional(),
});
const DebugChatOutput = z.object({
  sessionId: z.string(),
  turnId: z.string(),
  response: z.string(),
});

const debug = {
  chat: oc.input(DebugChatInput).output(DebugChatOutput),
};

// ---------------------------------------------------------------------------
// Cron (v0.5 — the proactive pillar)
//
// Web tab manages jobs.json on disk and reads run-output files from
// `<dataDir>/cron/output/<jobId>/<timestamp>.md`. The actual ticker
// lives in `serve.ts`.
// ---------------------------------------------------------------------------

const CronListOutput = z.object({ jobs: z.array(CronJobSchema) });

const CronGetInput = z.object({ id: z.string().min(1) });
const CronGetOutput = z.object({ job: CronJobSchema });

const CronCreateInput = z.object({
  name: z.string().min(1),
  schedule: z.string().min(1),
  prompt: z.string().min(1),
  personalityId: z.string().min(1),
  missedRunPolicy: MissedRunPolicySchema.optional(),
  // When true, the job is given a `web` origin so its output delivers into a
  // web chat session and surfaces in the Activity feed (in-app heartbeat).
  //
  // @deprecated Alias for `deliverTo: { kind: 'inApp' }` (true) / `{ kind:
  // 'none' }` (false). Kept on the wire because the Cron page already sends
  // it; breaking it to save a field is not a trade worth making. Sending BOTH
  // this and a `deliverTo` that disagrees is a validation error, never a
  // silent precedence rule.
  notifyInApp: z.boolean().optional(),
  /** Where run output goes. See `CronDeliverToSchema`. */
  deliverTo: CronDeliverToSchema.optional(),
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

const CronUpdateInput = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  schedule: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  personalityId: z.string().min(1).optional(),
});
const CronUpdateOutput = z.object({ job: CronJobSchema });

const CronHistoryInput = z.object({
  id: z.string().min(1),
  /** Page size; max 100 to keep payloads bounded. Default 20. */
  limit: z.number().int().min(1).max(100).optional(),
});
const CronHistoryOutput = z.object({ runs: z.array(CronRunSchema) });

// Read-only. The set of chats this personality's own bots may be pointed at.
// The picker on the Cron page renders exactly this — a `deliverTo` chatId is
// NEVER free text, and the set is recomputed server-side at create time rather
// than trusted from whatever the client previewed.
const CronDeliveryTargetsInput = z.object({ personalityId: z.string().min(1) });
const CronDeliveryTargetsOutput = z.object({
  targets: z.array(CronDeliveryTargetSchema),
});

/** @experimental */
const cron = {
  list: oc.output(CronListOutput),
  get: oc.input(CronGetInput).output(CronGetOutput),
  create: oc.input(CronCreateInput).output(CronCreateOutput),
  update: oc.input(CronUpdateInput).output(CronUpdateOutput),
  delete: oc.input(CronIdOnlyInput).output(CronOkOutput),
  pause: oc.input(CronIdOnlyInput).output(CronOkOutput),
  resume: oc.input(CronIdOnlyInput).output(CronOkOutput),
  runNow: oc.input(CronRunNowInput).output(CronRunNowOutput),
  history: oc.input(CronHistoryInput).output(CronHistoryOutput),
  deliveryTargets: oc.input(CronDeliveryTargetsInput).output(CronDeliveryTargetsOutput),
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
  list: oc.input(z.object({ includeUnavailable: z.boolean().optional() })).output(SkillListOutput),
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

// W2.1 — live token probe. Runs the per-platform validator server-side and
// returns a W1.2 liveness verdict so onboarding can distinguish a rejected
// token (Continue disabled) from an unreachable platform (saved unverified).
const PlatformsValidateInput = z.object({
  id: PlatformIdSchema,
  fields: z.record(z.string(), z.string()),
});
const PlatformsValidateOutput = z.object({
  /** `ok` — token accepted; `rejected` — definitively bad (401/403);
   *  `unreachable` — outage (timeout/DNS/5xx/429); `unsupported` — no probe
   *  exists for this platform (e.g. email). */
  status: z.enum(['ok', 'rejected', 'unreachable', 'unsupported']),
  /** `@botname` / workspace name on success, else null. */
  label: z.string().nullable(),
  error: z.string().nullable(),
});

/** @experimental */
const platforms = {
  list: oc.output(PlatformsListOutput),
  set: oc.input(PlatformsSetInput).output(PlatformsSetOutput),
  clear: oc.input(PlatformsClearInput).output(PlatformsClearOutput),
  validate: oc.input(PlatformsValidateInput).output(PlatformsValidateOutput),
  botsListTelegram: oc.output(z.object({ bots: z.array(TelegramBotEntrySchema) })),
  botsAddTelegram: oc
    .input(
      z.object({
        token: z.string().min(1),
        bind: BotBindingSchema,
        username: z.string().optional(),
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

  // WhatsApp: no tokens/secrets. An entry is routing knobs + a personality/team
  // `bind`; pairing happens out-of-band via QR (the setup-whatsapp SSE flow).
  botsListWhatsApp: oc.output(z.object({ bots: z.array(WhatsAppEntrySchema) })),
  botsAddWhatsApp: oc
    .input(
      z.object({
        id: z.string().optional(),
        defaultMode: WhatsAppChannelModeSchema.optional(),
        allowedNumbers: z.array(z.string()).optional(),
        phoneNumber: z.string().optional(),
        bind: BotBindingSchema,
      }),
    )
    .output(z.object({ bot: WhatsAppEntrySchema })),
  botsRemoveWhatsApp: oc
    .input(z.object({ botKey: z.string() }))
    .output(z.object({ ok: z.literal(true) })),

  getChannelFilter: oc
    .input(z.object({ platform: z.string() }))
    .output(z.object({ filter: ChannelPlatformFilterSchema })),

  setChannelFilter: oc
    .input(z.object({ platform: z.string(), filter: ChannelPlatformFilterSchema }))
    .output(z.object({ filter: ChannelPlatformFilterSchema })),
};

// ---------------------------------------------------------------------------
// Plugins + MCP (v1)
//
// Returns the union of installed plugins (discovered in user / project
// / npm dirs) and configured MCP servers. install/uninstall delegate to
// npm under the hood (same as the CLI's `ethos plugin install / remove`).
// ---------------------------------------------------------------------------

const PluginsListOutput = z.object({
  plugins: z.array(PluginInfoSchema),
  mcpServers: z.array(McpServerInfoSchema),
});

/** Mirrors `isValidPluginId` (`extensions/plugin-loader/src/lockfile.ts`), the rule
 *  `PluginsService.install` applies before running npm — web-contracts cannot import
 *  plugin-loader. `apps/web-api/src/__tests__/routes/plugins-install-rpc.test.ts` pins
 *  the two to the same verdicts. */
const PluginsInstallPersonalityId = z
  .string()
  .max(214)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
/** `personalityId` is `ethos plugin install --personality`: when present the install
 *  also writes that personality's `plugins.lock` entry; when absent it records only
 *  the capability grant. The workspace plugins page (`/p/:personalityId/plugins`)
 *  sends its route's id, so its installs write the pin; the global Library Plugins
 *  page and the create wizard send none and install globally (the wizard because
 *  the personality does not exist until it is submitted). */
const PluginsInstallInput = z.object({
  packageSpec: z.string().min(1),
  personalityId: PluginsInstallPersonalityId.optional(),
});
const PluginsInstallOutput = z.object({ ok: z.literal(true) });
const PluginsUninstallInput = z.object({ pluginId: z.string().min(1) });
const PluginsUninstallOutput = z.object({ ok: z.literal(true) });

const PluginsSetCredentialInput = z.object({
  pluginId: z.string().min(1),
  key: z.string().min(1),
  value: z.string(),
});
const PluginsSetCredentialOutput = z.object({ ok: z.literal(true) });

const PluginsGetCredentialMetaInput = z.object({
  pluginId: z.string().min(1),
  key: z.string().min(1),
});
const PluginsGetCredentialMetaOutput = z.object({
  updatedAt: z.string().nullable(),
});

const PluginsListCredentialKeysInput = z.object({
  pluginId: z.string().min(1),
});
const PluginsListCredentialKeysOutput = z.object({
  keys: z.array(CredentialKeyInfoSchema),
});

const PluginsGetPageSpecInput = z.object({ pluginId: z.string().min(1) });
const PluginsGetPageSpecOutput = z.object({
  spec: z
    .object({
      title: z.string(),
      icon: z.string().optional(),
      sections: z.array(z.record(z.string(), z.unknown())),
      showInSidebar: z.boolean().optional(),
    })
    .nullable(),
});

const PluginsInvokeToolForPageInput = z.object({
  pluginId: z.string().min(1),
  toolName: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
});
const PluginsInvokeToolForPageOutput = z.object({
  ok: z.boolean(),
  value: z.string(),
  structured: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
});

const PluginsGetCredentialInput = z.object({
  pluginId: z.string().min(1),
  ref: z.string().min(1),
});
const PluginsGetCredentialOutput = z.object({
  value: z.string().nullable(),
});

const PluginsCredentialPreviewInput = z.object({
  pluginId: z.string().min(1),
  ref: z.string().min(1),
});
const PluginsCredentialPreviewOutput = z.object({
  preview: z.string().nullable(),
});

const PluginsExecuteToolInput = z.object({
  pluginId: z.string().min(1),
  toolName: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
});
const PluginsExecuteToolOutput = z.object({
  ok: z.boolean(),
  value: z.string().optional(),
  error: z.string().optional(),
  code: z.string().optional(),
});

const PluginsRequestOAuthInput = z.object({
  pluginId: z.string(),
  oauthRef: z.string(),
});
const PluginsRequestOAuthOutput = z.object({
  url: z.string(),
});

const PluginsCompleteOAuthInput = z.object({
  pluginId: z.string(),
  oauthRef: z.string(),
  requestToken: z.string(),
});
const PluginsCompleteOAuthOutput = z.object({
  ok: z.boolean(),
  userId: z.string().optional(),
});

/** @experimental */
const plugins = {
  list: oc.output(PluginsListOutput),
  install: oc.input(PluginsInstallInput).output(PluginsInstallOutput),
  uninstall: oc.input(PluginsUninstallInput).output(PluginsUninstallOutput),
  setCredential: oc.input(PluginsSetCredentialInput).output(PluginsSetCredentialOutput),
  getCredentialMeta: oc.input(PluginsGetCredentialMetaInput).output(PluginsGetCredentialMetaOutput),
  listCredentialKeys: oc
    .input(PluginsListCredentialKeysInput)
    .output(PluginsListCredentialKeysOutput),
  getPageSpec: oc.input(PluginsGetPageSpecInput).output(PluginsGetPageSpecOutput),
  invokeToolForPage: oc.input(PluginsInvokeToolForPageInput).output(PluginsInvokeToolForPageOutput),
  getCredential: oc.input(PluginsGetCredentialInput).output(PluginsGetCredentialOutput),
  credentialPreview: oc.input(PluginsCredentialPreviewInput).output(PluginsCredentialPreviewOutput),
  executeTool: oc.input(PluginsExecuteToolInput).output(PluginsExecuteToolOutput),
  requestOAuth: oc.input(PluginsRequestOAuthInput).output(PluginsRequestOAuthOutput),
  completeOAuth: oc.input(PluginsCompleteOAuthInput).output(PluginsCompleteOAuthOutput),
};

// ---------------------------------------------------------------------------
// MCP install flow (v1 — OAuth UI)
//
// Server-side orchestration for the MCP OAuth dance: discover, register
// a dynamic client, redirect the user to the upstream authorization
// endpoint, then exchange the code for tokens and persist the server.
// ---------------------------------------------------------------------------

/** @experimental */
const mcp = {
  start: oc.input(McpStartInputSchema).output(McpStartOutputSchema),
  complete: oc.input(McpCompleteInputSchema).output(McpCompleteOutputSchema),
  status: oc.output(McpStatusOutputSchema),
  cancel: oc.input(McpCancelInputSchema).output(z.object({ ok: z.literal(true) })),
  attachPersonalities: oc.input(McpAttachInputSchema).output(McpAttachOutputSchema),
  list: oc.output(McpListOutputSchema),
  delete: oc.input(McpDeleteInputSchema).output(z.object({ ok: z.literal(true) })),
  reconnect: oc.input(McpReconnectInputSchema).output(McpStartOutputSchema),
  /** List the bare tool names a given MCP server exposes, for the
   *  per-server tool checklist in the personality editor. */
  serverTools: oc.input(McpServerToolsInputSchema).output(McpServerToolsOutputSchema),
  /** List MCP servers attached to a personality with their OAuth auth status. */
  personalityServers: oc
    .input(McpPersonalityServersInputSchema)
    .output(McpPersonalityServersOutputSchema),
  addServer: oc.input(McpAddServerInputSchema).output(McpAddServerOutputSchema),
  refreshToken: oc.input(McpRefreshTokenInputSchema).output(McpRefreshTokenOutputSchema),
  rename: oc.input(McpRenameInputSchema).output(McpRenameOutputSchema),
  updateToken: oc.input(McpUpdateTokenInputSchema).output(McpUpdateTokenOutputSchema),
  scopeStatus: oc.input(McpScopeStatusInputSchema).output(McpScopeStatusOutputSchema),
  validateConfig: oc.input(McpValidateConfigInputSchema).output(McpValidateConfigOutputSchema),
  /** The curated preset catalog, so the browser never imports the Node-only tools-mcp package. */
  catalog: oc.output(McpCatalogOutputSchema),
};

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
const memory = {
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
const kanban = {
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
const teams = {
  list: oc.output(TeamsListOutput),
  get: oc.input(TeamsGetInput).output(TeamDetailSchema),
  ledger: oc.input(TeamsLedgerInput).output(TeamsLedgerOutput),
  memoryList: oc.input(TeamsMemoryListInput).output(TeamsMemoryListOutput),
  memoryRead: oc.input(TeamsMemoryReadInput).output(TeamsMemoryReadOutput),
  memoryWrite: oc.input(TeamsMemoryWriteInput).output(TeamsMemoryWriteOutput),
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

const ApiKeyListInput = z.object({
  /** Page size. */
  limit: z.number().int().positive().optional(),
  /** Opaque cursor from the previous response's `nextCursor`. */
  cursor: z.string().optional(),
});
const ApiKeyListOutput = z.object({
  items: z.array(ApiKeyMetadataSchema),
  nextCursor: z.string().nullable(),
});

const ApiKeyRevokeInput = z.object({ id: z.string() });
const ApiKeyRevokeOutput = z.object({ ok: z.literal(true) });

/** @experimental */
const apiKeys = {
  create: oc.input(ApiKeyCreateInput).output(ApiKeyCreateOutput),
  list: oc.input(ApiKeyListInput).output(ApiKeyListOutput),
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
// Models — curated catalog for the model picker (suggestions only; users may
// type any model id). Sourced from packages/wiring's MODEL_CATALOG, grouped
// by provider id so the web UI can suggest per-selected-provider.
// ---------------------------------------------------------------------------

export const ModelCatalogOutput = z.object({
  version: z.number().int().nonnegative(),
  updatedAt: z.string().datetime({ offset: true }),
  providers: z.record(
    z.string(),
    z.object({
      models: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          contextWindow: z.number().int().positive(),
          default: z.boolean().optional(),
        }),
      ),
    }),
  ),
});

/** @experimental */
const models = {
  catalog: oc.output(ModelCatalogOutput),
};

// ---------------------------------------------------------------------------
// Model registry — the operator's model roster (plan/phases/model-registry.md).
//
// Handlers: apps/web-api `rpc/model-registry.ts` → `ModelRegistryService`.
// `list` reads; `upsert` / `setDefault` / `setRole` / `setRouting` / `remove`
// each save immediately as ONE config.yaml write; `test` / `testAll` probe.
//
// Refusals are DATA, not thrown ORPCErrors — the same choice `test` makes for
// `rate_limited`: every write answers `{ ok: true, … } | ModelRegistryRefusal`,
// because the pane renders a refusal (a referenced alias is a dialog with
// "Repoint them to…", not an error toast). Transport failures still throw.
// ---------------------------------------------------------------------------

const ModelRegistryAliasInput = z.string().min(1).max(200);

/** The three role bindings `setRole` writes. `default` is not one of them: the
 *  roster default is `setDefault` (`modelRegistry.default`). */
export const ModelRegistryBindableRoleSchema = z.enum(['trivial', 'deep', 'dreaming']);

/** One `validateModelRegistry` problem (`@ethosagent/config`). */
export const ModelRegistryProblemSchema = z.object({
  code: z.enum([
    'invalid_alias',
    'reserved_alias',
    'missing_provider',
    'missing_model_id',
    'unknown_provider_key',
    'derived_provider_key',
    'unknown_default',
    'unknown_role_binding',
    'unknown_fallback',
    'cross_provider_fallback',
    'alias_cycle',
  ]),
  /** The alias the problem is about (for `default`/roles: the alias they NAME). */
  alias: z.string(),
  /** The config key, e.g. `modelRegistry.roles.deep`. */
  key: z.string(),
  /** One sentence naming the offender and the configured set. */
  message: z.string(),
  /** The exact line to add or change, where there is one. */
  fix: z.string().optional(),
});
export type ModelRegistryProblemView = z.infer<typeof ModelRegistryProblemSchema>;

/** One place that names an alias — "used by", and what `remove` refuses on. */
export const ModelReferentSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('personality'),
    personalityId: z.string(),
    /** The personality's own slot: `model`, one tier-map leaf, or `voice.model`. */
    field: z.enum([
      'model',
      'model.trivial',
      'model.default',
      'model.deep',
      'model.dreaming',
      'voice.model',
    ]),
    /** A built-in personality — read-only, so a repoint cannot rewrite it. */
    readOnly: z.boolean(),
  }),
  z.object({ kind: z.literal('role'), role: z.enum(['trivial', 'default', 'deep', 'dreaming']) }),
  z.object({ kind: z.literal('default') }),
  /** `modelRouting.<personalityId>`. */
  z.object({ kind: z.literal('routing'), personalityId: z.string() }),
  /** Another registry entry's `fallbacks` list. */
  z.object({ kind: z.literal('fallback'), alias: z.string() }),
]);
export type ModelReferent = z.infer<typeof ModelReferentSchema>;

/** Whether a provider entry has a credential — never the credential itself.
 *  `not_needed`: self-hosted / device-auth / IAM providers, or an uncatalogued
 *  provider with no `apiKey` (`providerCredentialStatus`, @ethosagent/wiring). */
export const ModelCredentialStatusSchema = z.enum(['set', 'missing', 'not_needed']);
export type ModelCredentialStatus = z.infer<typeof ModelCredentialStatusSchema>;

export const ModelRegistryRefusalSchema = z.object({
  ok: z.literal(false),
  code: z.enum([
    'config_missing',
    'unknown_alias',
    'duplicate_alias',
    'invalid_entry',
    'referenced',
    'invalid_repoint',
    'unknown_personality',
    'invalid_declaration',
  ]),
  /** Names the offender and the configured set; render verbatim. */
  message: z.string(),
  /** The `validateModelRegistry` problems behind `invalid_entry` / `invalid_repoint`. */
  problems: z.array(ModelRegistryProblemSchema),
  /** Who names the alias — populated for `referenced` (and `invalid_repoint`). */
  referents: z.array(ModelReferentSchema),
});
export type ModelRegistryRefusal = z.infer<typeof ModelRegistryRefusalSchema>;

export const ModelRegistryEntryViewSchema = z.object({
  alias: z.string(),
  /** `modelRegistry.<alias>.provider` — a provider ENTRY id. */
  providerKey: z.string(),
  modelId: z.string(),
  label: z.string().nullable(),
  contextWindow: z.number().nullable(),
  costPer1kInput: z.number().nullable(),
  costPer1kOutput: z.number().nullable(),
  fallbacks: z.array(z.string()),
  /** The provider entry's credential status; `missing` when no entry has that key. */
  credential: ModelCredentialStatusSchema,
  referents: z.array(ModelReferentSchema),
});
export type ModelRegistryEntryView = z.infer<typeof ModelRegistryEntryViewSchema>;

export const ModelProviderEntryViewSchema = z.object({
  /** The explicit id, else the positional display name (`deriveProviderKey`). */
  key: z.string(),
  /** Chain position (`providers.<index>`); 0 for a top-level-only config. */
  index: z.number().int().nonnegative(),
  /** Provider TYPE, e.g. `anthropic`. */
  provider: z.string(),
  id: z.string().nullable(),
  explicitId: z.boolean(),
  /** The entry's own `model`, if any. */
  model: z.string().nullable(),
  failover: z.boolean(),
  /** The entry's `apiVersion` line (azure reads it); null when absent. Not a secret. */
  apiVersion: z.string().nullable(),
  /** The entry's `region` line (bedrock reads it); null when absent. Not a secret. */
  region: z.string().nullable(),
  /** The entry's `awsProfile` line (bedrock reads it) — a profile NAME, never a
   *  credential; null when absent. */
  awsProfile: z.string().nullable(),
  credential: ModelCredentialStatusSchema,
  /** Whether a registry entry may name it — only with an explicit id (D24). */
  referenceable: z.boolean(),
  /** Why not, when `referenceable` is false. */
  reason: z.string().nullable(),
});
export type ModelProviderEntryView = z.infer<typeof ModelProviderEntryViewSchema>;

/** A model a provider-chain entry declares that the registry does not have yet
 *  (`planChainModelImport` candidates). A configured model is never hidden:
 *  `importChain` adopts it. */
export const ModelRegistryChainModelSchema = z.object({
  /** The entry's explicit id, or the id adopting it would write (D24). */
  providerKey: z.string(),
  /** Chain position (`providers.<index>`); 0 for a top-level-only config. */
  index: z.number().int().nonnegative(),
  /** Provider TYPE, e.g. `codex`. */
  provider: z.string(),
  modelId: z.string(),
  /** The alias `importChain` writes for it. */
  suggestedAlias: z.string(),
  /** False when adopting it also writes `providers.<index>.id`. */
  idIsExplicit: z.boolean(),
});
export type ModelRegistryChainModel = z.infer<typeof ModelRegistryChainModelSchema>;

export const ModelRegistryListOutput = z.object({
  /** Chain models not yet in the registry, in chain order. */
  chainModels: z.array(ModelRegistryChainModelSchema),
  /** In config-file order. */
  entries: z.array(ModelRegistryEntryViewSchema),
  /** `modelRegistry.default`. */
  default: z.string().nullable(),
  /** `modelRegistry.roles.<role>`; null = unbound (falls through to `default`). */
  roles: z.object({
    trivial: z.string().nullable(),
    default: z.string().nullable(),
    deep: z.string().nullable(),
    dreaming: z.string().nullable(),
  }),
  /** Every provider entry, in chain order — what the Add/Edit drawer lists. */
  providerEntries: z.array(ModelProviderEntryViewSchema),
  /** `modelRouting.<personalityId>` → role or alias. */
  routing: z.record(z.string(), z.string()),
  /** Every current `validateModelRegistry` problem. */
  problems: z.array(ModelRegistryProblemSchema),
});
export type ModelRegistryListResult = z.infer<typeof ModelRegistryListOutput>;

export const ModelRegistryUpsertInput = z.object({
  /** `create` refuses an existing alias; `update` refuses a missing one (no rename). */
  mode: z.enum(['create', 'update']),
  alias: ModelRegistryAliasInput,
  /** A provider entry with an explicit id. Emptiness and unknown/derived keys
   *  are refused by `validateModelRegistry`, naming the configured set. */
  provider: z.string().max(200),
  /** The vendor id. An empty one is refused by `validateModelRegistry`. */
  modelId: z.string().max(500),
  /** Optional display fields. On `update` they are REPLACED: omitted clears. */
  label: z.string().max(200).optional(),
  contextWindow: z.number().int().positive().optional(),
  costPer1kInput: z.number().nonnegative().optional(),
  costPer1kOutput: z.number().nonnegative().optional(),
});
export type ModelRegistryUpsertRequest = z.infer<typeof ModelRegistryUpsertInput>;

const ModelRegistryOk = z.object({ ok: z.literal(true) });

/** Output of `upsert` / `setDefault` / `setRole` / `setRouting`. */
export const ModelRegistryWriteOutput = z.union([ModelRegistryOk, ModelRegistryRefusalSchema]);
export type ModelRegistryWriteResult = z.infer<typeof ModelRegistryWriteOutput>;

export const ModelRegistryRemoveInput = z.object({
  alias: ModelRegistryAliasInput,
  /** "Repoint them to…": rewrite every writable referent to this alias, then remove. */
  repointTo: ModelRegistryAliasInput.optional(),
  /** "Remove anyway": remove and leave every referent to refuse at turn time. */
  force: z.boolean().optional(),
});

export const ModelRegistryRemoveOutput = z.union([
  z.object({
    ok: z.literal(true),
    alias: z.string(),
    repointedTo: z.string().nullable(),
    /** Referents now naming `repointedTo`. */
    rewritten: z.array(ModelReferentSchema),
    /** Referents still naming the removed alias (built-ins on repoint; all on force). */
    needsAttention: z.array(ModelReferentSchema),
  }),
  ModelRegistryRefusalSchema,
]);
export type ModelRegistryRemoveResult = z.infer<typeof ModelRegistryRemoveOutput>;

/** A saved alias, or an unsaved `(providerKey, modelId)` — the Add/Edit form's
 *  "Test before saving" (D19.1). Same probe, same 10s limit, keyed on the alias
 *  or on `providerKey/modelId`. */
export const ModelRegistryTestInput = z.union([
  z.object({ alias: ModelRegistryAliasInput }),
  z.object({ providerKey: z.string().min(1).max(200), modelId: z.string().min(1).max(500) }),
]);

/**
 * What one test learned — the SAME value `ethos models test` prints, produced
 * by the same `testModel` in `@ethosagent/wiring`. `alias` is present exactly
 * when the test named an alias; an unsaved test is identified by
 * `providerKey` / `modelId`.
 *
 * `rate_limited` is a state, not a thrown error: the 10s per-subject-per-caller
 * limit is enforced in the HANDLER (D19), because a test is a real billable
 * completion reachable by anything that can call this RPC, and a limit that
 * lives only in the button is a hint the button happens to respect. The
 * client-side disable (T2.8) sits on top so the ordinary path never sees this.
 */
export const ModelRegistryTestOutput = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('ok'),
    alias: z.string().optional(),
    providerKey: z.string(),
    provider: z.string(),
    modelId: z.string(),
    latencyMs: z.number().int().nonnegative(),
    /** The model the provider said it served. Absent when it named none, and
     *  rendered ONLY when it differs from `modelId` (D19). */
    echoedModel: z.string().optional(),
  }),
  z.object({
    state: z.literal('rejected'),
    alias: z.string().optional(),
    providerKey: z.string(),
    provider: z.string(),
    modelId: z.string(),
    /** The vendor's own body, verbatim and untruncated. Never paraphrased. */
    error: z.string(),
    fix: z.string(),
  }),
  z.object({
    /** The probe never got an answer. NOT a verdict on the credential. */
    state: z.literal('unreachable'),
    alias: z.string().optional(),
    providerKey: z.string(),
    provider: z.string(),
    modelId: z.string(),
    error: z.string(),
  }),
  z.object({
    /** Nothing was probed — the alias, its provider entry or its credential is missing. */
    state: z.literal('unconfigured'),
    alias: z.string().optional(),
    providerKey: z.string().optional(),
    modelId: z.string().optional(),
    reason: z.string(),
    fix: z.string().optional(),
  }),
  z.object({
    state: z.literal('rate_limited'),
    alias: z.string().optional(),
    providerKey: z.string().optional(),
    modelId: z.string().optional(),
    /** Named so the refusal can say how long to wait, rather than just "no". */
    retryAfterSeconds: z.number().int().nonnegative(),
  }),
]);

export type ModelRegistryTestResult = z.infer<typeof ModelRegistryTestOutput>;

/** One outcome per provider ENTRY the registry references (`providerEntryProbes`,
 *  the grouping `ethos models test --all` uses). */
export const ModelRegistryTestAllOutput = z.object({
  results: z.array(
    z.object({
      providerKey: z.string(),
      /** Every alias on that entry; the first (alphabetically) was probed. */
      aliases: z.array(z.string()),
      outcome: ModelRegistryTestOutput,
    }),
  ),
});
export type ModelRegistryTestAllResult = z.infer<typeof ModelRegistryTestAllOutput>;

/** `importChain` — adopt chain models; `providerKeys` absent = every candidate. */
export const ModelRegistryImportChainInput = z.object({
  providerKeys: z.array(z.string().min(1).max(200)).max(100).optional(),
});

export const ModelRegistryImportChainOutput = z.union([
  z.object({
    ok: z.literal(true),
    adopted: z.array(ModelRegistryAdoptedModelSchema),
    /** The alias written to `modelRegistry.default`; null when none was written. */
    defaultSet: z.string().nullable(),
    /** Provider ids made explicit (`providers.<n>.id`) by this import. */
    idsWritten: z.array(z.string()),
  }),
  ModelRegistryRefusalSchema,
]);
export type ModelRegistryImportChainResult = z.infer<typeof ModelRegistryImportChainOutput>;

/** A refused provider write. Data, not a thrown error — the drawer renders it. */
export const ModelRegistryProviderRefusalSchema = z.object({
  ok: z.literal(false),
  code: z.enum([
    'config_missing',
    /** `key` names no provider entry. */
    'unknown_provider',
    /** Empty provider type. */
    'invalid_provider',
    /** Id outside `[A-Za-z0-9_-]+` (or empty). */
    'invalid_id',
    /** Id already names another provider entry. */
    'duplicate_id',
    /** Empty or repeated modelId, a `validateModelRegistry` problem, or clearing
     *  the primary provider's own model. */
    'invalid_model',
    /** A requested alias already exists. */
    'duplicate_alias',
    /** `removeProvider` while registry models reference the entry (`aliases`). */
    'referenced',
    /** `removeProvider` of the deployment's only provider. */
    'last_provider',
    /** `moveProvider` past either end, or with no chain. */
    'cannot_move',
    /** `setProviderFailover(false)` on a top-level-only config. */
    'not_in_chain',
    /** `setFallbackModel` names no configured model. */
    'unknown_alias',
    /** `setFallbackModel` names a model on another provider entry (`aliases` =
     *  the models this entry does have). */
    'cross_provider_alias',
  ]),
  /** Names the offender and what would have worked; render verbatim. */
  message: z.string(),
  /** `validateModelRegistry` problems behind an `invalid_model`. */
  problems: z.array(ModelRegistryProblemSchema),
  /** The aliases the refusal is about (`referenced`, `cross_provider_alias`). */
  aliases: z.array(z.string()),
});
export type ModelRegistryProviderRefusal = z.infer<typeof ModelRegistryProviderRefusalSchema>;

const ModelRegistryProviderKeyInput = z.string().min(1).max(200);

export const ModelRegistryAddProviderInput = z.object({
  /** Provider TYPE, e.g. `anthropic`. Empty is refused as `invalid_provider`. */
  provider: z.string().max(100),
  /** `providers.<n>.id` — required and immutable afterwards (D24). */
  id: z.string().max(200),
  /** Plaintext; stored in the vault, the file gets a `${secrets:…}` ref. */
  apiKey: z.string().max(4096).optional(),
  baseUrl: z.string().max(2000).optional(),
  apiVersion: z.string().max(100).optional(),
  region: z.string().max(100).optional(),
  awsProfile: z.string().max(200).optional(),
  /** `false` = a credential that is not a failover hop (D23b). */
  failover: z.boolean().optional(),
  /** Upserted into the registry in the same write. The first model's id
   *  becomes `providers.<n>.model`. */
  models: z
    .array(
      z.object({
        modelId: z.string().max(500),
        /** Absent = the importer's slug rule, `-<id>` suffixed on collision. */
        alias: z.string().max(200).optional(),
        label: z.string().max(200).optional(),
        contextWindow: z.number().int().positive().optional(),
        costPer1kInput: z.number().nonnegative().optional(),
        costPer1kOutput: z.number().nonnegative().optional(),
      }),
    )
    .max(50),
});
export type ModelRegistryAddProviderRequest = z.infer<typeof ModelRegistryAddProviderInput>;

export const ModelRegistryAddProviderOutput = z.union([
  z.object({
    ok: z.literal(true),
    providerKey: z.string(),
    /** Chain position the entry landed at. */
    index: z.number().int().nonnegative(),
    /** Every model written, with its final alias. */
    models: z.array(ModelRegistryAdoptedModelSchema),
  }),
  ModelRegistryProviderRefusalSchema,
]);
export type ModelRegistryAddProviderResult = z.infer<typeof ModelRegistryAddProviderOutput>;

/** Omitted = keep. `apiKey: ''` also keeps (an empty key never erases one);
 *  `''` for the other fields removes the line. The id is immutable. */
export const ModelRegistryUpdateProviderInput = z.object({
  key: ModelRegistryProviderKeyInput,
  apiKey: z.string().max(4096).optional(),
  baseUrl: z.string().max(2000).optional(),
  apiVersion: z.string().max(100).optional(),
  region: z.string().max(100).optional(),
  awsProfile: z.string().max(200).optional(),
});

/** Output of `updateProvider` / `removeProvider` / `moveProvider` /
 *  `setProviderFailover` / `setFallbackModel`. `providerKey` is the entry's key
 *  AFTER the write (an id-less entry's derived key moves with it); `index` is
 *  its position after the write (for `removeProvider`, where it was). */
export const ModelRegistryProviderWriteOutput = z.union([
  z.object({
    ok: z.literal(true),
    providerKey: z.string(),
    index: z.number().int().nonnegative(),
  }),
  ModelRegistryProviderRefusalSchema,
]);
export type ModelRegistryProviderWriteResult = z.infer<typeof ModelRegistryProviderWriteOutput>;

/** @experimental */
const modelRegistry = {
  list: oc.output(ModelRegistryListOutput),
  upsert: oc.input(ModelRegistryUpsertInput).output(ModelRegistryWriteOutput),
  setDefault: oc
    .input(z.object({ alias: ModelRegistryAliasInput }))
    .output(ModelRegistryWriteOutput),
  /** `alias: null` deletes the `modelRegistry.roles.<role>` line. */
  setRole: oc
    .input(
      z.object({
        role: ModelRegistryBindableRoleSchema,
        alias: ModelRegistryAliasInput.nullable(),
      }),
    )
    .output(ModelRegistryWriteOutput),
  /** `modelRouting.<personalityId>`: a role or a configured alias; `null` deletes the line. */
  setRouting: oc
    .input(
      z.object({
        personalityId: z.string().min(1).max(200),
        declaration: z.string().min(1).max(200).nullable(),
      }),
    )
    .output(ModelRegistryWriteOutput),
  remove: oc.input(ModelRegistryRemoveInput).output(ModelRegistryRemoveOutput),
  test: oc.input(ModelRegistryTestInput).output(ModelRegistryTestOutput),
  testAll: oc.output(ModelRegistryTestAllOutput),
  /** Adopt chain models (`list.chainModels`) in ONE config.yaml write. */
  importChain: oc.input(ModelRegistryImportChainInput).output(ModelRegistryImportChainOutput),
  /** Append a provider entry with an explicit id and its models, one write. */
  addProvider: oc.input(ModelRegistryAddProviderInput).output(ModelRegistryAddProviderOutput),
  updateProvider: oc
    .input(ModelRegistryUpdateProviderInput)
    .output(ModelRegistryProviderWriteOutput),
  /** Refused while any registry model references the entry. */
  removeProvider: oc
    .input(z.object({ key: ModelRegistryProviderKeyInput }))
    .output(ModelRegistryProviderWriteOutput),
  moveProvider: oc
    .input(z.object({ key: ModelRegistryProviderKeyInput, direction: z.enum(['up', 'down']) }))
    .output(ModelRegistryProviderWriteOutput),
  setProviderFailover: oc
    .input(z.object({ key: ModelRegistryProviderKeyInput, failover: z.boolean() }))
    .output(ModelRegistryProviderWriteOutput),
  /** `providers.<n>.model` = the alias's modelId; `null` removes the line. The
   *  alias must be one of THIS entry's models. */
  setFallbackModel: oc
    .input(
      z.object({ key: ModelRegistryProviderKeyInput, alias: ModelRegistryAliasInput.nullable() }),
    )
    .output(ModelRegistryProviderWriteOutput),
  /** Test connection for a SAVED provider with its stored credential. Probes
   *  `providers.<n>.model`, else its first registry model; neither →
   *  `unconfigured`. Rate-limited per provider entry (10s). */
  testProvider: oc
    .input(z.object({ providerKey: ModelRegistryProviderKeyInput }))
    .output(ModelRegistryTestOutput),
};

// ---------------------------------------------------------------------------
// Dashboards — widget templates from plugins + dashboard/panel CRUD
// ---------------------------------------------------------------------------

const WidgetTemplateSchema = z.object({
  id: z.string(),
  pluginId: z.string(),
  title: z.string(),
  description: z.string().optional(),
  queryType: z.enum(['sql', 'prompt']),
  dataSource: z.string().optional(),
  sql: z.string().optional(),
  prompt: z.string().optional(),
  outputType: z.enum(['table', 'html', 'image', 'text']).optional(),
  defaultCron: z.string().optional(),
});

const DashboardsListWidgetTemplatesOutput = z.object({
  templates: z.array(WidgetTemplateSchema),
});

const ParamDefSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(['select', 'options', 'date-range']),
  options: z.array(z.string()).optional(),
  default: z.string(),
});

const EmitRuleSchema = z.object({
  on: z.enum(['rowClick']),
  param: z.string(),
  column: z.string(),
  default: z.string(),
});

// Dashboard schemas
const DashboardSchema = z.object({
  id: z.string(),
  userId: z.string(),
  personalityId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  cronSchedule: z.string().nullable(),
  paramsSchema: z.array(ParamDefSchema),
  paramsCurrent: z.record(z.string(), z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const DashboardPanelSchema = z.object({
  id: z.string(),
  dashboardId: z.string(),
  queryType: z.enum(['static', 'prompt', 'sql', 'header']),
  blockType: z.enum(['html', 'image', 'pdf', 'text', 'table']),
  content: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  title: z.string().nullable(),
  prompt: z.string().nullable(),
  sqlQuery: z.string().nullable(),
  pluginId: z.string().nullable(),
  dataSourceId: z.string().nullable(),
  renderHint: z.string().nullable(),
  cronSchedule: z.string().nullable(),
  htmlTemplate: z.string().nullable(),
  emitConfig: z.array(EmitRuleSchema).nullable(),
  dependsOn: z.array(z.string()).nullable(),
  paramDefaults: z.record(z.string(), z.string()),
  lastRunAt: z.number().nullable(),
  lastError: z.string().nullable(),
  sourceConversationId: z.string().nullable(),
  sourceMessageSeq: z.number().nullable(),
  col: z.number(),
  row: z.number(),
  w: z.number(),
  h: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

// Input schemas
const DashboardsCreateInput = z.object({
  title: z.string().min(1),
  personalityId: z.string().min(1),
  description: z.string().optional(),
});

const DashboardsGetInput = z.object({ id: z.string().min(1) });
const DashboardsUpdateInput = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  cronSchedule: z.string().nullable().optional(),
  paramsSchema: z.array(ParamDefSchema).optional(),
});
const DashboardsDeleteInput = z.object({ id: z.string().min(1) });

const DashboardsAddPanelInput = z.object({
  dashboardId: z.string().nullable(),
  newDashboardTitle: z.string().optional(),
  personalityId: z.string().optional(),
  paramsSchema: z.array(ParamDefSchema).optional(),
  panel: z.object({
    queryType: z.enum(['static', 'prompt', 'sql', 'header']),
    blockType: z.enum(['html', 'image', 'pdf', 'text', 'table']),
    content: z.string(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    title: z.string().optional(),
    prompt: z.string().optional(),
    sqlQuery: z.string().optional(),
    pluginId: z.string().optional(),
    dataSourceId: z.string().optional(),
    htmlTemplate: z.string().optional(),
    renderHint: z.string().optional(),
    cronSchedule: z.string().optional(),
    sourceConversationId: z.string().optional(),
    sourceMessageSeq: z.number().optional(),
  }),
});

const DashboardsUpdatePanelInput = z.object({
  panelId: z.string().min(1),
  title: z.string().optional(),
  cronSchedule: z.string().nullable().optional(),
  queryType: z.enum(['static', 'prompt', 'sql', 'header']).optional(),
  prompt: z.string().nullable().optional(),
  sqlQuery: z.string().nullable().optional(),
  pluginId: z.string().nullable().optional(),
  dataSourceId: z.string().nullable().optional(),
  htmlTemplate: z.string().nullable().optional(),
  emitConfig: z.array(EmitRuleSchema).nullable().optional(),
  dependsOn: z.array(z.string()).nullable().optional(),
  paramDefaults: z.record(z.string(), z.string()).optional(),
});

const DashboardsUpdatePanelLayoutInput = z.object({
  panelId: z.string().min(1),
  col: z.number(),
  row: z.number(),
  w: z.number(),
  h: z.number(),
});

const DashboardsDeletePanelInput = z.object({ panelId: z.string().min(1) });

const DashboardsRefreshPanelInput = z.object({ panelId: z.string().min(1) });
const DashboardsRefreshAllInput = z.object({ dashboardId: z.string().min(1) });

const DashboardsUpdateParamsInput = z.object({
  id: z.string().min(1),
  paramsCurrent: z.record(z.string(), z.string()),
});

const DashboardsExportInput = z.object({
  id: z.string().min(1),
});

const DashboardsImportInput = z.object({
  exportJson: z.string(),
  titleOverride: z.string().optional(),
});

/** @experimental */
const dashboards = {
  create: oc.input(DashboardsCreateInput).output(z.object({ dashboard: DashboardSchema })),
  list: oc.output(z.object({ dashboards: z.array(DashboardSchema) })),
  get: oc.input(DashboardsGetInput).output(
    z.object({
      dashboard: DashboardSchema,
      panels: z.array(DashboardPanelSchema),
    }),
  ),
  update: oc.input(DashboardsUpdateInput).output(z.object({ ok: z.literal(true) })),
  delete: oc.input(DashboardsDeleteInput).output(z.object({ ok: z.literal(true) })),
  addPanel: oc.input(DashboardsAddPanelInput).output(z.object({ panel: DashboardPanelSchema })),
  updatePanel: oc.input(DashboardsUpdatePanelInput).output(z.object({ ok: z.literal(true) })),
  updatePanelLayout: oc
    .input(DashboardsUpdatePanelLayoutInput)
    .output(z.object({ ok: z.literal(true) })),
  deletePanel: oc.input(DashboardsDeletePanelInput).output(z.object({ ok: z.literal(true) })),
  refreshPanel: oc.input(DashboardsRefreshPanelInput).output(z.object({ ok: z.literal(true) })),
  refreshAll: oc.input(DashboardsRefreshAllInput).output(z.object({ ok: z.literal(true) })),
  summarizePrompt: oc
    .input(z.object({ sessionId: z.string().min(1) }))
    .output(z.object({ summary: z.string() })),
  listWidgetTemplates: oc.output(DashboardsListWidgetTemplatesOutput),
  runQuery: oc
    .input(
      z.object({
        pluginId: z.string().min(1),
        sourceId: z.string().min(1),
        sql: z.string().min(1),
      }),
    )
    .output(
      z.object({
        columns: z.array(z.string()),
        rows: z.array(z.record(z.string(), z.unknown())),
      }),
    ),
  updateParams: oc.input(DashboardsUpdateParamsInput).output(z.object({ ok: z.literal(true) })),
  exportDashboard: oc
    .input(DashboardsExportInput)
    .output(z.object({ json: z.string(), panelCount: z.number(), title: z.string() })),
  importDashboard: oc.input(DashboardsImportInput).output(
    z.object({
      dashboardId: z.string(),
      title: z.string(),
      warnings: z.array(z.string()),
    }),
  ),
};

// ---------------------------------------------------------------------------
// Admin — unified status view for channels, providers, and MCP servers
// ---------------------------------------------------------------------------

const admin = {
  getStatus: oc.output(
    z.object({
      channels: z.array(
        z.object({
          id: z.string(),
          platform: z.string(),
          status: z.enum(['connected', 'disconnected', 'error']),
          webhookUrl: z.string().optional(),
        }),
      ),
      providers: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          hasKey: z.boolean(),
          healthy: z.boolean().optional(),
          latencyMs: z.number().optional(),
        }),
      ),
      mcpServers: z.array(
        z.object({
          name: z.string(),
          status: z.enum(['connected', 'disconnected', 'error']),
          toolCount: z.number().optional(),
        }),
      ),
      /**
       * The remote execution backend, when this deployment declares one
       * (`execution.ssh.host`). Null when it does not — a fresh install has no
       * remote target and must not be told anything is wrong with it.
       *
       * `resolved: false` is the boot-failure state
       * (plan/phases/remote-execution-routing.md §6): the backend the posture
       * NAMES could not be constructed in this process, so nothing routed to it
       * will run. It is deliberately NOT a reachability answer — resolving a
       * backend opens no connection, and this panel must not spend an ssh
       * round trip on every status poll. Reachability is `execution.probeSsh`.
       */
      executionBackend: z
        .object({
          name: z.literal('ssh'),
          resolved: z.boolean(),
          /** Why resolution failed, verbatim. Null when it did not. */
          error: z.string().nullable(),
        })
        .nullable(),
    }),
  ),
  rotateKey: oc
    .input(
      z.object({
        provider: z.string(),
        key: z.string(),
      }),
    )
    .output(z.object({ ok: z.literal(true) })),
  checkProvider: oc
    .input(
      z.object({
        provider: z.string(),
      }),
    )
    .output(z.object({ ok: z.boolean(), latencyMs: z.number() })),
  testSend: oc
    .input(
      z.object({
        channel: z.string(),
      }),
    )
    .output(z.object({ ok: z.boolean(), error: z.string().optional() })),
  addMcpServer: oc
    .input(
      z.object({
        name: z.string(),
        url: z.string(),
        authType: z.enum(['none', 'bearer', 'oauth']),
      }),
    )
    .output(z.object({ ok: z.literal(true) })),
  removeMcpServer: oc
    .input(
      z.object({
        name: z.string(),
      }),
    )
    .output(z.object({ ok: z.literal(true) })),
};

// ---------------------------------------------------------------------------
// Context — resolve @file / @url inline references (Gap 4)
// ---------------------------------------------------------------------------

const context = {
  resolve: oc.input(z.object({ refs: z.array(z.string()) })).output(
    z.object({
      resolved: z.array(
        z.object({
          ref: z.string(),
          content: z.string(),
          lang: z.string(),
        }),
      ),
    }),
  ),
};

// ---------------------------------------------------------------------------
// Files — list workspace files for @-mention autocomplete (Gap 4)
// ---------------------------------------------------------------------------

const files = {
  list: oc.input(z.object({ prefix: z.string().optional() })).output(
    z.object({
      paths: z.array(z.string()),
    }),
  ),
};

// ---------------------------------------------------------------------------
// Slash commands (v3 — plugin-registered dynamic commands)
// ---------------------------------------------------------------------------

const SlashCommandSchema = z.object({
  name: z.string(),
  description: z.string(),
  usage: z.string(),
  pluginId: z.string().optional(),
});

const slashCommands = {
  list: oc.output(z.object({ commands: z.array(SlashCommandSchema) })),
};

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

const GoalGetInput = z.object({ id: z.string().min(1) });
const GoalGetOutput = z.object({
  goal: GoalSchema,
  events: z.array(GoalEventSchema),
  attempts: z.array(GoalAttemptSchema),
});

const GoalListInput = z.object({
  status: GoalStatusSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
const GoalListOutput = z.object({ goals: z.array(GoalSchema) });

const GoalSteerInput = z.object({ id: z.string().min(1), message: z.string().min(1) });
const GoalSteerOutput = z.object({ ok: z.boolean() });

const GoalCancelInput = z.object({ id: z.string().min(1) });
const GoalCancelOutput = z.object({ ok: z.boolean() });

const GoalResumeInput = z.object({ id: z.string().min(1) });
const GoalResumeOutput = z.object({ ok: z.boolean() });

const GoalCreateInput = z.object({
  personalityId: z.string().min(1),
  goalText: z.string().min(1),
  title: z.string().optional(),
  acceptanceCriteria: z
    .object({
      checks: z.array(z.object({ description: z.string() })).optional(),
      rubric: z.array(z.object({ description: z.string(), weight: z.number() })).optional(),
      threshold: z.number().optional(),
    })
    .optional(),
  maxAttempts: z.number().int().min(1).optional(),
  maxCostUsd: z.number().optional(),
  maxToolCallsPerTurn: z.number().int().min(1).optional(),
  maxIdenticalToolCalls: z.number().int().min(1).optional(),
  allowDangerousToolCalls: z.boolean().optional(),
  maxRecoveryAttempts: z.number().int().min(0).optional(),
  deadline: z.string().optional(),
});
const GoalCreateOutput = z.object({ goal: GoalSchema });

const GoalToolResultInput = z.object({
  goalId: z.string().min(1),
  toolCallId: z.string().min(1),
});
const GoalToolResultOutput = z.object({
  found: z.boolean(),
  toolName: z.string().optional(),
  input: z.string().optional(),
  output: z.string().optional(),
});

/** @experimental */
const goals = {
  get: oc.input(GoalGetInput).output(GoalGetOutput),
  list: oc.input(GoalListInput).output(GoalListOutput),
  steer: oc.input(GoalSteerInput).output(GoalSteerOutput),
  cancel: oc.input(GoalCancelInput).output(GoalCancelOutput),
  resume: oc.input(GoalResumeInput).output(GoalResumeOutput),
  create: oc.input(GoalCreateInput).output(GoalCreateOutput),
  toolResult: oc.input(GoalToolResultInput).output(GoalToolResultOutput),
};

// ---------------------------------------------------------------------------
// Tasks — background-job (detached spawn-and-continue) surface
//
// Read-only plus one cancel: `list` enumerates jobs (optionally scoped to a
// root session), `get` reads one job with its ordered event trail (null when
// absent), `cancel` requests cancellation. The JobStore is the source of
// truth; the server maps rows to the wire schemas in `schemas.ts`.
// ---------------------------------------------------------------------------

const TasksListInput = z.object({ rootSessionKey: z.string().optional() });
const TasksListOutput = z.array(BackgroundJobSummarySchema);

const TasksGetInput = z.object({ id: z.string().min(1) });
const TasksGetOutput = BackgroundJobDetailSchema.nullable();

const TasksCancelInput = z.object({ id: z.string().min(1) });
const TasksCancelOutput = z.object({ ok: z.boolean() });

/** @experimental */
const tasks = {
  list: oc.input(TasksListInput).output(TasksListOutput),
  get: oc.input(TasksGetInput).output(TasksGetOutput),
  cancel: oc.input(TasksCancelInput).output(TasksCancelOutput),
};

// ---------------------------------------------------------------------------
// Digest — read-only view of the most recent weekly governed-learning digest
//
// The weekly digest writes Markdown to `~/.ethos/digests/<ISO-week>.md`.
// `digest.latest` returns the newest file (or null when none exist).
// `digest.generate` builds + writes the current ISO week's digest on demand
// (the same generator the weekly cron / `ethos digest run` drives), returning
// it — or null when there are no user personalities to report on.
// ---------------------------------------------------------------------------

/** @experimental */
const digest = {
  latest: oc.output(DigestLatestSchema.nullable()),
  generate: oc.output(DigestLatestSchema.nullable()),
};

// ---------------------------------------------------------------------------
// Voice — server-side STT transcription for the web/desktop chat
// ---------------------------------------------------------------------------

const VoiceTranscribeInput = z.object({
  audio: z.string().min(1),
  mimeType: z.string().min(1),
  /** Personality listening. Without it the server cannot honour a personality's
   *  declared `voice.stt_provider` and uses the default `auxiliary.asr` entry —
   *  the mirror of `personalityId` on `voice.synthesize`. */
  personalityId: z.string().optional(),
  /** BCP-47 tag handed to the provider, when the client knows it. */
  language: z.string().optional(),
});
const VoiceTranscribeOutput = z.object({
  transcript: z.string(),
});
const VoiceSynthesizeInput = z.object({
  text: z.string().min(1),
  /** Global default voice the client read from config. The LOWEST precedence
   *  rung — the active personality's `voice.tts_voice` beats it, and a
   *  language-specific entry beats that (`resolveVoicePreferences`). */
  voice: z.string().optional(),
  /** Personality speaking this reply. Without it the server cannot honour a
   *  personality's declared voice and falls back to the global default. */
  personalityId: z.string().optional(),
  /** BCP-47 tag of the reply, selecting from the personality's language map. */
  language: z.string().optional(),
  /**
   * Audition an unsaved selection: `provider` names a
   * `voice.tts.providers.<name>` roster entry and `voice` the voice id, and
   * both BEAT the personality's own `voice` block and the global default. The
   * personality editor's Preview button uses it, since the selection it is
   * previewing is not on disk yet.
   *
   * `provider` is a roster LABEL, never a provider id or a credential — an
   * unknown label falls back to the default entry exactly as a personality's
   * would, and the egress gate still keys on the resolved provider.
   */
  override: z.object({ provider: z.string().optional(), voice: z.string().optional() }).optional(),
});
const VoiceSynthesizeOutput = z.object({
  audio: z.string(),
  format: z.enum(['opus', 'mp3', 'wav', 'pcm']),
  mimeType: z.string(),
  /** Provider id that ACTUALLY synthesized this audio. Optional so an older
   *  client that never asked for it keeps validating. */
  provider: z.string().optional(),
});

/**
 * The batch-RPC fallback tier's turn driver — for a browser that cannot
 * stream (`talk-mode-client.ts`'s `forceBatch`/no-`WebSocket` path). Drives
 * one agent turn against the SAME browser voice lane
 * (`voice:<botKey>:browser:<sessionId>`) a streaming connection for this
 * `sessionId` would use — never the typed chat session (Conflict 1,
 * plan/phases/voice-live-personality.md §7). `sessionId` here is the CHAT
 * session id this call belongs to, the same field/meaning as the streaming
 * lane's `hello.sessionId` — telemetry and lane-key derivation only, never
 * what actually persists the turn.
 */
const VoiceRunTurnInput = z.object({
  text: z.string().min(1),
  sessionId: z.string().optional(),
  personalityId: z.string().optional(),
});
const VoiceRunTurnOutput = z.object({ reply: z.string() });

/**
 * What one selectable TTS entry can do. `providerId` is the registered provider
 * the entry names (null = nothing configured). `voices` is the provider's
 * advertised `caps.voices`: a list means the voice id must come FROM it, `null`
 * means the provider takes open-ended ids (Kokoro, a `command-tts` recipe) and
 * the surface should offer free text rather than guess a list.
 */
const VoiceTtsEntrySchema = z.object({
  providerId: z.string().nullable(),
  voices: z.array(z.string()).nullable(),
});
const VoiceTtsEntriesOutput = z.object({
  /** The `auxiliary.tts` default entry — what a personality that names nothing gets. */
  default: VoiceTtsEntrySchema,
  /** `voice.tts.providers.*`, keyed by the operator's label. */
  roster: z.record(z.string(), VoiceTtsEntrySchema),
});

/**
 * One selectable STT entry. `providerId` only: an ear advertises no voice ids,
 * so there is nothing to construct a provider to read, and this procedure makes
 * no provider at all.
 */
const VoiceSttEntrySchema = z.object({ providerId: z.string().nullable() });
const VoiceSttEntriesOutput = z.object({
  /** The `auxiliary.asr` default entry — what a personality that names nothing gets. */
  default: VoiceSttEntrySchema,
  /** `voice.stt.providers.*`, keyed by the operator's label. */
  roster: z.record(z.string(), VoiceSttEntrySchema),
});

/**
 * One selectable REALTIME entry — `providerId` only, for the same reason the
 * STT one is: this procedure constructs no provider, so it can report what an
 * entry NAMES but not what it advertises.
 */
const VoiceRealtimeEntrySchema = z.object({ providerId: z.string().nullable() });
/**
 * The roster a personality's `voice.realtime_provider` picks from.
 *
 * There is no `auxiliary.*` entry under this tier the way there is under TTS
 * and STT, so instead of a synthetic "default entry" this carries the roster
 * label `voice.realtime.default` NAMES. A deployment with an empty roster has
 * no realtime tier rather than an implicit one, and the editor says so instead
 * of offering a Default that resolves to nothing.
 */
const VoiceRealtimeEntriesOutput = z.object({
  roster: z.record(z.string(), VoiceRealtimeEntrySchema),
  /** The label `voice.realtime.default` names, or null when the key is unset. */
  defaultEntryName: z.string().nullable(),
});

const VoiceRealtimeTokenInput = z.object({
  /** Personality about to talk. Its `voice.realtime_provider` picks the roster
   *  entry and its `voice.tier` decides whether the realtime tier runs at all. */
  personalityId: z.string().optional(),
});

/**
 * Why the browser is NOT getting a realtime session. Each reason renders as
 * different copy, which is the whole point of typing them: "this deployment has
 * no realtime provider" and "your local-only gate refused the one it has" are
 * the same non-event to the user unless the surface can tell them apart.
 *
 * `pipeline_preferred` is not a failure — it is the configured answer, so the
 * surface renders no notice and simply starts the pipeline call.
 */
const VoiceRealtimeRefusalReason = z.enum([
  /** `voice.tier` (personality first, then deployment) asked for the pipeline. */
  'pipeline_preferred',
  /** No realtime roster entry is configured, or none is named as the default. */
  'not_configured',
  /** The personality (or `voice.realtime.default`) names an entry this deployment lacks. */
  'unknown_entry',
  /** `voice.trustedPlugins` refuses the resolved provider — the local-only egress gate. */
  'untrusted_provider',
  /** The provider is server-relayed (`caps.ephemeralToken !== true`) — Gemini Live. */
  'no_browser_token',
  /** The provider would not construct, or the mint itself failed. */
  'provider_unavailable',
]);

/**
 * A minted browser-direct session, or a typed refusal.
 *
 * The success arm carries BOTH sample rates because the two are not necessarily
 * equal (`RealtimeVoiceCapabilities` in `@ethosagent/types`): the browser
 * captures at `inputSampleRate` and plays out at `outputSampleRate`.
 *
 * `token` is a short-lived provider credential minted for this session. The
 * operator's long-lived API key never appears here, and no part of it appears
 * in a refusal message either.
 */
const VoiceRealtimeTokenOutput = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    /** The REGISTERED provider id that minted it (`openai-realtime`), never the roster label. */
    providerId: z.string(),
    /** Model the token was minted against; null when the provider pins none. */
    model: z.string().nullable(),
    token: z.string(),
    /** Absolute expiry, epoch milliseconds. Not a TTL — no clock arithmetic at the edge. */
    expiresAt: z.number(),
    /** Endpoint the browser connects to with `token`. */
    url: z.string(),
    inputSampleRate: z.number(),
    outputSampleRate: z.number(),
  }),
  z.object({
    ok: z.literal(false),
    reason: VoiceRealtimeRefusalReason,
    /** Renderable sentence. Never carries credentials. */
    message: z.string(),
    /** The provider that was actually about to run, when one was resolved. */
    providerId: z.string().nullable(),
  }),
]);

/**
 * Per-conversation voice mode for the browser chat header.
 *
 * The mode is durable (`LaneVoiceModeStore`) and SHARED with the gateway's
 * channel lanes, so a mode set here is the same fact the gateway reads. The
 * `default` on the read is the deployment's `voice.defaultMode`: a lane with no
 * override is INHERITING, and the header says so rather than pretending the
 * inherited value was chosen.
 */
const VoiceLaneModeGetInput = z.object({ sessionId: z.string().min(1) });
const VoiceLaneModeGetOutput = z.object({
  /** The lane's effective mode — its override, or `default` when it has none. */
  mode: z.enum(VOICE_MODES),
  /** `voice.defaultMode` — what an unset lane inherits. */
  default: z.enum(VOICE_MODES),
});
const VoiceLaneModeSetInput = z.object({
  sessionId: z.string().min(1),
  mode: z.enum(VOICE_MODES),
});
const VoiceLaneModeSetOutput = z.object({ mode: z.enum(VOICE_MODES) });

// --- Wake satellites (voice V3) ---------------------------------------------

/**
 * One connected wake satellite, as Settings → Voice renders it.
 *
 * Everything here is what the NODE reported, not what the server inferred. A
 * microphone in a room that misreports whether it is listening is a privacy
 * defect, so `state` comes from the only component that can see the capture
 * loop, `probes` carries `ethos listen doctor`'s findings so the row can name
 * the failing dependency inline, and `lastWake` is the receipt that a phrase
 * actually reached a personality.
 */
const SatelliteNodeSchema = z.object({
  nodeId: z.string(),
  laneId: z.string(),
  displayName: z.string().nullable(),
  capabilities: z.object({
    edgeStt: z.boolean(),
    playback: z.boolean(),
    captureSampleRate: z.number(),
    /** False → the SERVER matches wake phrases for this node, from the transcript. */
    phraseMatch: z.boolean(),
  }),
  state: z.enum(['listening', 'muted', 'wake_off', 'speaking', 'degraded']),
  /** Which probe failed, which device disappeared. Renders inline on the row. */
  stateDetail: z.string().nullable(),
  wakeEnabled: z.boolean(),
  probes: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string().nullable() })),
  lastWake: z.object({ phrase: z.string(), personalityId: z.string(), at: z.number() }).nullable(),
  /**
   * The open addressing window: who a follow-up with no wake phrase reaches,
   * and until when. Null means the next utterance has to name somebody.
   */
  conversation: z.object({ personalityId: z.string(), until: z.number() }).nullable(),
  connectedAt: z.number(),
});

const SatellitesListOutput = z.object({ nodes: z.array(SatelliteNodeSchema) });

const SatelliteSetWakeEnabledInput = z.object({
  nodeId: z.string().min(1),
  enabled: z.boolean(),
});
/** `false` = no such node is connected. The row says "not reachable" rather
 *  than reporting a mute that never left the process. */
const SatelliteSetWakeEnabledOutput = z.object({ ok: z.boolean() });

/** One editable wake route. `id` is the yaml key, so it carries the same
 *  charset the config parser will match on the way back in. */
const WakeRouteSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/),
  phrase: z.string().min(1),
  personalityId: z.string().min(1),
  /** Route-level opt-in for a privileged personality (eng-review D13). */
  privileged: z.boolean(),
  enabled: z.boolean(),
});

/**
 * One route as READ — the effective table, which is wider than the file.
 *
 * Every unprivileged personality answers to `hey <name>` without any config, so
 * the read carries those synthesized routes alongside the configured ones and
 * `implicit` is how the editor tells them apart: configured rows are editable,
 * implicit rows are shown and not saved back. The id is only `min(1)` here
 * because a synthesized id is `auto:<personalityId>`, deliberately outside the
 * charset a config key may use — which is also why the WRITE schema above stays
 * strict and carries no `implicit` field. An implicit route is not something the
 * editor can send back.
 */
const WakeRouteViewSchema = z.object({
  id: z.string().min(1),
  phrase: z.string().min(1),
  personalityId: z.string().min(1),
  privileged: z.boolean(),
  enabled: z.boolean(),
  /** True for a `hey <name>` default; false for a `voice.wake.routes` entry. */
  implicit: z.boolean(),
});

/**
 * Deployment-wide satellite knobs, defaults already applied.
 *
 * Read-only through this namespace: the routing TABLE is what the wake-route
 * manager edits, and these scalars are a separate Settings surface. Returned on
 * the read so the manager can show what the routes will run under.
 */
const WakeSettingsSchema = z.object({
  engine: z.enum(['fallback', 'sherpa', 'openwakeword']),
  sensitivity: z.number(),
  confirmationFrames: z.number(),
  edgeStt: z.boolean(),
  idleTimeoutMs: z.number(),
  wakeEnabled: z.boolean(),
});

const WakeRoutesGetOutput = z.object({
  routes: z.array(WakeRouteViewSchema),
  settings: WakeSettingsSchema,
});

/**
 * Replace the whole route table.
 *
 * Wholesale, not a merge: a route the operator deleted has to actually stop
 * answering the door. The write round-trips through `config.yaml` and then
 * pushes to every connected satellite, so a save takes effect without a
 * restart (eng-review D5).
 */
const WakeRoutesSetInput = z.object({ routes: z.array(WakeRouteSchema) });

// ---------------------------------------------------------------------------
// Calls — read-only view of the durable telephony call log
//
// The gateway opens a row when a number rings and closes it on hang-up. This is
// the operator's window onto that: what rang, who was refused and why, what it
// cost, and whether a call is up right now.
//
// Read-only by construction: there is no RPC that starts, patches, hangs up or
// prunes a call. Dialling out and ending a live call are the agent's and the
// gateway's decisions, made against their own botKeys; a settings page must not
// be able to place a call or cut one off.
// ---------------------------------------------------------------------------

export const CallDirectionSchema = z.enum(['inbound', 'outbound']);

/** `screened` / `refused` are decisions Ethos made (not allowlisted, budget
 *  spent); `failed` is the network or the provider letting us down. An operator
 *  reading the list needs to tell "we said no" from "it broke". */
export const CallStatusSchema = z.enum([
  'ringing',
  'live',
  'completed',
  'screened',
  'refused',
  'failed',
]);

export const CallTierSchema = z.enum(['pipeline', 'realtime']);

/**
 * One row of the call list.
 *
 * Deliberately NOT the whole record: a call carries its full transcript, and a
 * 200-row list dragging 200 transcripts through the wire is the wrong shape —
 * it is slow, it is a lot of conversation sitting in a browser network log, and
 * the list renders none of it. `summaryPreview` is the post-call summary
 * truncated to 200 characters; `hasTranscript` says whether opening the row
 * will show anything. `voice.calls.get` returns the full text.
 */
export const CallSummarySchema = z.object({
  /** The provider's call id — stable for the life of the call. */
  id: z.string(),
  botKey: z.string(),
  /** `voice:<botKey>:sip:<callerId>` — the lane the turns ran in. */
  laneKey: z.string(),
  direction: CallDirectionSchema,
  fromNumber: z.string(),
  toNumber: z.string(),
  personalityId: z.string().nullable(),
  tier: CallTierSchema.nullable(),
  status: CallStatusSchema,
  /** Epoch milliseconds. */
  startedAt: z.number(),
  /** Epoch milliseconds; null while the call is still up. */
  endedAt: z.number().nullable(),
  /** Why a screened/refused call was turned away (`not_allowlisted`,
   *  `over_budget`, … or free text). Free-form on purpose — a refusal reason is
   *  shown to a human and a closed set would force a schema change per guard. */
  reason: z.string().nullable(),
  /** Post-call summary, truncated to 200 characters. Null when there is none. */
  summaryPreview: z.string().nullable(),
  /** Whether a transcript exists for this call — `get` returns it. */
  hasTranscript: z.boolean(),
  costUsd: z.number().nullable(),
});

/** One call with the text the list withholds. */
export const CallDetailSchema = CallSummarySchema.extend({
  /** The full post-call summary; null when there is none. */
  summary: z.string().nullable(),
  /** The full transcript; null when there is none. */
  transcript: z.string().nullable(),
});

export type CallDirection = z.infer<typeof CallDirectionSchema>;
export type CallStatus = z.infer<typeof CallStatusSchema>;
export type CallSummary = z.infer<typeof CallSummarySchema>;
export type CallDetail = z.infer<typeof CallDetailSchema>;

const CallsListInput = z.object({
  /** Rows to return, newest first. Clamped to 1–200 by the call log. */
  limit: z.number().int().min(1).max(200).optional(),
  /** Keep only inbound / outbound calls. Absent = both. */
  direction: CallDirectionSchema.optional(),
  /** Keep only calls in this state. Absent = every state. */
  status: CallStatusSchema.optional(),
});

const CallsListOutput = z.object({ calls: z.array(CallSummarySchema) });

/** Live calls are `ringing` or `live`, OLDEST first — the order a "calls in
 *  progress" indicator wants (the call that has been waiting longest is the one
 *  worth looking at). */
const CallsActiveOutput = z.object({ calls: z.array(CallSummarySchema) });

const CallsGetInput = z.object({ id: z.string().min(1) });

/** `call` is null for an unknown id — a pruned or mistyped call is an empty
 *  detail pane, not an error to throw at the UI. */
const CallsGetOutput = z.object({ call: CallDetailSchema.nullable() });

/** @experimental */
const voice = {
  transcribe: oc.input(VoiceTranscribeInput).output(VoiceTranscribeOutput),
  synthesize: oc.input(VoiceSynthesizeInput).output(VoiceSynthesizeOutput),
  /** Batch-RPC fallback tier's turn driver — runs on the browser voice lane,
   *  never the chat session. See `VoiceRunTurnInput`'s doc comment. */
  runTurn: oc.input(VoiceRunTurnInput).output(VoiceRunTurnOutput),
  /** Selectable TTS entries + the voice ids each advertises. Read-only: it
   *  constructs providers to read their caps and synthesizes nothing. */
  ttsEntries: oc.output(VoiceTtsEntriesOutput),
  /** Selectable STT entries. Read-only and construction-free. */
  sttEntries: oc.output(VoiceSttEntriesOutput),
  /** Selectable REALTIME entries. Read-only and construction-free. */
  realtimeEntries: oc.output(VoiceRealtimeEntriesOutput),
  /** Mint a browser-direct realtime credential, or say why not. */
  realtimeToken: oc.input(VoiceRealtimeTokenInput).output(VoiceRealtimeTokenOutput),
  /** Read / write ONE conversation's durable voice mode. */
  laneMode: {
    get: oc.input(VoiceLaneModeGetInput).output(VoiceLaneModeGetOutput),
    set: oc.input(VoiceLaneModeSetInput).output(VoiceLaneModeSetOutput),
  },
  /** Connected wake satellites — the Settings → Voice liveness rows. */
  satellites: {
    list: oc.output(SatellitesListOutput),
    /** Mute / unmute ONE node. The node persists it across restarts. */
    setWakeEnabled: oc.input(SatelliteSetWakeEnabledInput).output(SatelliteSetWakeEnabledOutput),
  },
  /** The wake-phrase → personality table. */
  wakeRoutes: {
    get: oc.output(WakeRoutesGetOutput),
    set: oc.input(WakeRoutesSetInput).output(WakeRoutesGetOutput),
  },
  /** Telephony call history. Read-only — see the block comment above the
   *  schemas. A deployment with no call log reports an empty list rather than
   *  failing, so the Communications tab renders an empty state, not an error. */
  calls: {
    /** Recent calls, newest first — the Communications call list. */
    list: oc.input(CallsListInput).output(CallsListOutput),
    /** In-progress calls — the live-call indicator. */
    active: oc.output(CallsActiveOutput),
    /** One call with its transcript and summary. */
    get: oc.input(CallsGetInput).output(CallsGetOutput),
  },
};

// ---------------------------------------------------------------------------
// Deliveries — read-only view of the durable delivery-obligation ledger
//
// The gateway writes a `pending` obligation before every covered outbound send
// and flips it to `delivered` only on a confirmed platform ack. This namespace
// is the operator's window onto that: how many replies are owed, how many were
// abandoned, and — for a voice deployment — the same counts for voice notes,
// whose payload is an artifact on disk.
//
// The OUTBOUND half is read-only by construction: there is no RPC that
// records, claims, delivers or prunes an obligation. Redelivery is the
// gateway's decision, made against its own botKeys; a settings page must not be
// able to re-send someone's message.
//
// The INBOUND half (plan reach-and-containment §2.6) lists dead-lettered
// inbound messages and offers exactly two operator decisions on one: requeue
// (the running gateway's replay tick runs the turn again) or discard. Neither
// sends anything from here — a requeue hands the message back to the gateway,
// which re-runs its safety filter and its own delivery path.
// ---------------------------------------------------------------------------

const DeliveryStatusCountsSchema = z.object({
  pending: z.number(),
  redelivering: z.number(),
  delivered: z.number(),
  abandoned: z.number(),
});

const DeliveryStatsSchema = DeliveryStatusCountsSchema.extend({
  /** The same counts restricted to `kind = 'voice'`, so a voice deployment can
   *  see whether the loss it is looking at is specific to voice notes. */
  voice: DeliveryStatusCountsSchema,
});

const DeliveryObligationSchema = z.object({
  id: z.string(),
  platform: z.string(),
  chatId: z.string(),
  /** Null for the root chat — a thread is a distinct conversation. */
  threadId: z.string().nullable(),
  status: z.enum(['pending', 'redelivering', 'delivered', 'abandoned']),
  kind: z.enum(['text', 'voice']),
  /**
   * The reply text — for a voice obligation, the SPOKEN text — truncated to 200
   * characters. Nothing here is redacted: the operator owns this text and it is
   * their own agent's outbound reply. It is truncated because a settings page
   * asking "what is still owed" must not become a way to read whole
   * conversations out of the ledger, on screen or in a browser network log.
   */
  content: z.string(),
  /** Container of the stored artifact for a voice obligation; null for text. */
  mediaFormat: z.string().nullable(),
  /** Epoch milliseconds. */
  createdAt: z.number(),
});

const DeliveriesSummaryInput = z.object({
  /** Rows to return, newest first. Clamped to 1–200 by the ledger. */
  limit: z.number().int().min(1).max(200).optional(),
});

const DeliveriesSummaryOutput = z.object({
  stats: DeliveryStatsSchema,
  recent: z.array(DeliveryObligationSchema),
});

const DeadInboundSchema = z.object({
  id: z.string(),
  /** `dead` — given up on. `interrupted` — cut after a tool had started, so
   *  never replayed; the chat was asked to reply `retry`. Replay re-runs it. */
  status: z.enum(['dead', 'interrupted']),
  platform: z.string(),
  chatId: z.string(),
  /** Null for the root chat. */
  threadId: z.string().nullable(),
  attempts: z.number(),
  /** Why it died: the turn's last error, `stale`, or `unreadable payload`;
   *  for an interrupted row, why it was cut. */
  lastError: z.string().nullable(),
  /** The message text, truncated to 200 characters, for the same reason
   *  `DeliveryObligationSchema.content` is. Empty when the payload is gone. */
  text: z.string(),
  /** Epoch milliseconds. */
  receivedAt: z.number(),
  updatedAt: z.number(),
});

const ListDeadInboundInput = z.object({
  limit: z.number().int().min(1).max(500).optional(),
});
const ListDeadInboundOutput = z.object({ rows: z.array(DeadInboundSchema) });
const InboundActionInput = z.object({ id: z.string().min(1) });
/** `false` when the row is no longer dead or interrupted (already requeued,
 *  retried or discarded). */
const InboundActionOutput = z.object({ ok: z.boolean() });

/** @experimental */
const deliveries = {
  summary: oc.input(DeliveriesSummaryInput).output(DeliveriesSummaryOutput),
  listDeadInbound: oc.input(ListDeadInboundInput).output(ListDeadInboundOutput),
  requeueInbound: oc.input(InboundActionInput).output(InboundActionOutput),
  discardInbound: oc.input(InboundActionInput).output(InboundActionOutput),
};

// ---------------------------------------------------------------------------
// Outbox — the personality approval queue (plan `trust-before-reach.md` Part 2)
//
// A personality with `outbound_policy.approve_before_send` does not publish: its
// `send_message` queues an item here and returns "NOT sent". This namespace is
// the WEB approval surface for that queue (O-D5: any authenticated `/rpc`
// session counts as the operator, the same rule `deliveries` rides on).
//
// It writes DECISIONS ONLY. There is no procedure that sends, claims, retries a
// delivery or touches an adapter — web-api holds no adapters at all. The
// gateway dispatcher polls the same SQLite file, claims `approved` rows for its
// own bots and calls `sendTracked`. `outbox.retry` is named for the human
// action it is (re-approve a failed item at the same revision), not for a
// network retry.
//
// The binding is what makes an approval mean something: `approve` carries back
// the `revision` and `contentHash` the human READ, and the store's conditional
// UPDATE refuses it if either has moved. That surfaces as `CONFLICT` —
// "changed since you viewed it" — and the UI re-reads rather than publishing
// text nobody approved.
// ---------------------------------------------------------------------------

/**
 * Filters for one pane. Absent `personalityId` AND `teamId` means every item in
 * the deployment — the count behind a global "needs you" badge.
 *
 * `teamId` expands to that team's member personalities (the manifest's roster),
 * which is what the team pane shows. Given both, the intersection applies: a
 * personality that is not a member of the team matches nothing.
 */
const OutboxListInput = z.object({
  personalityId: z.string().min(1).optional(),
  teamId: z.string().min(1).optional(),
  /** Restrict to these states — the four UI sections. Absent means all. */
  states: z.array(OutboxStateSchema).min(1).optional(),
  /** Items to return, newest first. */
  limit: z.number().int().min(1).max(200).optional(),
});
const OutboxListOutput = z.object({ items: z.array(OutboxItemViewSchema) });

const OutboxGetInput = z.object({ itemId: z.string().min(1) });
/** The item plus its full revision history, oldest first — the card's
 *  "revision 2 · edited by you" line and the timeline are rendered from it. */
const OutboxGetOutput = z.object({
  item: OutboxItemViewSchema,
  revisions: z.array(OutboxRevisionViewSchema),
});

/** Every decision answers with the item as it now stands, so a client never
 *  has to guess the resulting state or issue a second read. */
const OutboxItemOutput = z.object({ item: OutboxItemViewSchema });

/**
 * A BOUND approval. `revision` and `contentHash` are the ones the human read
 * off the card; if the item has been edited, revoked, rejected or expired since
 * it was rendered, nothing is approved and the call fails `CONFLICT`.
 */
const OutboxApproveInput = z.object({
  itemId: z.string().min(1),
  revision: z.number().int().positive(),
  contentHash: z.string().min(1),
  /** Tab identity, recorded as `decidedBy` on the `outbox.approve` audit row.
   *  A LABEL for the trail, never the gate: authentication is the gate. */
  clientId: z.string().min(1),
});

const OutboxRejectInput = z.object({
  itemId: z.string().min(1),
  /** Shown to the agent and kept in the audit trail. */
  reason: z.string().min(1),
  clientId: z.string().min(1),
});

/** Replace the text with revision n+1. `revision` is the one the editor started
 *  from; any approval on it is void. Destination and sender are NOT editable —
 *  to publish somewhere else, reject and let the agent propose again. */
const OutboxEditInput = z.object({
  itemId: z.string().min(1),
  revision: z.number().int().positive(),
  text: z.string().min(1),
  clientId: z.string().min(1),
});

/** `revoke` (withdraw an approval before the dispatcher claims it) and `retry`
 *  (re-approve a failed item at the same revision) need no binding: neither
 *  puts new text in front of anyone. */
const OutboxDecisionInput = z.object({
  itemId: z.string().min(1),
  clientId: z.string().min(1),
});

/** @experimental */
const outbox = {
  list: oc.input(OutboxListInput).output(OutboxListOutput),
  get: oc.input(OutboxGetInput).output(OutboxGetOutput),
  approve: oc.input(OutboxApproveInput).output(OutboxItemOutput),
  reject: oc.input(OutboxRejectInput).output(OutboxItemOutput),
  edit: oc.input(OutboxEditInput).output(OutboxItemOutput),
  revoke: oc.input(OutboxDecisionInput).output(OutboxItemOutput),
  retry: oc.input(OutboxDecisionInput).output(OutboxItemOutput),
};

// ---------------------------------------------------------------------------
// Learning — the review inbox for replay-gated learning
// (plan `trust-before-reach.md` Part 4, L-T8)
//
// Every learned change (a new skill, a skill rewrite, an Expression) waits here
// with its evidence, its replay scorecard and its timeline. This namespace is
// the web half of `LearningInbox` (`extensions/learning-inbox/src/inbox.ts`),
// which owns the two rules a client has to know:
//
//   - `approve` on a verdict other than `pass` — a candidate that was NEVER
//     replayed included — needs `override.reason`, and fails
//     `OVERRIDE_REQUIRED` without one. The reason lands on the timeline.
//   - every decision that lands writes exactly one `learning.approve |
//     override | reject | rollback` row to `ethos audit decisions`.
//
// Auth: cookie only. `learning` is deliberately absent from `SCOPE_MAP`
// (`apps/web-api/src/middleware/dual-auth.ts`), so a bearer API key fails
// closed on every procedure — approving a learned change is at least as
// sensitive as approving a publication, and `outbox` set that precedent.
// ---------------------------------------------------------------------------

const LearningListInput = z.object({
  personalityId: z.string().min(1).optional(),
  kind: LearningCandidateKindSchema.optional(),
  /** Restrict to these statuses — the inbox's list groups. Absent means all. */
  statuses: z.array(LearningCandidateStatusSchema).min(1).optional(),
  /** Candidates to return, newest first. */
  limit: z.number().int().min(1).max(500).optional(),
});
const LearningListOutput = z.object({ candidates: z.array(LearningCandidateViewSchema) });

const LearningCandidateIdInput = z.object({ candidateId: z.string().min(1) });

const LearningGetOutput = z.object({
  candidate: LearningCandidateViewSchema,
  /** What is live now — the left side of the diff. `core` is set for an Expression only. */
  current: z.object({ content: z.string().nullable(), core: z.string().nullable() }),
  /** The newest scorecard; null when the candidate was never replayed ("Not run"). */
  replay: LearningReplayReportViewSchema.nullable(),
  /** Every replay run, oldest first. */
  replayRunIds: z.array(z.string()),
  timeline: z.array(LearningTimelineEntryViewSchema),
  /**
   * Whether Rollback would proceed now. When not, `code` (`not_promoted`,
   * `live_edited`, `not_latest`, `no_record`) and `reason` explain the disabled
   * button — `live_edited` is "the live file has been edited since".
   */
  rollback: z.object({
    allowed: z.boolean(),
    code: z.string().nullable(),
    reason: z.string().nullable(),
  }),
});

/** Run once, synchronously; a replay costs minutes and real money (L-D6, L-D7). */
const LearningReplayOutput = z.object({
  candidate: LearningCandidateViewSchema,
  replay: LearningReplayReportViewSchema,
  /** True when L-D3's auto resolver promoted it on a `pass`. */
  promoted: z.boolean(),
  /** Why it did not promote, when it did not. */
  decisionReason: z.string().nullable(),
});

const LearningApproveInput = z.object({
  candidateId: z.string().min(1),
  /** Tab identity, recorded as `decidedBy` on the audit row. A label, never the gate. */
  clientId: z.string().min(1),
  /** Required unless the verdict is `pass` ("Approve anyway…"). */
  override: z.object({ reason: z.string().trim().min(1) }).optional(),
});

const LearningDecisionInput = z.object({
  candidateId: z.string().min(1),
  clientId: z.string().min(1),
  /** Optional free text for the timeline. */
  reason: z.string().trim().min(1).optional(),
});

/** Every decision answers with the candidate as it now stands. */
const LearningCandidateOutput = z.object({ candidate: LearningCandidateViewSchema });

/** @experimental */
const learning = {
  list: oc.input(LearningListInput).output(LearningListOutput),
  get: oc.input(LearningCandidateIdInput).output(LearningGetOutput),
  replay: oc.input(LearningCandidateIdInput).output(LearningReplayOutput),
  approve: oc.input(LearningApproveInput).output(LearningCandidateOutput),
  reject: oc.input(LearningDecisionInput).output(LearningCandidateOutput),
  rollback: oc.input(LearningDecisionInput).output(LearningCandidateOutput),
};

// ---------------------------------------------------------------------------
// Observed chats — the rooms a bot WATCHES and never answers
// (plan/phases/ambient-group-monitoring.md R12).
//
// Read-only, and deliberately thin: every field below is a field
// `ChannelTranscriptStore.listLanes` actually returns. Nothing is derived, and
// in particular NO MESSAGE TEXT crosses this wire. A room the agent is merely
// present in is not a room the operator gets to read out of a settings page —
// the transcript exists to be summarised by the digest turn, not browsed. The
// privacy line is the plan's (§8, "Never the last message text") and this
// schema is where it is actually enforced.
// ---------------------------------------------------------------------------

const ChannelObservedLaneSchema = z.object({
  /** `platform:botKey:chatId[:threadId]`, URL-encoded per segment. The row key. */
  laneKey: z.string(),
  platform: z.string(),
  /** Which configured bot watches this room. */
  botKey: z.string(),
  chatId: z.string(),
  /** Null for the root chat — a thread is a distinct room, and a distinct lane. */
  threadId: z.string().nullable(),
  /**
   * Messages whose `sentAt` falls inside the requested `since` window. Zero is
   * a real answer, not an absence: a watched room that was quiet today is
   * still watched, and dropping it would read as "we stopped listening".
   */
  count: z.number(),
  /** Newest `sentAt` in the lane, epoch ms — ignores `since`. */
  lastSentAt: z.number(),
});

const ChannelsObservedInput = z.object({
  /**
   * Window for `count`, epoch ms. The CALLER picks it, because "today" is a
   * question about the reader's clock and the server does not know their
   * timezone. Omitted means all time.
   */
  since: z.number().int().nonnegative().optional(),
  /** Lanes to return, newest-active first. Defaults to the store's own 500. */
  limit: z.number().int().min(1).max(500).optional(),
});

const ChannelsObservedOutput = z.object({
  lanes: z.array(ChannelObservedLaneSchema),
  /**
   * Watched lanes beyond `limit`. Same meaning, and the same name, as
   * `ChannelTranscriptPage.omittedCount`: the count that was dropped, said out
   * loud. `0` means the list is complete. Never truncate in silence (feedback
   * & activity contract §7, "nothing vanishes").
   */
  omittedCount: z.number(),
  /**
   * Why the transcript could not be read, when it could not be. NOT a thrown
   * error: a failed read is a `✗ failed` ROW that stays on the page beside
   * whatever else it says (contract §6), and a rejected RPC gives the client
   * an exception to render as a disappearing toast instead. `null` on success.
   *
   * `lanes: [], omittedCount: 0, error: null` is the honest empty house — no
   * bot has ever observed anything here.
   */
  error: z.string().nullable(),
});

/** @experimental */
const channels = {
  observed: oc.input(ChannelsObservedInput).output(ChannelsObservedOutput),
};

// ---------------------------------------------------------------------------
// A2A peering (admin surface) — thin RPC wrappers over the wiring
// `A2aPeeringService` + the runtime enable/disable control. Rides the same
// cookie/bearer `/rpc` auth as the other management namespaces; NOT the public
// peer-facing `/a2a` surface. Serve-wide `settings` toggle plus per-personality
// identity / peer / skill-exposure reads (plan §6, §13).
// ---------------------------------------------------------------------------

const A2aSettingsGetOutput = z.object({ enabled: z.boolean() });
const A2aSettingsSetInput = z.object({ enabled: z.boolean() });
const A2aSettingsSetOutput = z.object({ enabled: z.boolean() });

const A2aIdentityInput = z.object({ personalityId: z.string().min(1) });

const A2aPeersListInput = z.object({ personalityId: z.string().min(1) });

const A2aPeersPreviewInput = z.object({ url: z.string().min(1) });
// Only what the verify-step UI needs — the fetched fingerprint + peer
// name/description — NOT the whole signed card.
const A2aPeersPreviewOutput = z.object({
  fingerprint: z.string(),
  name: z.string(),
  description: z.string().optional(),
});

const A2aPeersAddInput = z.object({
  personalityId: z.string().min(1),
  url: z.string().min(1),
  /** The out-of-band fingerprint the peer gave you; must match the fetched
   *  card's fingerprint or the add is rejected (verify-first, plan §8). */
  expectedFingerprint: z.string().min(1),
  label: z.string().optional(),
});

const A2aPeersSetEnabledInput = z.object({
  personalityId: z.string().min(1),
  fingerprint: z.string().min(1),
  enabled: z.boolean(),
});

const A2aPeersRemoveInput = z.object({
  personalityId: z.string().min(1),
  fingerprint: z.string().min(1),
});

const A2aOkOutput = z.object({ ok: z.literal(true) });

const A2aSkillsListExposableInput = z.object({ personalityId: z.string().min(1) });
const A2aSkillsListExposableOutput = z.array(z.object({ name: z.string(), exposed: z.boolean() }));

/** @experimental */
const a2a = {
  settings: {
    get: oc.output(A2aSettingsGetOutput),
    set: oc.input(A2aSettingsSetInput).output(A2aSettingsSetOutput),
  },
  identity: oc.input(A2aIdentityInput).output(A2aIdentityViewSchema),
  peers: {
    list: oc.input(A2aPeersListInput).output(z.array(A2aPeerRowSchema)),
    preview: oc.input(A2aPeersPreviewInput).output(A2aPeersPreviewOutput),
    add: oc.input(A2aPeersAddInput).output(A2aPeerRowSchema),
    setEnabled: oc.input(A2aPeersSetEnabledInput).output(A2aOkOutput),
    remove: oc.input(A2aPeersRemoveInput).output(A2aOkOutput),
  },
  skills: {
    listExposable: oc.input(A2aSkillsListExposableInput).output(A2aSkillsListExposableOutput),
  },
};

// ---------------------------------------------------------------------------
// Named secrets — global vault manager for tool provider keys (Phase 2)
//
// A named secret lives at `providers/<provider>/<name>` in the vault. The raw
// value is written here and NEVER round-tripped back — `list` returns masked
// previews only. A personality stores just the secret NAME (a reference).
//
// WHICH providers exist is not stated here: it is derived from the
// `providers/<segment>/*` prefixes registered tools declare, and served by the
// `providers` procedure below. The wire only asserts the SHAPE of a provider id
// (plan/phases/tool-credential-surface.md D1).
// ---------------------------------------------------------------------------

const NamedSecretNameSchema = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9_-]+$/);

const NamedSecretViewSchema = z.object({
  provider: NamedSecretProviderNameSchema,
  name: z.string(),
  /** Masked preview (e.g. `…abc1`, or `<set>` / `<unset>`) — never the raw
   *  value, and never both ends of one. See `redactSecretValue`. */
  preview: z.string(),
  /** The provider's first declared `secretKind`. Tool-declared, so open. */
  kind: z.string(),
});

/** One row of the derived provider roster — a namespace an operator may type a
 *  credential into, with the presentation the declaring tool supplied. */
const NamedSecretProviderViewSchema = z.object({
  provider: NamedSecretProviderNameSchema,
  /** Every `secretKind` a tool declaring this provider binds. */
  kinds: z.array(z.string()),
  label: z.string(),
  getKeyUrl: z.string().optional(),
});

/** A declaration that grants nothing manageable. Reported, never thrown — a
 *  malformed capability prefix must not take down composition (D2, §11). */
const NamedSecretProviderDiagnosticSchema = z.object({
  toolName: z.string(),
  declared: z.string(),
  reason: z.string(),
});

/** @experimental */
const namedSecrets = {
  list: oc.output(z.object({ secrets: z.array(NamedSecretViewSchema) })),
  providers: oc.output(
    z.object({
      providers: z.array(NamedSecretProviderViewSchema),
      diagnostics: z.array(NamedSecretProviderDiagnosticSchema),
    }),
  ),
  create: oc
    .input(
      z.object({
        provider: NamedSecretProviderNameSchema,
        name: NamedSecretNameSchema,
        // 8 KiB cap — real API keys are well under 1 KiB; the bound stops a
        // client from filling the vault dir with a giant value.
        value: z.string().min(1).max(8192),
      }),
    )
    .output(z.object({ ok: z.literal(true), preview: z.string() })),
  delete: oc
    .input(z.object({ provider: NamedSecretProviderNameSchema, name: NamedSecretNameSchema }))
    .output(z.object({ ok: z.literal(true) })),
  testKey: oc
    .input(z.object({ provider: NamedSecretProviderNameSchema, name: NamedSecretNameSchema }))
    .output(
      z.object({
        ok: z.boolean(),
        error: z.string().optional(),
        /** `false` when the provider has no live probe (an `x` search call is
         *  billable) — `ok` then only says the secret exists. */
        tested: z.boolean().optional(),
      }),
    ),
};

// ---------------------------------------------------------------------------
// Credentials — stored logins for `browser_fill_credential`
// (plan reach-and-containment §4.2)
//
// A login is four vault refs under `credentials/<name>/`. Values are
// write-only: `list` returns a masked username preview and presence flags,
// never a value, and `set` echoes nothing back. Field validation (bare https
// origins, personality ids, TOTP seeds) is the server's — the wire only bounds
// sizes and shapes.
// ---------------------------------------------------------------------------

const CredentialViewSchema = z.object({
  name: z.string(),
  origins: z.array(z.string()),
  personalities: z.array(z.string()),
  unattended: z.boolean(),
  /** Masked via `redactSecretValue` — never the raw username. */
  usernamePreview: z.string(),
  hasPassword: z.boolean(),
  hasTotp: z.boolean(),
  /** False when the stored policy is missing or unparseable; the tool refuses it. */
  policyValid: z.boolean(),
});

/** @experimental */
const credentials = {
  list: oc.output(z.object({ credentials: z.array(CredentialViewSchema) })),
  set: oc
    .input(
      z.object({
        name: NamedSecretNameSchema,
        /** Required for a new login; omitted keeps the stored value. */
        username: z.string().min(1).max(8192).optional(),
        /** Required for a new login; omitted keeps the stored value. */
        password: z.string().min(1).max(8192).optional(),
        /** Omitted keeps the stored seed; `null` removes it. */
        totp: z.string().max(8192).nullable().optional(),
        origins: z.array(z.string().min(1).max(2048)).min(1).max(32),
        personalities: z.array(z.string().min(1).max(128)).max(64),
        unattended: z.boolean(),
      }),
    )
    .output(z.object({ ok: z.literal(true) })),
  delete: oc
    .input(z.object({ name: NamedSecretNameSchema }))
    .output(z.object({ ok: z.literal(true) })),
};

// ---------------------------------------------------------------------------
// Keys — masked inventory of the WHOLE secrets vault, by category
//
// A third read path onto the same vault `namedSecrets` and `models` already
// read, and deliberately so: it is the only one that shows everything. Its
// catalog partitions the vault — every ref is either claimed by a catalog
// entry or surfaces under `custom`, so nothing is silently hidden.
//
// Values are write-only, exactly as in `namedSecrets`: `list` returns masked
// previews and a raw value never comes back. A row the catalog marks as a
// reflection of a named secret is read-only here (`canSet`/`canClear` false) —
// it is edited from the Security pane that owns it.
// ---------------------------------------------------------------------------

/**
 * The complete set of fields a `blob` entry is allowed to expose — CLOSED, so
 * an unknown key REJECTS the response at the contract boundary instead of being
 * silently dropped or, worse, serialized. A `blob` ref holds a whole OAuth
 * token document (codex: `accessToken`, `refreshToken`, `idToken`, `accountId`,
 * `expiresAt`, `updatedAt`); three of those are bearer credentials, and an
 * open `z.record` would have permitted every one of them through the contract.
 *
 * Defence in depth: `parseCodexTokens` in
 * `apps/web-api/src/services/keys-catalog.ts` is the runtime allowlist that
 * picks these same two fields out of the document, and `KeysService.viewFor`
 * filters again to string values. This schema is the third and last gate — the
 * one a parser refactor or an object spread on the server cannot get past.
 * Changing either side means changing both.
 */
export const KeyBlobDetailsSchema = z.strictObject({
  accountId: z.string().optional(),
  expiresAt: z.string().optional(),
});
export type KeyBlobDetails = z.infer<typeof KeyBlobDetailsSchema>;

const KeyFieldViewSchema = z.object({
  key: z.string(),
  label: z.string(),
  /** The vault ref this field reads and writes. */
  ref: z.string(),
  /** Masked preview (e.g. `…abc1`, or `<set>` / `<unset>`) — never the raw
   *  value, and never both ends of one. See `redactSecretValue`. */
  preview: z.string(),
  set: z.boolean(),
});

const KeyEntryViewSchema = z.object({
  id: z.string(),
  category: KeyCategorySchema,
  label: z.string(),
  shape: z.enum(['single', 'multi', 'blob']),
  /** Empty for a `blob` entry — a blob has no editable fields. */
  fields: z.array(KeyFieldViewSchema),
  /** `blob` entries only. See `KeyBlobDetailsSchema` — CLOSED, so an unknown
   *  key is rejected here rather than serialized. */
  details: KeyBlobDetailsSchema.optional(),
  set: z.boolean(),
  canSet: z.boolean(),
  canClear: z.boolean(),
  getKeyUrl: z.string().optional(),
  /** Present only where a real live probe exists today. */
  probe: z.enum(['exa', 'tavily', 'brave', 'google']).optional(),
});

const KeyCategoryViewSchema = z.object({
  id: KeyCategorySchema,
  entries: z.array(KeyEntryViewSchema),
});

const KeysSetInput = z.object({
  id: z.string().min(1),
  /** fieldKey → raw value. 8 KiB cap per value, as in `namedSecrets`. */
  values: z.record(z.string(), z.string().min(1).max(8192)),
});

/** @experimental */
const keys = {
  list: oc.output(z.object({ categories: z.array(KeyCategoryViewSchema) })),
  set: oc.input(KeysSetInput).output(z.object({ ok: z.literal(true) })),
  clear: oc.input(z.object({ id: z.string().min(1) })).output(z.object({ ok: z.literal(true) })),
};

// ---------------------------------------------------------------------------
// Tool settings — generic per-personality tool config, driven by each tool's
// `settingsSchema` (Phase 2). `web_search` is the sole consumer in v1.
// ---------------------------------------------------------------------------

const ToolSettingsEnumFieldSchema = z.object({
  kind: z.literal('enum'),
  key: z.string(),
  label: z.string(),
  options: z.array(
    z.object({
      value: z.string(),
      label: z.string().optional(),
      /** Where the operator gets a key for this option's provider. */
      getKeyUrl: z.string().optional(),
    }),
  ),
  default: z.string().optional(),
  required: z.boolean().optional(),
});
const ToolSettingsSecretBindingFieldSchema = z.object({
  kind: z.literal('secret-binding'),
  key: z.string(),
  label: z.string(),
  secretKind: z.string(),
  required: z.boolean().optional(),
  helpText: z.string().optional(),
  /** Presentation for the provider namespace this credential lives in, and the
   *  tool's own default secret name. Mirrors `ToolSettingsSecretBindingField`
   *  in `@ethosagent/types` — the hand-maintained mirror the derived roster
   *  reads its labels through, so the two must change together (D4). */
  providerLabel: z.string().optional(),
  getKeyUrl: z.string().optional(),
  defaultSecretName: z.string().optional(),
});
/** A static disclosure row — no key, so nothing round-trips through it. Mirrors
 *  `ToolSettingsInfoField` in `@ethosagent/types`; a tool that needs a
 *  credential it does not bind itself says so here. */
const ToolSettingsInfoFieldSchema = z.object({
  kind: z.literal('info'),
  label: z.string(),
  text: z.string(),
});
const ToolSettingsSchemaSchema = z.object({
  fields: z.array(
    z.discriminatedUnion('kind', [
      ToolSettingsEnumFieldSchema,
      ToolSettingsSecretBindingFieldSchema,
      ToolSettingsInfoFieldSchema,
    ]),
  ),
});

/** settings key (`settingsKey ?? toolName`) → fieldKey → string value. Only a
 *  secret NAME is ever carried for a secret-binding field — never a value. */
const ToolSettingsValuesSchema = z.record(z.string(), z.record(z.string(), z.string()));
const ToolStorageSchema = z.enum(['personality', 'global']);

/** @experimental */
const toolSettings = {
  schemas: oc.output(
    z.object({
      tools: z.array(
        z.object({
          name: z.string(),
          /** Storage slot the tool's settings live in; absent → the tool name.
           *  Two tools sharing one credential report the same key, and the UI
           *  renders ONE form per key. Mirrors `Tool.settingsKey`. */
          settingsKey: z.string().optional(),
          settingsSchema: ToolSettingsSchemaSchema,
        }),
      ),
    }),
  ),
  getDefault: oc.output(z.object({ values: ToolSettingsValuesSchema })),
  setDefault: oc
    .input(z.object({ values: ToolSettingsValuesSchema }))
    .output(z.object({ ok: z.literal(true) })),
  getForPersonality: oc
    .input(z.object({ personalityId: z.string().min(1) }))
    .output(z.object({ values: ToolSettingsValuesSchema, storage: ToolStorageSchema })),
  setForPersonality: oc
    .input(z.object({ personalityId: z.string().min(1), values: ToolSettingsValuesSchema }))
    .output(z.object({ ok: z.literal(true), storage: ToolStorageSchema })),
  /**
   * Read-only resolution probe: for each secret-bearing tool group in the
   * personality's toolset, report the ref the tool's ladder would resolve,
   * which rung supplied it, and whether a non-empty value is present — never
   * the value itself (plan/phases/tool-credential-surface.md D9 / PR3).
   */
  probeCredentials: oc.input(z.object({ personalityId: z.string().min(1) })).output(
    z.object({
      credentials: z.array(
        z.object({
          key: z.string(),
          toolNames: z.array(z.string()),
          ref: z.string(),
          rung: z.enum(['personality', 'global-personality', 'global-default', 'tool-default']),
          present: z.boolean(),
          origin: z.enum(['set-here', 'inherited', 'unset']),
        }),
      ),
    }),
  ),
};

// ---------------------------------------------------------------------------
// Documents — the operator's view of the files the agent writes
//
// Rooted at the personality's declared `fs_reach.workdir`, NOT its personality
// directory: SOUL.md / config.yaml / mcp.yaml stay off this surface. Every
// `path` is RELATIVE to that root; the service joins and lets `ScopedStorage`
// judge, so a `..` or absolute path is refused rather than interpreted.
//
// Bytes never travel over RPC. Download is a streaming, cookie-authenticated
// `GET /documents/download` — see `apps/web-api/src/routes/documents.ts`.
// ---------------------------------------------------------------------------

const DocumentEntrySchema = z.object({
  name: z.string(),
  /** Path relative to the workdir root — feed it straight back to list/delete. */
  path: z.string(),
  isDir: z.boolean(),
  /** Absent for directories and for entries that could not be stat'd. */
  size: z.number().optional(),
  mtimeMs: z.number().optional(),
  /** Symlinks are LISTED so the operator can see them, but refused on
   *  download and delete — they can point outside the workdir. */
  isSymlink: z.boolean(),
});

/**
 * Which scope the call addresses: a personality (omitted `personalityId` means
 * the configured default) or, with `team`, a team's work directory
 * (`~/.ethos/teams/<team>/`, its one root). Passing both is refused.
 */
const DocumentsScopeInput = z.object({
  personalityId: z.string().min(1).optional(),
  team: z.string().min(1).optional(),
});

/**
 * Every root the scope declares. `id` is opaque to the client — feed it back
 * as `root` on list/delete/createFolder and on the download/upload routes.
 * Exactly one of `personalityId` / `team` echoes which scope answered.
 *
 * An EMPTY `roots` array is the "Documents unconfigured" answer, not an error:
 * the personality declares no `fs_reach.workdir` at all (or the team has no
 * work directory yet), so there is nothing to browse. Every other procedure
 * fails with `WORKDIR_NOT_CONFIGURED` in that state; `root` is the discovery
 * call that lets the UI say so plainly.
 */
const DocumentsRootOutput = z.object({
  roots: z.array(z.object({ id: z.string(), path: z.string() })),
  personalityId: z.string().optional(),
  team: z.string().optional(),
});

/** Which declared root the operation addresses — an `id` from `documents.root`. */
const DocumentsRootInput = DocumentsScopeInput.extend({ root: z.string().min(1) });

const DocumentsListInput = DocumentsRootInput.extend({
  /** Subdirectory relative to the root. Omitted = the root itself. */
  path: z.string().optional(),
});
const DocumentsListOutput = z.object({ entries: z.array(DocumentEntrySchema) });

const DocumentsDeleteInput = DocumentsRootInput.extend({ path: z.string().min(1) });
const DocumentsDeleteOutput = z.object({ ok: z.literal(true) });

/** Creates exactly ONE directory — the parent must already exist. */
const DocumentsCreateFolderInput = DocumentsRootInput.extend({ path: z.string().min(1) });

/** @experimental */
const documents = {
  root: oc.input(DocumentsScopeInput).output(DocumentsRootOutput),
  list: oc.input(DocumentsListInput).output(DocumentsListOutput),
  delete: oc.input(DocumentsDeleteInput).output(DocumentsDeleteOutput),
  // No `upload` here on purpose — bytes never travel over RPC (see the
  // namespace note above). Upload is `POST /documents/upload`, a raw
  // cookie-authed Hono route, exactly as download is a raw GET.
  createFolder: oc.input(DocumentsCreateFolderInput).output(DocumentEntrySchema),
};

// ---------------------------------------------------------------------------
// Recipes — one-click use-case bundles (plan/phases/recipes-gallery.md §4)
//
// `list` takes no input: the catalog is curated, static and small, the same
// call shape as `mcp.catalog` and `dashboards.listWidgetTemplates`. Filtering
// by tag is client-side; a query parameter on a three-row list is speculative.
//
// There is deliberately NO `installStream`. Install is three bounded writes;
// SSE would buy latency theatre and cost a second protocol.
// ---------------------------------------------------------------------------

const RecipesListOutput = z.object({ recipes: z.array(RecipeListItemSchema) });

const RecipesGetInput = z.object({ id: z.string().min(1) });
const RecipesGetOutput = z.object({ recipe: RecipeBundleWireSchema });

/**
 * Read-only, repeatable, and stateless — there is no server-side wizard
 * session, so a reload loses nothing and nothing can expire. `inputs` is
 * whatever the user has typed SO FAR: the `needsInput` list shrinks live as it
 * fills. `characterSheet` rides along so the preview needs no second call.
 */
const RecipesPreflightInput = z.object({
  id: z.string().min(1),
  inputs: z.record(z.string(), z.string()).optional(),
  /**
   * Create mode: install under a different personality id (the collision
   * escape hatch). Attach mode: the TARGET personality the recipe attaches
   * to — required there, and preflight emits `PERSONALITY_REQUIRED` until it
   * is given.
   */
  personalityIdOverride: z.string().min(1).optional(),
  /**
   * For a `mode: 'both'` recipe: which view to preflight — `create` (default)
   * or `attach`. Ignored for a single-mode recipe, whose mode is its own.
   */
  installMode: RecipeInstallModeSchema.optional(),
  /**
   * The named secret picked for each credential requirement. Preflight's
   * satisfied-check runs against THIS binding — the one the install would
   * write — so the row clears only when the chosen key actually exists.
   */
  secretBindings: RecipeSecretBindingsSchema.optional(),
});

/**
 * `version` is optimistic concurrency on the preview: a client that previewed
 * v1 and installs against a shipped v2 is refused with `RECIPE_STALE` and
 * re-previews. Without it, an upgrade during a long confirm step silently
 * installs something the user never saw.
 *
 * `deliverTo` is the authoritative delivery target for every cron job the
 * bundle marks `deliverTo: 'channel'`. It is a `cron.deliveryTargets` row the
 * user picked — never free text, and re-validated server-side by
 * `CronService.create` whatever the client previewed.
 */
const RecipesInstallInput = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  inputs: z.record(z.string(), z.string()),
  /** Same meaning as on `preflight`: an alternate id (create) or the target (attach). */
  personalityIdOverride: z.string().min(1).optional(),
  /** Same meaning as on `preflight`: the view a `both` recipe installs as. */
  installMode: RecipeInstallModeSchema.optional(),
  deliverTo: CronDeliverToSchema.optional(),
  /**
   * Inline channel setup — the fix for the chicken-and-egg that made
   * "Deliver to" permanently unsatisfiable. `platforms.botsAddTelegram`
   * requires a `bind` naming an EXISTING personality, and the recipe's
   * personality does not exist until the install creates it, so the bot cannot
   * be made in Communications beforehand. The install therefore makes it, in
   * order: create the personality, add and bind the bot, then the cron job.
   *
   * Mutually exclusive with `deliverTo`: this arm's `botKey` is not knowable
   * until the bot exists, so the server derives the delivery target itself.
   */
  channelSetup: RecipeChannelSetupSchema.optional(),
  /**
   * The named secret each credential requirement was answered with. The install
   * writes it onto the new personality's tool settings, because a key stored
   * under any name but the tool's default is invisible to the tool without a
   * binding — a silent no-results agent, which is what this whole step exists
   * to prevent. A binding naming a secret that does not exist leaves the
   * requirement unsatisfied, so the install refuses before the first write.
   */
  secretBindings: RecipeSecretBindingsSchema.optional(),
});

/**
 * READ-ONLY. One `getUpdates` per press — never a long poll, and never with an
 * `offset`, which would acknowledge the user's message and delete the very
 * update the install re-reads to authorize their pick.
 */
const RecipesDiscoverChatsInput = z.object({
  platform: z.literal('telegram'),
  token: z.string().min(1),
});

/** @experimental */
const recipes = {
  list: oc.output(RecipesListOutput),
  get: oc.input(RecipesGetInput).output(RecipesGetOutput),
  preflight: oc.input(RecipesPreflightInput).output(RecipePreflightSchema),
  discoverChats: oc.input(RecipesDiscoverChatsInput).output(RecipeDiscoverChatsOutputSchema),
  install: oc.input(RecipesInstallInput).output(RecipeInstallReportSchema),
};

// ---------------------------------------------------------------------------
// Backup — local archives of `~/.ethos`, and the identity-only restore
// (plan/phases/agent-state-backup.md §5, D6)
//
// The pane is status-first, so `status` answers the whole header in one call:
// what the last backup was, when the next scheduled one runs, whether the
// schedule is on at all, which stores are in scope, and what archives are on
// disk. One round trip, one refresh after a create — the alternative was four
// procedures the pane would always call together.
//
// Bytes never travel over RPC. Download is a streaming, cookie-authenticated
// `GET /backup/download` — see `apps/web-api/src/routes/backup.ts`. The
// `downloadAvailable` flag below is how a Bearer caller (desktop remote mode)
// learns the route cannot serve it, instead of rendering a link that 401s.
//
// RESTORE IS `identity` ONLY (D6). A live server holds every database open, so
// a `state` restore cannot pass the core's in-use lock gate and is refused
// here — by the service, not by the absence of a button.
// ---------------------------------------------------------------------------

const BackupScopeSchema = z.enum(['identity', 'state', 'telemetry']);

/**
 * One archive file in the backup directory.
 *
 * There is deliberately no `scopes` field. The manifest that records them is
 * the LAST entry in the archive (plan D3), so reading it means decompressing
 * the whole thing — a listing of seven multi-hundred-megabyte archives is not
 * the place for that. `schedule.scopes` says what the configured scope set is;
 * a per-archive answer costs a full read and belongs to restore, which does
 * one anyway.
 */
const BackupArchiveSchema = z.object({
  /** Filename inside the backup directory. Feed it back as `?name=` on the
   *  download route and as `name` on `restoreIdentity`. */
  name: z.string(),
  bytes: z.number().int().nonnegative(),
  /** ISO-8601, from the file's mtime. */
  createdAt: z.string(),
  /** True when the scheduled job wrote it (and rotation may delete it). */
  scheduled: z.boolean(),
});

/**
 * The header's anchor. `ok: false` means the most recent ATTEMPT failed — the
 * archive it would have written is absent, so `archive` is null and `error`
 * carries the reason. A success carries the archive and no error.
 */
const BackupLastRunSchema = z.object({
  ok: z.boolean(),
  /** ISO-8601 — when the attempt finished. */
  at: z.string(),
  archive: BackupArchiveSchema.nullable(),
  error: z.string().nullable(),
});

/**
 * `backup.*` in config.yaml, resolved. `enabled` is what makes the pane's
 * schedule toggle honest: a next run is only meaningful when the job exists.
 */
const BackupScheduleSchema = z.object({
  enabled: z.boolean(),
  cron: z.string(),
  scopes: z.array(BackupScopeSchema),
  keep: z.number().int().positive(),
  /** From the `backup` system cron job. Null when the job is absent (schedule
   *  off) or this deployment runs no scheduler. */
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  lastError: z.string().nullable(),
});

/**
 * One row per known SQLite store (`WAL_STORES` in `@ethosagent/wiring`), which
 * is the drift-gated registry — a store added to the repo without a scope
 * decision fails CI, so this list cannot quietly go stale.
 */
const BackupStoreRowSchema = z.object({
  /** `~/.ethos`-relative database path, e.g. `sessions.db`. */
  database: z.string(),
  /** The scope that carries it, or null when it is deliberately excluded. */
  scope: BackupScopeSchema.nullable(),
  /** True when `scope` is non-null AND in the configured scope set. */
  included: z.boolean(),
  /** Why it sits in that scope, or why it is excluded. From the registry. */
  reason: z.string(),
  /**
   * Coarse, from mtimes — `changed` when the file is newer than the most
   * recent archive. `absent` when this deployment has never created the
   * database; `unknown` when there is no archive to compare against yet.
   */
  changed: z.enum(['changed', 'unchanged', 'absent', 'unknown']),
});

const BackupStatusOutput = z.object({
  /** Absolute path archives are written to (`backup.dir`, defaulted). */
  directory: z.string(),
  /**
   * ISO-8601 boot time of THIS server process. An identity restore rewrites
   * config.yaml / mcp.json, which are read at boot, so the pane pins its
   * "restart required" notice to the value it saw and clears it only when a
   * later status returns a different one. Nothing else can tell it the
   * restart actually happened.
   */
  serverStartedAt: z.string(),
  /** True while a web-triggered create is in flight in this process. */
  running: z.boolean(),
  /**
   * False when the caller authenticated with a Bearer API key. The download
   * route is cookie-only — an `<a download>` navigation carries the cookie but
   * cannot attach a header — so desktop remote mode must render the CLI
   * instructions instead of a link that would 401.
   */
  downloadAvailable: z.boolean(),
  schedule: BackupScheduleSchema,
  lastBackup: BackupLastRunSchema.nullable(),
  /** Newest first. */
  archives: z.array(BackupArchiveSchema),
  stores: z.array(BackupStoreRowSchema),
});

/** Omitted `scopes` uses the configured `backup.scope` (default identity+state). */
const BackupCreateInput = z.object({
  scopes: z.array(BackupScopeSchema).min(1).optional(),
});

const BackupCreateOutput = z.object({
  archive: BackupArchiveSchema,
  scopes: z.array(BackupScopeSchema),
  fileCount: z.number().int().nonnegative(),
  /** Uncompressed bytes archived — not the archive's own size. */
  uncompressedBytes: z.number().int().nonnegative(),
  /**
   * Files enumerated but not encodable as a tar entry, and databases no scope
   * rule accounts for. Both are reported rather than fatal, and both MUST be
   * surfaced — a silent drop is the failure mode a backup cannot have.
   */
  skipped: z.array(z.object({ path: z.string(), reason: z.string() })),
  unclassifiedDatabases: z.array(z.string()),
});

/**
 * `scopes` exists so the refusal is a REFUSAL and not a schema error: asking
 * for `state` here returns FORBIDDEN naming why (D6), which the pane can
 * render, rather than a 400 the user cannot act on. Omitted means `identity`.
 */
const BackupRestoreIdentityInput = z.object({
  /** An archive `name` from `status.archives`. Single path segment; the route
   *  and the service both refuse anything else. */
  name: z.string().min(1),
  scopes: z.array(BackupScopeSchema).min(1).optional(),
  /** Report what would happen and change nothing. */
  dryRun: z.boolean().optional(),
});

const BackupRestoreOutput = z.object({
  dryRun: z.boolean(),
  scopes: z.array(BackupScopeSchema),
  /** When the archive was made, from its manifest. */
  createdAt: z.string(),
  /** `~/.ethos`-relative paths written (or, in a dry run, that would be). */
  restored: z.array(z.string()),
  /** Existing files moved aside first, and where they went. */
  displaced: z.array(z.string()),
  displacedTo: z.string().nullable(),
  /**
   * Whether the in-use lock gate RAN. `skipped_dry_run` / `skipped_force` mean
   * no check was made — `lockedDatabases` is then empty because nothing was
   * asked, NOT because nothing was running. The pane must never render an
   * empty list under those two as "nothing was running".
   */
  inUseCheck: z.enum(['held', 'skipped_dry_run', 'skipped_force']),
  lockedDatabases: z.array(z.string()),
  /** True when config.yaml or mcp.json was restored — both are read at boot. */
  restartRequired: z.boolean(),
  warnings: z.array(
    z.object({
      kind: z.enum(['fs_reach_absolute', 'skipped_path', 'unclassified_database']),
      path: z.string(),
      message: z.string(),
    }),
  ),
  /**
   * The archive's `secrets.manifest.yaml` verbatim, when it carries one. This
   * is OPERATOR INSTRUCTIONS written by whoever made the archive — untrusted
   * text. Render it as text, never as commands, and never execute it. It names
   * credentials; it never contains their values (the vault is excluded from
   * every scope).
   */
  secretsManifest: z.string().nullable(),
});

export type BackupScopeName = z.infer<typeof BackupScopeSchema>;
export type BackupArchive = z.infer<typeof BackupArchiveSchema>;
export type BackupLastRun = z.infer<typeof BackupLastRunSchema>;
export type BackupSchedule = z.infer<typeof BackupScheduleSchema>;
export type BackupStoreRow = z.infer<typeof BackupStoreRowSchema>;
export type BackupStatus = z.infer<typeof BackupStatusOutput>;
export type BackupCreateResult = z.infer<typeof BackupCreateOutput>;
export type BackupRestoreResult = z.infer<typeof BackupRestoreOutput>;

/** @experimental */
const backup = {
  status: oc.output(BackupStatusOutput),
  create: oc.input(BackupCreateInput).output(BackupCreateOutput),
  restoreIdentity: oc.input(BackupRestoreIdentityInput).output(BackupRestoreOutput),
};

// ---------------------------------------------------------------------------
// Execution — the deployment's single remote target
// (plan/phases/remote-execution-routing.md §6, T7)
//
// One procedure, because the pane asks one question: can this machine reach the
// host that `execution: ssh` personalities run their terminal on, right now?
//
// UNCACHED, and that word is the whole contract. The backend keeps a 60 s
// success cache behind `isAvailable()` so a `run_code` invocation does not open
// a connection per call; a `Test connection` button that read that cache would
// answer about a moment the operator has already left — which is exactly the
// moment they pressed the button to get past. So the service calls `probe()`,
// which opens a real connection every time.
//
// `error` is the ssh client's own stderr, VERBATIM. `Permission denied
// (publickey)` and `Connection timed out` need completely different fixes and
// only the real line says which, so nothing here summarises, prettifies or
// re-words it. (ssh prints auth refusals without its `ssh:` prefix, so those
// arrive as a remote exit 255 rather than a transport error; `probe()` reports
// them the same way, and so does this.)
// ---------------------------------------------------------------------------

const ExecutionProbeStateSchema = z.discriminatedUnion('state', [
  /** No `execution.ssh.host`. NOT a failure — a fresh install has no target. */
  z.object({ state: z.literal('not_configured') }),
  z.object({
    state: z.literal('reachable'),
    /** `user@host:port`, as `formatSshTarget` renders it. */
    target: z.string(),
    /** Wall clock of the probe, milliseconds. */
    latencyMs: z.number().int().nonnegative(),
  }),
  z.object({
    state: z.literal('unreachable'),
    target: z.string(),
    /** The ssh client's stderr line, verbatim. */
    error: z.string(),
  }),
  /**
   * The backend could not be CONSTRUCTED — the boot failure of §6, seen from
   * the surface that asked. Distinct from `unreachable`: no connection was
   * attempted, so calling it unreachable would blame the network for a
   * deployment fault.
   */
  z.object({
    state: z.literal('backend_unresolved'),
    target: z.string(),
    error: z.string(),
  }),
  /**
   * `execution.ssh.*` was edited after this process booted, so the backend the
   * tools run on was built against a DIFFERENT target than config.yaml now
   * names. The execution-backend registry memoises: the instance survives the
   * edit, and nothing re-reads config until a restart.
   *
   * NEITHER host is contacted. Probing `activeTarget` would answer a question
   * about a host the operator has just stopped pointing at; probing `target`
   * would answer about a machine no tool will touch until a restart. Both are
   * false reassurance, so the state IS the answer — and it is not a failure of
   * either machine, which is why it carries no `error`.
   */
  z.object({
    state: z.literal('stale_config'),
    /** What `execution.ssh.*` names NOW. Not contacted. */
    target: z.string(),
    /**
     * What the running backend was constructed with — and therefore what every
     * `execution: ssh` personality's tools still execute on until a restart.
     * The operationally important half.
     */
    activeTarget: z.string(),
  }),
]);

const ExecutionProbeSshOutput = z.object({
  /**
   * Personality ids whose `execution` posture is `ssh` — the posture line under
   * the header (`ssh — used by: remote-hands`). Present in EVERY state,
   * including `not_configured`: a personality that declares a remote posture
   * with no host configured is the one case an operator most needs to see.
   */
  usedBy: z.array(z.string()),
  result: ExecutionProbeStateSchema,
});

export type ExecutionProbeResult = z.infer<typeof ExecutionProbeSshOutput>;
export type ExecutionProbeState = z.infer<typeof ExecutionProbeStateSchema>;

/** @experimental */
const execution = {
  probeSsh: oc.output(ExecutionProbeSshOutput),
};

// ---------------------------------------------------------------------------
// Root contract — every namespace mounted under one symbol
// ---------------------------------------------------------------------------

export const contract = {
  sessions,
  activity,
  personalities,
  chat,
  tools,
  approvals,
  clarify,
  onboarding,
  config,
  debug,
  cron,
  skills,
  slashCommands,
  evolver,
  mesh,
  memory,
  plugins,
  mcp,
  platforms,
  batch,
  eval: evalNs,
  kanban,
  teams,
  apiKeys,
  meta,
  models,
  modelRegistry,
  dashboards,
  admin,
  context,
  files,
  goals,
  tasks,
  digest,
  voice,
  deliveries,
  outbox,
  learning,
  channels,
  a2a,
  namedSecrets,
  credentials,
  keys,
  toolSettings,
  documents,
  recipes,
  backup,
  execution,
};

export type Contract = typeof contract;
