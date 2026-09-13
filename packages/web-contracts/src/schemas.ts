import { SECRET_NAME_RE } from '@ethosagent/types';
import { z } from 'zod';

// Wire-format schemas. These mirror the in-memory shapes from
// `@ethosagent/types` (Session, StoredMessage, PersonalityConfig, etc.) but
// strip server-internal fields (filesystem paths, loader-populated metadata)
// before they reach the client.
//
// All `Date` values cross the wire as ISO-8601 strings.

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const SessionUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheCreationTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative(),
  apiCallCount: z.number().int().nonnegative(),
  compactionCount: z.number().int().nonnegative(),
});
export type SessionUsage = z.infer<typeof SessionUsageSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  key: z.string(),
  platform: z.string(),
  model: z.string(),
  provider: z.string(),
  personalityId: z.string().nullable(),
  parentSessionId: z.string().nullable(),
  workingDir: z.string().nullable(),
  title: z.string().nullable(),
  pinned: z.boolean(),
  usage: SessionUsageSchema,
  createdAt: z.string(), // ISO-8601
  updatedAt: z.string(), // ISO-8601
  /** Optimistic-concurrency version. v1 always returns 1. */
  version: z.number().int(),
});
export type Session = z.infer<typeof SessionSchema>;

export const MessageRoleSchema = z.enum([
  'user',
  'assistant',
  'tool_result',
  'system',
  'user_steer',
]);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const StoredMessageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  role: MessageRoleSchema,
  content: z.string(),
  toolCallId: z.string().nullable(),
  toolName: z.string().nullable(),
  toolCalls: z.array(ToolCallSchema).nullable(),
  /**
   * Did this `tool_result` row record a failure? Optional, not nullable:
   * ABSENT means the outcome was never recorded (a row written before the
   * flag existed), which is not the same as `false`. Surfaces must not read
   * absent as success.
   */
  isError: z.boolean().optional(),
  timestamp: z.string(), // ISO-8601
});
export type StoredMessage = z.infer<typeof StoredMessageSchema>;

// ---------------------------------------------------------------------------
// Personalities
//
// `id` / `name` / `description` / `model` / `streamingTimeoutMs`
// are user-facing fields from PersonalityConfig. `soulFile` / `skillsDirs`
// (server filesystem paths) are intentionally NOT in the wire schema.
// ---------------------------------------------------------------------------

export const ModelTierConfigSchema = z.object({
  trivial: z.string().optional(),
  default: z.string().optional(),
  deep: z.string().optional(),
});
export type ModelTierConfigWire = z.infer<typeof ModelTierConfigSchema>;

export const PersonalitySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  model: z.union([z.string(), ModelTierConfigSchema]).nullable(),
  provider: z.string().nullable(),
  toolset: z.array(z.string()).nullable(),
  capabilities: z.array(z.string()).nullable(),
  streamingTimeoutMs: z.number().int().positive().nullable(),
  /** Allowed MCP server names. null = not configured (no access). */
  mcp_servers: z.array(z.string()).nullable(),
  /** Attached plugin ids. null = not configured (default-deny). */
  plugins: z.array(z.string()).nullable(),
  fs_reach: z
    .object({
      read: z.array(z.string()).nullable(),
      write: z.array(z.string()).nullable(),
      /**
       * Every declared working directory, substitution tokens unresolved, in
       * declaration order. `null` = undeclared.
       *
       * A LIST, not a string, because `fs_reach.workdir` accepts several roots
       * (the Documents surface browses each as its own root) and this is the
       * shape the config editor round-trips. Surfacing only the first entry
       * here made saving a multi-root personality from the web UI collapse it
       * to one root — the editor writes back what it was given.
       */
      workdir: z.array(z.string()).nullable(),
    })
    .nullable(),
  /** Idle-time dreaming state. Optional (omitted when unset) so the editor
   *  can read the current toggle and cadence without affecting other surfaces. */
  dreaming: z
    .object({
      enable: z.boolean(),
      idleMinutes: z.number().int().optional(),
      maxPerDay: z.number().int().optional(),
    })
    .optional(),
  /** Governed-learning approval dial. Optional (omitted when unset) so the
   *  editor can read the current value to populate its form. */
  evolution_approval_mode: z.enum(['auto', 'user']).optional(),
  /** Skill-evolution tuning. Optional (omitted when unset) so the editor can
   *  read the current values to populate its form. */
  skill_evolution: z
    .object({
      enabled: z.boolean().optional(),
      min_tool_calls: z.number().int().optional(),
      cooldown_minutes: z.number().int().optional(),
      model: z.string().optional(),
      evolve_existing: z.boolean().optional(),
      promotion: z.enum(['review', 'auto']).optional(),
      scope: z.enum(['personality', 'shared']).optional(),
    })
    .optional(),
  /** Per-personality safety dial. Optional (omitted when unset) so the editor
   *  can read the current approval mode and network reach to populate its
   *  form. A sub-key the editor can WRITE but not READ is one a save wipes. */
  safety: z
    .object({
      approvalMode: z.enum(['manual', 'smart', 'off']).optional(),
      /** Declared network reach (Ch.7), read back for the allowed-hosts editor.
       *  Sits UNDER the non-overridable floor: cloud-metadata and private
       *  ranges stay blocked whatever is listed here. */
      network: z
        .object({
          allow: z.array(z.string()).optional(),
          deny: z.array(z.string()).optional(),
          allow_private_urls: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
  /** Per-personality memory backend. Optional (omitted when unset) so the
   *  editor can read the current provider to populate its form. */
  memory: z.object({ provider: z.string().optional() }).optional(),
  /** How this personality looks across identity surfaces — currently just a
   *  custom avatar image URL. Optional (omitted when unset) so surfaces fall
   *  back to the generated mark. */
  display: z.object({ avatar_url: z.string().optional() }).optional(),
  /** Nightly governed-learning gates. Optional (omitted when unset) so the
   *  editor can read the current toggles to populate its form. */
  nightly: z
    .object({
      enabled: z.boolean().optional(),
      judge: z
        .object({
          enabled: z.boolean().optional(),
          minInteractions: z.number().int().optional(),
        })
        .optional(),
      expression: z.boolean().optional(),
    })
    .optional(),
  /** How this personality sounds, listens, and looks on a call — the sub-keys
   *  the editor writes: `voice.tts_provider` / `voice.stt_provider` /
   *  `voice.realtime_provider` (roster labels), `voice.tts_voice`,
   *  `voice.call_style`, `voice.tier`, `voice.model` and the
   *  `voice.languages.<tag>` map. Read back so the editor can populate its form
   *  — a field the editor cannot READ is a field a save silently erases.
   *  Omitted when the personality declares no voice. */
  voice: z
    .object({
      tts_provider: z.string().optional(),
      stt_provider: z.string().optional(),
      realtime_provider: z.string().optional(),
      tts_voice: z.string().optional(),
      call_style: z.enum(['liquid', 'orb', 'rings']).optional(),
      tier: z.enum(['pipeline', 'realtime']).optional(),
      model: z.string().optional(),
      languages: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  system: z.boolean(),
  /** True when the personality lives in the package's built-in data directory
   *  (read-only). User-created personalities under `~/.ethos/personalities/`
   *  are mutable. */
  builtin: z.boolean(),
  /** Optimistic-concurrency version. v1 always returns 1. */
  version: z.number().int(),
});
export type Personality = z.infer<typeof PersonalitySchema>;

// ---------------------------------------------------------------------------
// Tool approval (used by SSE push + tools.approve/deny RPCs)
// ---------------------------------------------------------------------------

export const ApprovalScopeSchema = z.enum([
  'once', // Allow this single invocation
  'exact-args', // Allow this tool with these exact arguments
  'any-args', // Allow this tool with any arguments
]);
export type ApprovalScope = z.infer<typeof ApprovalScopeSchema>;

export const ApprovalRequestSchema = z.object({
  approvalId: z.string(),
  sessionId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  args: z.unknown(),
  reason: z.string().nullable(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

export const OnboardingStepSchema = z.enum([
  'welcome',
  'provider',
  'personality',
  'integrations',
  'first-turn',
  'done',
]);
export type OnboardingStep = z.infer<typeof OnboardingStepSchema>;

export const ProviderIdSchema = z.enum([
  'anthropic',
  'openai',
  'openrouter',
  'openai-compat',
  'ollama',
  'azure',
  'codex',
  'xai',
]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const ProviderEntrySchema = z.object({
  provider: z.string(),
  model: z.string().nullable(),
  apiKeyPreview: z.string(),
  baseUrl: z.string().nullable(),
});
export type ProviderEntry = z.infer<typeof ProviderEntrySchema>;

// ---------------------------------------------------------------------------
// Cron — proactive pillar of v0.5
//
// Mirrors the `CronJob` shape from `@ethosagent/cron`. Wire-side uses
// nullable instead of optional for fields that may legitimately be unset
// on disk, so the client doesn't have to guess between "missing" and
// "explicitly null".
// ---------------------------------------------------------------------------

export const JobStatusSchema = z.enum(['active', 'paused', 'done']);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const MissedRunPolicySchema = z.enum(['run-once', 'skip']);
export type MissedRunPolicy = z.infer<typeof MissedRunPolicySchema>;

export const CronJobSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 5-field cron expression e.g. `0 8 * * 1-5`. */
  schedule: z.string(),
  prompt: z.string(),
  personalityId: z.string(),
  /** Delivery target — derived from origin platform. Null means "store output to disk only". */
  deliver: z.string().nullable(),
  status: JobStatusSchema,
  missedRunPolicy: MissedRunPolicySchema,
  source: z.enum(['system', 'user']).default('user'),
  systemTask: z.string().nullable().optional(),
  /** ISO-8601 of last run, or null if never run. */
  lastRunAt: z.string().nullable(),
  /** ISO-8601 of next scheduled run, or null when paused / unscheduled. */
  nextRunAt: z.string().nullable(),
  createdAt: z.string(),
});
export type CronJob = z.infer<typeof CronJobSchema>;

export const CronRunSchema = z.object({
  /** ISO-8601 timestamp parsed from the output filename. */
  ranAt: z.string(),
  /** Server-side absolute path to the output file. The client treats it
   *  as opaque and uses it to fetch full output via cron.history. */
  outputPath: z.string(),
  /** Full output body — present when the run is the head of `cron.history`
   *  and inline-fetched. Listed runs leave it absent for compactness. */
  output: z.string().nullable(),
});
export type CronRun = z.infer<typeof CronRunSchema>;

// Where a cron job's output goes, chosen at create time
// (plan/phases/recipes-gallery.md §1). `none` is today's default (output is
// written to the run-history file and nobody is pinged), `inApp` is the
// in-app heartbeat the deprecated `notifyInApp` boolean expresses, and
// `channel` is the new arm: deliver into a real chat on a real bot.
//
// `botKey` is an AUTHORIZATION input, not a delivery address — the server uses
// it to check that the bot speaks for the job's personality, then discards it.
// `JobOrigin` stays `{ platform, chatId }` (D9).
export const CronDeliverToSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('inApp') }),
  z.object({
    kind: z.literal('channel'),
    platform: z.string().min(1),
    botKey: z.string().min(1),
    chatId: z.string().min(1),
  }),
]);
export type CronDeliverTo = z.infer<typeof CronDeliverToSchema>;

/** How a chat became an offerable delivery target. */
export const CronDeliveryTargetSourceSchema = z.enum([
  /** `channel_filter.<platform>.ownerUserId` — the operator's declared owner. */
  'owner',
  /** An entry in `channel_filter.<platform>.recipientAllowlist`. */
  'allowlist',
  /** A pairing-approved sender from the gateway's pairing DB. */
  'paired',
  /** A chat this bot has actually been talked to in (a gateway lane key). */
  'observed',
]);
export type CronDeliveryTargetSource = z.infer<typeof CronDeliveryTargetSourceSchema>;

export const CronDeliveryTargetSchema = z.object({
  platform: z.string(),
  botKey: z.string(),
  /** `@briefer_bot` where the platform knows one; the botKey otherwise. */
  botLabel: z.string(),
  chatId: z.string(),
  /** Human-readable, best-effort — never the only thing the picker shows. */
  label: z.string(),
  source: CronDeliveryTargetSourceSchema,
});
export type CronDeliveryTarget = z.infer<typeof CronDeliveryTargetSchema>;

// ---------------------------------------------------------------------------
// Skills — learning pillar of v0.5
//
// The Library panel reads `~/.ethos/skills/*.md`. Each file is a markdown
// document with optional OpenClaw frontmatter. The wire schema preserves
// the parsed frontmatter as a record so the editor UI can surface it
// alongside the markdown body without round-tripping through YAML.
// ---------------------------------------------------------------------------

export const SkillSchema = z.object({
  /** Filename minus `.md`. Stable handle the client passes back on update/delete. */
  id: z.string(),
  /** Display name. Pulled from frontmatter `name` if present, otherwise derived from id. */
  name: z.string(),
  /** Frontmatter `description`, or null if absent. */
  description: z.string().nullable(),
  /** Frontmatter as a parsed key-value record. Empty when the file has none. */
  frontmatter: z.record(z.string(), z.unknown()),
  /** Markdown body without the frontmatter block. */
  body: z.string(),
  /** ISO-8601 mtime so the UI can show "edited 2h ago". */
  modifiedAt: z.string(),
  source: z.enum(['system', 'user', 'evolver', 'personality']),
  readonly: z.boolean(),
  /** Gap 11 — non-null when the skill failed an `ethos.requires` gate at load time. */
  unavailableReason: z.string().nullable().optional(),
});
export type Skill = z.infer<typeof SkillSchema>;

/**
 * A skill candidate waiting in the learning inbox, in the shape the Evolver
 * tab's approval queue has always rendered. `id` is the learning candidate id.
 * Approving goes through `LearningInbox.approve` and is refused unless the
 * candidate's replay passed (plan `trust-before-reach.md` Part 4, L-T8);
 * rejecting marks the candidate `rejected`.
 */
export const PendingSkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  body: z.string(),
  /** ISO-8601 of when the candidate file was written. */
  proposedAt: z.string(),
});
export type PendingSkill = z.infer<typeof PendingSkillSchema>;

export const EvolveConfigSchema = z.object({
  rewriteThreshold: z.number().min(0).max(1),
  newSkillPatternThreshold: z.number().min(0).max(1),
  minRunsBeforeEvolve: z.number().int().nonnegative(),
  minPatternCount: z.number().int().nonnegative(),
  autoApprove: z.boolean(),
});
export type EvolveConfigWire = z.infer<typeof EvolveConfigSchema>;

export const EvolverRunSchema = z.object({
  /** ISO-8601 of when the run completed. */
  ranAt: z.string(),
  /** Source eval-output file the run analyzed. */
  evalOutputPath: z.string(),
  rewritesProposed: z.number().int().nonnegative(),
  newSkillsProposed: z.number().int().nonnegative(),
  /** Skipped candidates with their reason from the LLM. */
  skipped: z.array(
    z.object({
      kind: z.enum(['rewrite', 'new']),
      target: z.string(),
      reason: z.string(),
    }),
  ),
});
export type EvolverRun = z.infer<typeof EvolverRunSchema>;

// ---------------------------------------------------------------------------
// Mesh — swarm pillar of v0.5
//
// Surfaces the agent-mesh extension state. Each peer reports its
// capabilities + current load; the route-test endpoint asks the mesh to
// route a synthetic task so the user can verify discovery + delivery
// without sending real work.
// ---------------------------------------------------------------------------

export const MeshAgentSchema = z.object({
  agentId: z.string(),
  /** Capability tokens declared by the peer (e.g. `code`, `web`, `delegate`). */
  capabilities: z.array(z.string()),
  /** Open sessions the peer is currently handling. */
  activeSessions: z.number().int().nonnegative(),
  /** Last heartbeat from this peer (ISO-8601). */
  lastSeenAt: z.string(),
});
export type MeshAgent = z.infer<typeof MeshAgentSchema>;

// ---------------------------------------------------------------------------
// Lab — Batch + Eval (v1)
//
// Both surfaces wrap long-running runners (BatchRunner, EvalRunner)
// from their respective extensions. The wire shape is "submit
// + poll" — start returns a run id, list/get return live state, the
// runner streams progress through `onProgress` callbacks the service
// caches into the run state. Cancel is deferred — the existing
// checkpoint mechanism makes re-runs idempotent.
// ---------------------------------------------------------------------------

export const BatchRunStatusSchema = z.enum(['pending', 'running', 'completed', 'failed']);
export type BatchRunStatus = z.infer<typeof BatchRunStatusSchema>;

export const BatchRunInfoSchema = z.object({
  id: z.string(),
  status: BatchRunStatusSchema,
  total: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  outputPath: z.string(),
  errorMessage: z.string().nullable(),
});
export type BatchRunInfo = z.infer<typeof BatchRunInfoSchema>;

export const EvalScorerSchema = z.enum(['exact', 'contains', 'regex', 'llm']);
export type EvalScorer = z.infer<typeof EvalScorerSchema>;

export const EvalRunInfoSchema = z.object({
  id: z.string(),
  status: BatchRunStatusSchema,
  scorer: EvalScorerSchema,
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  /** 0-1 average score across all tasks. */
  avgScore: z.number().min(0).max(1),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  outputPath: z.string(),
  errorMessage: z.string().nullable(),
});
export type EvalRunInfo = z.infer<typeof EvalRunInfoSchema>;

// ---------------------------------------------------------------------------
// Personality skills — v1
//
// Per-personality skills/*.md files (under
// ~/.ethos/personalities/<id>/skills/). Same shape as the global
// SkillSchema but scoped to one personality. Surfaces under the
// Personalities tab's editor.
// ---------------------------------------------------------------------------

export const PersonalitySkillSchema = z.object({
  /** Filename minus `.md`. */
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  body: z.string(),
  /** ISO-8601 mtime. */
  modifiedAt: z.string(),
});
export type PersonalitySkill = z.infer<typeof PersonalitySkillSchema>;

// ---------------------------------------------------------------------------
// Communications — v1
//
// Per-platform connection state. The web tab edits four platforms by
// writing the same flat keys the gateway already reads from
// ~/.ethos/config.yaml (telegramToken, slackBotToken, …). Sensitive
// values never cross the wire on read; only `configured: boolean` is
// emitted. The setup form posts plaintext on update, then the read
// flips to configured = true.
// ---------------------------------------------------------------------------

export const PlatformIdSchema = z.enum(['telegram', 'discord', 'slack', 'email', 'whatsapp']);
export type PlatformId = z.infer<typeof PlatformIdSchema>;

export const PlatformStatusSchema = z.object({
  id: PlatformIdSchema,
  /** True when every required secret field has a non-empty value. */
  configured: z.boolean(),
  /** Per-field configured-ness so the form can show partial state. */
  fields: z.record(z.string(), z.boolean()),
});
export type PlatformStatus = z.infer<typeof PlatformStatusSchema>;

// ---------------------------------------------------------------------------
// Multi-bot routing — per-entry shapes for telegram.bots[] / slack.apps[]
// ---------------------------------------------------------------------------

export const BotBindingSchema = z.object({
  type: z.enum(['personality', 'team']),
  name: z.string(),
});
export type BotBinding = z.infer<typeof BotBindingSchema>;

export const TelegramBotEntrySchema = z.object({
  /** Stable identifier derived from token sha256 or explicit `id` field. */
  botKey: z.string(),
  /** True when the token is stored in config (tokens never cross the wire). */
  tokenConfigured: z.boolean(),
  username: z.string().optional(),
  bind: BotBindingSchema,
});
export type TelegramBotEntry = z.infer<typeof TelegramBotEntrySchema>;

export const SlackAppEntrySchema = z.object({
  botKey: z.string(),
  botTokenConfigured: z.boolean(),
  appTokenConfigured: z.boolean(),
  signingSecretConfigured: z.boolean(),
  bind: BotBindingSchema,
});
export type SlackAppEntry = z.infer<typeof SlackAppEntrySchema>;

// WhatsApp pairs via QR code, not a config-form token — an entry is routing
// knobs + a `paired` flag derived from whether the Baileys session dir on disk
// holds saved credentials. Saving a bot requires a `bind` (see the
// botsAddWhatsApp router input), but `bind` is optional on the entry so that
// listing a legacy bind-less config doesn't throw.
/**
 * Every mode the WhatsApp adapter's own enum accepts
 * (`extensions/platform-whatsapp/src/config.ts`). `observe` records the room
 * and never replies in it, not even to an @mention.
 *
 * It is spelled out here, and matched against the adapter's list by a test,
 * because the previous two-value version did not fail — it DISPLAYED. An
 * observe-configured bot came back over the wire as `mention_only` and the
 * Platforms table drew a bot that answers mentions, which is the opposite of
 * what the operator configured.
 */
export const WhatsAppChannelModeSchema = z.enum(['all', 'mention_only', 'observe']);
export type WhatsAppChannelMode = z.infer<typeof WhatsAppChannelModeSchema>;

export const WhatsAppEntrySchema = z.object({
  botKey: z.string(),
  defaultMode: WhatsAppChannelModeSchema,
  allowedNumbers: z.array(z.string()),
  /** Phone number this bot links via pairing code, when configured. Absent for
   *  QR-linked bots. Lets the UI show which number is being paired. */
  phoneNumber: z.string().optional(),
  /** True when the Baileys session dir for this bot is non-empty (QR pairing
   *  completed and credentials were persisted). */
  paired: z.boolean(),
  /** Personality/team this bot routes to. Required when saving via
   *  botsAddWhatsApp; optional here so legacy bind-less configs still list. */
  bind: BotBindingSchema.optional(),
});
export type WhatsAppEntry = z.infer<typeof WhatsAppEntrySchema>;

export const ChannelPlatformFilterSchema = z.object({
  enabled: z.boolean(),
  ownerUserId: z.string(),
  allowlist: z.array(z.string()),
});
export type ChannelPlatformFilter = z.infer<typeof ChannelPlatformFilterSchema>;

// ---------------------------------------------------------------------------
// Plugins + MCP — v1
//
// Read-only inventory of what's discoverable on disk. Full install /
// remove flows live in `ethos plugin` CLI for now; the web tab
// surfaces what's loaded so users can see the contract surface their
// agents currently have. MCP server CRUD is similar — `~/.ethos/mcp.json`
// is the editable shape (CLI: `ethos plugin add-mcp`).
// ---------------------------------------------------------------------------

export const PluginSourceSchema = z.enum(['user', 'project', 'npm']);
export type PluginSource = z.infer<typeof PluginSourceSchema>;

/**
 * One safety-scan finding retained from the plugin load. Yellow findings do
 * not block the load — they are surfaced here so the operator can see what
 * the scanner found and why. Red findings block, and appear here alongside
 * the plugin's `error`.
 */
export const PluginScanFindingSchema = z.object({
  severity: z.enum(['red', 'yellow']),
  /** Scanner rule slug, e.g. `network-access`. */
  rule: z.string(),
  message: z.string(),
  /** 1-based line number inside `file`, when the rule matched a line. */
  line: z.number().int().optional(),
  /** The matched source line, trimmed by the scanner. */
  excerpt: z.string().optional(),
  /** Path of the scanned file, relative to the plugin directory. */
  file: z.string().optional(),
});
export type PluginScanFinding = z.infer<typeof PluginScanFindingSchema>;

export const PluginInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string().nullable(),
  /** Where the plugin was discovered. `user` → ~/.ethos/plugins, `project` → .ethos/plugins, `npm` → resolved from node_modules. */
  source: PluginSourceSchema,
  /** Server-side absolute path to the plugin directory (for diagnostics). */
  path: z.string(),
  /** Declared plugin contract major version, or null when the manifest doesn't pin one. */
  pluginContractMajor: z.number().int().nullable(),
  hasHomePanel: z.boolean().optional(),
  /**
   * Live load status from the plugin loader. `null` when this process never
   * tried to activate the plugin — it is on disk, nothing more is known.
   */
  status: z.enum(['loaded', 'failed']).nullable(),
  /** Why the load failed. Null unless `status` is `failed`. */
  error: z.string().nullable(),
  /** Safety-scan findings retained from the load. Omitted when the scan was clean. */
  scanFindings: z.array(PluginScanFindingSchema).optional(),
});
export type PluginInfo = z.infer<typeof PluginInfoSchema>;

export const CredentialKeyInfoSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(['secret', 'text']),
  description: z.string().nullable(),
  refreshHint: z.enum(['daily', 'weekly', 'manual']).nullable(),
  required: z.boolean().nullable(),
  isSet: z.boolean(),
  updatedAt: z.string().nullable(),
});
export type CredentialKeyInfo = z.infer<typeof CredentialKeyInfoSchema>;

export const McpTransportSchema = z.enum(['stdio', 'sse', 'streamable-http']);

export const McpServerInfoSchema = z.object({
  name: z.string(),
  transport: McpTransportSchema,
  /** Stdio: the command. */
  command: z.string().nullable(),
  /** SSE: the endpoint. */
  url: z.string().nullable(),
  auth_status: z.enum(['none', 'authorized', 'expired', 'missing', 'pending']).nullable(),
  created_via: z.enum(['cli', 'ui']).nullable(),
  mcpResultLimitChars: z.number().int().positive().nullable(),
  deprecated: z.boolean().nullable(),
});
export type McpServerInfo = z.infer<typeof McpServerInfoSchema>;

// ---------------------------------------------------------------------------
// MCP install flow — v1
// ---------------------------------------------------------------------------

export const McpStartInputSchema = z.object({
  url: z.string().url(),
  name: z.string().min(1).max(64).optional(),
  personalityId: z.string().min(1).optional(),
});

export const McpStartOutputSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    state: z.string(),
    authorizeUrl: z.string(),
    serverName: z.string(),
  }),
  z.object({
    ok: z.literal(false),
    code: z.enum([
      'discovery_failed',
      'dcr_unsupported',
      'dcr_failed',
      'name_taken',
      'webBaseUrl_missing',
      'ssrf_blocked',
      'invalid_origin',
    ]),
    detail: z.string().optional(),
  }),
]);

export const McpCompleteInputSchema = z.object({
  code: z.string().optional(),
  state: z.string(),
  error: z.string().optional(),
});

export const McpCompleteOutputSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), serverName: z.string() }),
  z.object({
    ok: z.literal(false),
    code: z.enum([
      'missing_pending_cookie',
      'expired_state',
      'state_mismatch',
      'code_exchange_failed',
      'upstream_error',
      'name_taken',
      'addserver_failed',
    ]),
    detail: z.string().optional(),
  }),
]);

export const McpStatusOutputSchema = z.object({
  status: z.enum(['pending', 'connected', 'error', 'expired']),
  serverName: z.string().optional(),
  error: z.string().optional(),
});

export const McpCancelInputSchema = z.object({
  state: z.string(),
});

export const McpAttachInputSchema = z.object({
  serverName: z.string(),
  personalityIds: z.array(z.string()),
});

export const McpAttachOutputSchema = z.object({
  updated: z.array(z.string()),
  failed: z.array(z.object({ id: z.string(), error: z.string() })),
});

export const McpDeleteInputSchema = z.object({
  name: z.string(),
});

export const McpAddServerInputSchema = z.discriminatedUnion('transport', [
  z.object({
    transport: z.literal('streamable-http'),
    name: z.string().min(1).max(64),
    url: z.string().url(),
    authType: z.enum(['bearer', 'none']).optional(),
    token: z.string().min(1).optional(),
    mcpResultLimitChars: z.number().int().positive().optional(),
  }),
  z.object({
    transport: z.literal('sse'),
    name: z.string().min(1).max(64),
    url: z.string().url(),
    authType: z.enum(['bearer', 'none']).optional(),
    token: z.string().min(1).optional(),
    mcpResultLimitChars: z.number().int().positive().optional(),
  }),
  z.object({
    transport: z.literal('stdio'),
    name: z.string().min(1).max(64),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    mcpResultLimitChars: z.number().int().positive().optional(),
  }),
]);

export const McpAddServerOutputSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), serverName: z.string() }),
  z.object({
    ok: z.literal(false),
    code: z.enum(['ssrf_blocked', 'name_taken', 'invalid_url']),
    detail: z.string().optional(),
  }),
]);

export type McpAddServerInput = z.infer<typeof McpAddServerInputSchema>;

export const McpReconnectInputSchema = z.object({
  name: z.string(),
  personalityId: z.string().min(1).optional(),
});

export const McpListOutputSchema = z.object({
  servers: z.array(McpServerInfoSchema),
});

// ---------------------------------------------------------------------------
// MCP per-personality tool policy — mcp.yaml shape, surfaced so the editor
// can initialize the per-server tool checklist from disk. Mirrors
// `McpPolicy` / `McpServerPolicy` in @ethosagent/types. Tool names are BARE
// (no `mcp__<server>__` prefix) — that's what mcp.yaml stores.
// ---------------------------------------------------------------------------

export const McpServerPolicySchema = z.object({
  /** Bare tool names the server may expose. Absent = all tools allowed. */
  tools: z.array(z.string()).optional(),
  reject_args: z.record(z.string(), z.record(z.string(), z.array(z.string()))).optional(),
  enabled: z.boolean().optional(),
});

export const McpPolicySchema = z.object({
  servers: z.record(z.string(), McpServerPolicySchema).optional(),
});
export type McpPolicy = z.infer<typeof McpPolicySchema>;

// MCP server tool discovery — lists the tools a server exposes so the
// editor can render the per-server checklist. `available: false` signals
// the server is unreachable (not connected / no credentials); the UI then
// shows a note instead of an empty checklist.
export const McpServerToolsInputSchema = z.object({
  /** Personality the discovery runs under — OAuth credentials are scoped per personality. */
  personalityId: z.string().min(1),
  serverName: z.string().min(1),
  limit: z.number().int().min(1).max(500).optional(),
  cursor: z.string().optional(),
});

export const McpServerToolsOutputSchema = z.object({
  /** False when the server could not be reached — `tools` will be empty. */
  available: z.boolean(),
  /** Bare tool names (prefix stripped). */
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string().optional(),
    }),
  ),
  nextCursor: z.string().nullable().optional(),
});

// MCP per-personality server listing — returns the servers attached to a
// personality with their OAuth auth status.

export const McpPersonalityServersInputSchema = z.object({
  personalityId: z.string().min(1),
});

export const McpPersonalityServersOutputSchema = z.object({
  servers: z.array(
    z.object({
      name: z.string(),
      transport: z.string().optional(),
      url: z.string().optional(),
      auth_status: z.enum(['authorized', 'expired', 'missing']),
      auth_type: z.enum(['oauth2', 'bearer', 'none']).optional(),
    }),
  ),
});

export const McpRefreshTokenInputSchema = z.object({
  serverName: z.string().min(1),
});
export const McpRefreshTokenOutputSchema = z.object({
  ok: z.boolean(),
  expiresAt: z.string().nullable(),
  error: z.string().optional(),
});

export const McpRenameInputSchema = z.object({
  oldName: z.string().min(1),
  newName: z.string().min(1).max(64),
});
export const McpRenameOutputSchema = z.object({
  ok: z.literal(true),
});

export const McpUpdateTokenInputSchema = z.object({
  serverName: z.string().min(1),
  token: z.string().min(1),
});
export const McpUpdateTokenOutputSchema = z.object({
  ok: z.literal(true),
});

export const McpScopeStatusInputSchema = z.object({
  serverName: z.string().min(1),
});
export const McpScopeStatusOutputSchema = z.object({
  outcome: z.enum(['match', 'mismatch', 'inactive', 'no-introspection', 'error', 'unknown']),
  declaredScopes: z.array(z.string()),
  actualScopes: z.array(z.string()),
  error: z.string().optional(),
});

// ---------------------------------------------------------------------------
// MCP default catalog — the curated preset slate, served over oRPC.
//
// The catalog data itself lives in `@ethosagent/tools-mcp`, a Node-only
// package (stdio transports spawn child processes). `apps/web` must never
// import it, so the catalog crosses the same oRPC boundary every other piece
// of MCP data already crosses. These shapes mirror `McpRemotePreset` /
// `McpPreset` in that package exactly.
// ---------------------------------------------------------------------------

export const McpRemotePresetSchema = z.object({
  name: z.string(),
  label: z.string(),
  url: z.string(),
  transport: z.literal('streamable-http'),
  authType: z.enum(['oauth', 'none', 'bearer']),
  description: z.string(),
  /** Grouping label for the catalog UI, e.g. "Developer tools". */
  category: z.string(),
  docsUrl: z.string().optional(),
});
export type McpRemotePresetInfo = z.infer<typeof McpRemotePresetSchema>;

export const McpLocalPresetSchema = z.object({
  name: z.string(),
  description: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  /** Env vars the preset expects the user to supply. */
  envVars: z.array(z.string()),
  /** Values the user supplies that are appended to `args`, in order. */
  argVars: z.array(z.string()),
  category: z.string(),
});
export type McpLocalPresetInfo = z.infer<typeof McpLocalPresetSchema>;

export const McpCatalogOutputSchema = z.object({
  remote: z.array(McpRemotePresetSchema),
  local: z.array(McpLocalPresetSchema),
});
export type McpCatalogOutput = z.infer<typeof McpCatalogOutputSchema>;

export const McpValidateConfigInputSchema = z.object({
  transport: z.enum(['streamable-http', 'sse', 'stdio']),
  url: z.string().optional(),
  command: z.string().optional(),
  name: z.string().optional(),
});
export const McpValidateConfigOutputSchema = z.object({
  valid: z.boolean(),
  errors: z.array(
    z.object({
      field: z.string(),
      message: z.string(),
    }),
  ),
});

// ---------------------------------------------------------------------------
// Memory — v1
//
// The web tab edits the two markdown files MarkdownFileMemoryProvider
// reads (MEMORY.md and USER.md, always scoped per-personality).
// Vector-mode CRUD lands later — the contract is markdown-shaped for now.
// ---------------------------------------------------------------------------

export const MemoryStoreSchema = z.enum(['memory', 'user']);
export type MemoryStoreId = z.infer<typeof MemoryStoreSchema>;

export const MemoryFileSchema = z.object({
  store: MemoryStoreSchema,
  /** Markdown body. Empty string when the entry doesn't exist yet. */
  content: z.string(),
  /** Backend-local address (file path for the markdown backend; null for
   *  remote / DB / encrypted backends without one). Diagnostic display only. */
  path: z.string().nullable(),
  /** ISO-8601 mtime, or null when the entry doesn't exist. */
  modifiedAt: z.string().nullable(),
});
export type MemoryFile = z.infer<typeof MemoryFileSchema>;

// Provenance history (memory-experience pillar D, §5). One wire entry per
// memory mutation, mirroring the `HistoryEntry` shape the M1 HistoryStore
// records — minus the capture dedup hashes, which are an internal concern.
export const MemoryHistorySourceSchema = z.enum([
  'tool',
  'consolidation',
  'dream',
  'capture',
  'web-editor',
  'global-entry',
  'restore',
]);
export type MemoryHistorySource = z.infer<typeof MemoryHistorySourceSchema>;

export const MemoryHistoryEntrySchema = z.object({
  /** epoch-ms of the mutation. */
  ts: z.number(),
  scopeId: z.string(),
  key: z.string(),
  /** The `MemoryUpdate.action`s applied to this key in the batch. */
  actions: z.array(z.string()),
  source: MemoryHistorySourceSchema,
  sessionId: z.string(),
  sessionKey: z.string(),
  beforeHash: z.string(),
  afterHash: z.string(),
  /** Unified diff (before → after), inline-capped; truncated when `blob` is set. */
  diff: z.string(),
  /** Candidate importance in [0,1] — present on `capture` entries only. */
  hint: z.number().optional(),
  /** Content-address of the full before-state blob (§2.1). When set, `diff` is
   *  truncated and the full before-content is fetched via `memory.historyBlob`. */
  blob: z.string().optional(),
  sizeBefore: z.number(),
  sizeAfter: z.number(),
});
export type MemoryHistoryEntry = z.infer<typeof MemoryHistoryEntrySchema>;

// Approve-before-store pending queue (memory-lifecycle L3, §3b). One parked
// candidate write awaiting an approve/reject decision — the wire projection of
// `PendingEntry` from `@ethosagent/memory-approval`. The capture dedup fact-hash
// is carried so the queue can render provenance, but is otherwise a server-side
// tombstone key.
export const MemoryUpdateSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add'), key: z.string(), content: z.string() }),
  z.object({ action: z.literal('replace'), key: z.string(), content: z.string() }),
  z.object({ action: z.literal('remove'), key: z.string(), substringMatch: z.string() }),
  z.object({ action: z.literal('delete'), key: z.string() }),
]);
export type MemoryUpdateWire = z.infer<typeof MemoryUpdateSchema>;

export const PendingMemorySchema = z.object({
  /** Opaque queue id (uuid). */
  id: z.string(),
  /** Memory scope the write targets (`personality:<id>` / `team:<id>` / …). */
  scopeId: z.string(),
  /** The single candidate mutation, replayed verbatim on approve. */
  update: MemoryUpdateSchema,
  /** Original writer, so approve records honest provenance. */
  source: MemoryHistorySourceSchema,
  /** Normalized fact-hash for a capture candidate (tombstone key on reject). */
  factHash: z.string().optional(),
  /** Session the candidate originated in. */
  sessionId: z.string().optional(),
  sessionKey: z.string().optional(),
  /** epoch-ms the candidate was queued. */
  proposedAt: z.number(),
});
export type PendingMemory = z.infer<typeof PendingMemorySchema>;

export const IdentityMapEntrySchema = z.object({
  userId: z.string(),
  displayLabel: z.string(),
  platform: z.string(),
  firstSeenAt: z.string(),
});
export type IdentityMapEntryWire = z.infer<typeof IdentityMapEntrySchema>;

export const MeshRouteResultSchema = z.object({
  ok: z.boolean(),
  /** Agent the mesh selected for the synthetic task, or null when no peer
   *  could handle the requested capability. */
  routedTo: z.string().nullable(),
  /** Optional human-readable explanation (e.g. "no peer offers `code`"). */
  reason: z.string().nullable(),
});
export type MeshRouteResult = z.infer<typeof MeshRouteResultSchema>;

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

// ---------------------------------------------------------------------------
// API Keys — Control-Plane SDK auth
//
// Metadata returned by the admin namespace. The plaintext secret is only
// returned on create; subsequent reads never expose it.
// ---------------------------------------------------------------------------

// Two scopes read as "chat" and they are NOT interchangeable:
//
//   `chat`      gates the whole OpenAI-compatible `/v1/*` surface
//               (`/v1/models`, `/v1/chat/completions`). Asserted by
//               `bearerAuth` at the `/v1` mount in
//               apps/web-api/src/routes/openai/index.ts.
//   `chat:send` gates the `chat.send` / `chat.abort` RPC procedures on the
//               browser-facing `/rpc/*` surface, via SCOPE_MAP in
//               apps/web-api/src/middleware/dual-auth.ts.
//
// A key needs `chat` to drive Cursor/Aider/the OpenAI SDKs, and `chat:send` to
// drive a Mission Control built on `@ethosagent/sdk`. Neither implies the other.
// `cron` gates the whole `POST /cron/fire` route (apps/web-api/src/routes/cron.ts)
// the same way `chat` gates the whole `/v1/*` surface — a plain bearer-checked
// route, not an RPC method, so it has no SCOPE_MAP entry (dual-auth.ts's
// SCOPE_MAP is keyed by oRPC path and only applies to `/rpc/*`/`/sse/*`).
//
// The fixed vocabulary. Every surface-gating scope is a member here; only the
// `mcp:<id>` family below is open-ended. Kept as its own exported enum because
// `.options` — the enumerable list — is what the CLI prints as "valid scopes"
// and what the SCOPE_MAP drift test enumerates. A union has no such list.
export const ApiKeyStaticScopeSchema = z.enum([
  'sessions:read',
  'sessions:write',
  'chat',
  'chat:send',
  'personalities:read',
  'memory:read',
  'memory:write',
  'tools:approve',
  'events:subscribe',
  'metrics:read',
  'cron',
]);
export type ApiKeyStaticScope = z.infer<typeof ApiKeyStaticScopeSchema>;

// `mcp:<personality-id>` — one key, one exported personality. The id half is
// SAFE_ID_REGEX, COPIED from `packages/types/src/id-validation.ts`: this
// package is a zero-dependency contract package and cannot import
// `@ethosagent/types` (ARCHITECTURE.md Law 1, dependency direction), so the
// pattern is duplicated on purpose rather than shared. The two copies MUST
// change together — same arrangement as the symlink walk duplicated between
// `packages/core/src/scoped/scoped-fs.ts` and
// `packages/storage-fs/src/scoped-storage.ts`, and for the same reason.
//
// The charset is the point, not decoration: the id names a personality that a
// host resolves, so `mcp:../x` must never parse.
const MCP_EXPORT_SCOPE_REGEX = /^mcp:[a-z0-9][a-z0-9_-]*$/;
export const McpExportScopeSchema = z
  .string()
  .regex(MCP_EXPORT_SCOPE_REGEX, 'must look like `mcp:<personality-id>`');

// The scope vocabulary as a whole: the fixed enum, or one `mcp:<id>`.
//
// `z.infer` widens this union to `string` — a regex-refined `z.string()` has
// no narrower static type, as everywhere else in this file. `ApiKeyScopeSchema`
// is therefore the gate; the TYPE is not. Anything validating a scope must
// parse it, not merely annotate it. Use `ApiKeyStaticScope` where only a fixed
// member is admissible (e.g. a default).
export const ApiKeyScopeSchema = z.union([ApiKeyStaticScopeSchema, McpExportScopeSchema]);
export type ApiKeyScope = z.infer<typeof ApiKeyScopeSchema>;

export const ApiKeyMetadataSchema = z.object({
  id: z.string(),
  prefix: z.string(),
  name: z.string(),
  scopes: z.array(ApiKeyScopeSchema),
  allowedOrigins: z.array(z.string()),
  createdAt: z.string(), // ISO-8601
  lastUsed: z.string().nullable(), // ISO-8601
  revokedAt: z.string().nullable(), // ISO-8601
});
export type ApiKeyMetadata = z.infer<typeof ApiKeyMetadataSchema>;

// ---------------------------------------------------------------------------
// MCP export — the personality detail page's export section (M-T9,
// plan/phases/trust-before-reach.md Part 3). Read-only: the declaration lives
// in the personality's config.yaml and the schema is frozen.
//
// NO SECRET crosses this shape. `personalities.mcpExport` is reachable by a
// bearer key carrying `personalities:read`, so a client is its key PREFIX and
// label only, and the Desktop entry carries a placeholder where the secret
// goes — the web substitutes the secret from the `apiKeys.create` response,
// which is cookie-only and happens in the operator's own browser.
// ---------------------------------------------------------------------------

/** The resolved slice — `resolveMcpExportScope` (`packages/wiring/src/mcp-export.ts`), minus `exclude`. */
export const McpExportScopeViewSchema = z.object({
  allowed: z.array(z.string()),
  /** Named by `expose_tools` but outside the personality's reach — shown, never silently omitted. */
  dropped: z.array(z.string()),
  memory: z.enum(['none', 'scoped', 'full']),
  sessions: z.boolean(),
  auth: z.enum(['localhost', 'bearer']),
});
export type McpExportScopeViewWire = z.infer<typeof McpExportScopeViewSchema>;

/** An API key whose scopes include `mcp:<id>` exactly. Prefix only. */
export const McpExportClientSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  createdAt: z.string(), // ISO-8601
  lastUsed: z.string().nullable(), // ISO-8601
});
export type McpExportClientWire = z.infer<typeof McpExportClientSchema>;

/** One `platform = mcp` session of this personality. */
export const McpExportCallSchema = z.object({
  sessionId: z.string(),
  updatedAt: z.string(), // ISO-8601
  /** `key-<prefix>` / `stdio-<name>` — the segment of `mcp:<id>:<client>:<conversation>`. */
  clientId: z.string(),
  /** The API key's label when `clientId` names a known key; null otherwise. */
  clientName: z.string().nullable(),
  title: z.string().nullable(),
  costUsd: z.number(),
});
export type McpExportCallWire = z.infer<typeof McpExportCallSchema>;

/** One `mcp.export.*` event with `decision: denied`. Metadata only — a reason code, never a body. */
export const McpExportDenialSchema = z.object({
  ts: z.string(), // ISO-8601
  kind: z.enum(['auth', 'discovery', 'call']),
  /** The wire event: `initialize`, `ask`, `http-request`, … */
  event: z.string(),
  /** `key-<prefix>`, `stdio-<name>`, or `-` when the caller never identified. */
  clientId: z.string(),
  clientName: z.string().nullable(),
  reason: z.string(),
});
export type McpExportDenialWire = z.infer<typeof McpExportDenialSchema>;

/**
 * The Claude Desktop config the CLI's `ethos mcp install claude-desktop
 * --personality <id>` would write into an empty config — produced server-side
 * by the same entry builder and the same client adapter, so the two surfaces
 * cannot disagree about its shape.
 */
export const McpExportDesktopEntrySchema = z.object({
  /** `ethos-<id>`. */
  name: z.string(),
  /** Serialised config. Under `auth: bearer` it contains `secretPlaceholder` as a JSON string. */
  json: z.string(),
  /** The token to replace with the minted secret; null when the entry carries no key. */
  secretPlaceholder: z.string().nullable(),
});
export type McpExportDesktopEntryWire = z.infer<typeof McpExportDesktopEntrySchema>;

export const McpExportViewSchema = z.object({
  personalityId: z.string(),
  /** `mcp_export.enabled === true`, literally. */
  exported: z.boolean(),
  /** Null when this server could not resolve the slice (no live tool registry). */
  scope: McpExportScopeViewSchema.nullable(),
  /** The `mcp_export.*` keys the declaration is edited through. */
  declarationKeys: z.array(z.string()),
  /** Where the declaration lives, `~`-abbreviated. */
  configPath: z.string(),
  /** `ethos mcp serve --personality <id>`. */
  command: z.string(),
  /** Null when this server has no entry builder wired, or the slice is unresolved. */
  desktopEntry: McpExportDesktopEntrySchema.nullable(),
  clients: z.array(McpExportClientSchema),
  /** Newest first, at most 20. */
  calls: z.array(McpExportCallSchema),
  /** Newest first, at most 20. */
  denials: z.array(McpExportDenialSchema),
});
export type McpExportViewWire = z.infer<typeof McpExportViewSchema>;

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

// ---------------------------------------------------------------------------
// A2A peering (admin surface)
//
// Wire mirrors of `A2aPeerRow` / `A2aIdentityView` from `@ethosagent/wiring`.
// The A2A admin RPC (`a2a.*`) rides the same cookie/bearer `/rpc` auth as the
// other management namespaces — distinct from the peer-facing `/a2a` endpoints.
// `access` is the literal `'full'` in v1 (scope `['*']`, plan §2a).
// ---------------------------------------------------------------------------

export const A2aPeerRowSchema = z.object({
  fingerprint: z.string(),
  /** Local display name (from the allowlist entry). */
  label: z.string().optional(),
  /** The peer's self-reported name (from the peer store card). */
  cardName: z.string().optional(),
  /** The peer's well-known URL (from the allowlist entry). */
  url: z.string().optional(),
  /** v1 always full access, bounded by the owner's exposed skills. */
  access: z.literal('full'),
  enabled: z.boolean(),
  /** ms epoch of the last inbound authenticated interaction; absent → never. */
  lastSeenAt: z.number().optional(),
});
export type A2aPeerRowWire = z.infer<typeof A2aPeerRowSchema>;

export const A2aIdentityViewSchema = z.object({
  personalityId: z.string(),
  name: z.string(),
  fingerprint: z.string(),
  wellKnownUrl: z.string(),
  jsonRpcUrl: z.string(),
  authUrl: z.string(),
  did: z.string().optional(),
  exposedSkills: z.array(z.string()),
});
export type A2aIdentityViewWire = z.infer<typeof A2aIdentityViewSchema>;

// ---------------------------------------------------------------------------
// Keys — the canonical category list
//
// THE single definition of the Keys-pane categories, in display order. It lives
// here because it is the one thing both sides of the wire must agree on, and
// both already import this package: `apps/web-api` (the catalog's `KeyCategory`
// and the order `KeysService.list()` emits) and `apps/web` (the settings
// taxonomy, the settings index, and the pane's own headings). Adding or
// renaming a category is a one-line edit here; everything else derives.
// ---------------------------------------------------------------------------

export const KEY_CATEGORY_IDS = [
  'tools',
  'voice',
  'gateway',
  'settings',
  'connections',
  'custom',
] as const;

export type KeyCategoryId = (typeof KEY_CATEGORY_IDS)[number];

export const KeyCategorySchema = z.enum(KEY_CATEGORY_IDS);

// ---------------------------------------------------------------------------
// Recipes — one-click use-case bundles (plan/phases/recipes-gallery.md §2/§4)
//
// The bundle data and its authoring schema live in `@ethosagent/recipes`, an
// extension. These shapes MIRROR `RecipeBundleSchema` there, the same way
// `McpRemotePresetSchema` mirrors `McpRemotePreset` in `@ethosagent/tools-mcp`:
// this package is imported by the browser and sits below the extensions layer,
// so it describes the wire and imports nothing. The mirror is kept honest by a
// test that parses every shipped bundle through these schemas
// (`apps/web-api/src/__tests__/services/recipes.test.ts`).
// ---------------------------------------------------------------------------

/** What a recipe still needs from the user before it can be installed. */
export const RecipeInputKindSchema = z.enum([
  'text',
  'secret',
  'path',
  'choice',
  'cron',
  'chatTarget',
]);
export type RecipeInputKind = z.infer<typeof RecipeInputKindSchema>;

export const RecipeInputSchema = z.object({
  key: z.string(),
  label: z.string(),
  kind: RecipeInputKindSchema,
  required: z.boolean(),
  default: z.string().optional(),
  placeholder: z.string().optional(),
  options: z.array(z.string()).optional(),
  help: z.string(),
});

const RecipeModelTierSchema = z.object({
  trivial: z.string().optional(),
  default: z.string().optional(),
  deep: z.string().optional(),
  dreaming: z.string().optional(),
});

const RecipeFsReachSchema = z.object({
  read: z.array(z.string()).optional(),
  write: z.array(z.string()).optional(),
  workdir: z.union([z.string(), z.array(z.string())]).optional(),
});

/**
 * The SHAPE of a provider namespace a named secret may be written under —
 * never the roster itself. Which providers exist is DERIVED from the
 * `providers/<segment>/*` prefixes registered tools declare in
 * `capabilities.secrets` (`deriveProviderRoster`,
 * `apps/web-api/src/services/derive-provider-roster.ts`), so a tool — including
 * a plugin's — brings its own credential surface with it and this package holds
 * no list to go stale (plan/phases/tool-credential-surface.md D1).
 *
 * The wire therefore asserts only that the value is a single safe path segment,
 * matching `SECRET_NAME_RE`. `NamedSecretsService.assertProvider` is what
 * refuses an unknown one, with the derived roster in the message. Defined here
 * rather than in `router.ts` because two namespaces need it: `namedSecrets`,
 * which owns the write, and `recipes.preflight`, whose credential rows name the
 * provider that write would target.
 */
export const NamedSecretProviderNameSchema = z.string().regex(SECRET_NAME_RE);

/** Mirrors the bundle's `safety.network` — declared reach, not a new capability. */
const RecipeNetworkPolicySchema = z.object({
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
  allow_private_urls: z.boolean().optional(),
});

/** The create-side fields — the recipe writes a new personality. */
const RecipeCreateFields = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  /** May still contain `{{input.*}}` — this is the bundle, not the install. */
  soulMd: z.string(),
  model: z.union([z.string(), RecipeModelTierSchema]).optional(),
  provider: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  toolset: z.array(z.string()),
  mcpServers: z.array(z.string()).optional(),
  plugins: z.array(z.string()).optional(),
  fsReach: RecipeFsReachSchema.optional(),
  /**
   * Declared network reach. ABSENT means the installer applies `allow: ['*']`
   * (recipes-gallery D15) — absent is not "no policy", it is an empty allowlist
   * that denies every host.
   */
  safety: z.object({ network: RecipeNetworkPolicySchema }).optional(),
});

/**
 * The attach-side fields — the recipe installs ONTO an existing personality,
 * chosen at install time as `personalityIdOverride`. Additive only: a marked
 * SOUL section, tools unioned into the toolset, reach entries appended. No id,
 * name, model or network policy — those stay the target's.
 */
const RecipeAttachFields = z.object({
  /** May still contain `{{input.*}}`. */
  soulSection: z.string(),
  toolset: z.array(z.string()),
  mcpServers: z.array(z.string()).optional(),
  plugins: z.array(z.string()).optional(),
  fsReach: z
    .object({ read: z.array(z.string()).optional(), write: z.array(z.string()).optional() })
    .optional(),
});

/**
 * Three modes. `create` and `attach` are one view each; `both` carries the
 * create view at the top level and the attach view under `attach`, and the
 * install picks one with `installMode` (default `create`).
 */
export const RecipePersonalitySchema = z.discriminatedUnion('mode', [
  RecipeCreateFields.extend({ mode: z.literal('create') }),
  RecipeAttachFields.extend({ mode: z.literal('attach') }),
  RecipeCreateFields.extend({ mode: z.literal('both'), attach: RecipeAttachFields }),
]);

/** Which view of a `both` recipe an install runs. Ignored for single-mode recipes. */
export const RecipeInstallModeSchema = z.enum(['create', 'attach']);
export type RecipeInstallMode = z.infer<typeof RecipeInstallModeSchema>;

export const RecipeRequirementsSchema = z.object({
  mcpServers: z.array(
    z.object({
      name: z.string(),
      catalogId: z.string().optional(),
      transport: z.enum(['stdio', 'streamable-http', 'sse']),
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      url: z.string().optional(),
      envKeys: z.array(z.string()).optional(),
      auth: z.enum(['none', 'env', 'oauth']),
      why: z.string(),
    }),
  ),
  plugins: z.array(z.object({ id: z.string(), packageName: z.string(), why: z.string() })),
  channels: z.array(
    z.object({
      platform: z.string(),
      why: z.string(),
      deliversCron: z.boolean(),
      /**
       * The recipe page collects this platform's bot credential itself and the
       * install binds the bot to the personality it just created. Without it
       * the "Deliver to" requirement is unsatisfiable: a bot binds to a
       * PERSONALITY, and the personality does not exist until the recipe runs.
       */
      inlineSetup: z.boolean().optional(),
    }),
  ),
  tools: z.array(z.string()),
  /**
   * Credentials the granted tools need before they do anything. `web_search`
   * reports itself available with no key configured (the key may live in Named
   * Secrets, unreachable at filter time), so nothing else in preflight can
   * catch a missing one.
   */
  secrets: z
    .array(z.object({ toolName: z.string(), label: z.string(), why: z.string() }))
    .optional(),
  hostBinaries: z
    .array(z.object({ name: z.string(), why: z.string(), installHint: z.string() }))
    .optional(),
  inputs: z.array(RecipeInputSchema),
});

export const RecipeCronJobSchema = z.object({
  name: z.string(),
  schedule: z.string(),
  prompt: z.string(),
  missedRunPolicy: MissedRunPolicySchema.optional(),
  /** Which `deliverTo` arm this job wants. `channel` needs a target at install. */
  deliverTo: z.enum(['channel', 'inApp', 'none']),
});

export const RecipePostInstallSchema = z.object({
  kind: z.enum(['oauth', 'token', 'restart', 'manual']),
  label: z.string(),
  detail: z.string(),
  href: z.string().optional(),
});

export const RecipeBundleWireSchema = z.object({
  id: z.string(),
  /** Optimistic concurrency on the preview — `install` sends it back. */
  version: z.number().int().positive(),
  title: z.string(),
  summary: z.string(),
  sourceDoc: z.string().optional(),
  tags: z.array(z.string()),
  personality: RecipePersonalitySchema,
  requires: RecipeRequirementsSchema,
  cronJobs: z.array(RecipeCronJobSchema),
  starterPrompt: z.string(),
  examplePrompts: z.array(z.string()),
  notes: z.array(z.string()),
  postInstall: z.array(RecipePostInstallSchema),
});
export type RecipeBundleWire = z.infer<typeof RecipeBundleWireSchema>;

/** One gallery row. Everything the list needs and nothing it does not. */
export const RecipeListItemSchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  title: z.string(),
  summary: z.string(),
  tags: z.array(z.string()),
  sourceDoc: z.string().nullable(),
  /**
   * Attach-mode recipes only: the ids of the personalities whose SOUL.md
   * carries this recipe's marker section — DERIVED on every call, never
   * stored (D8). `null` for a create-mode recipe, whose installed state the
   * gallery derives from whether its bundle's personality id exists.
   */
  attachedTo: z.array(z.string()).nullable(),
});
export type RecipeListItem = z.infer<typeof RecipeListItemSchema>;

export const RecipePreflightSchema = z.object({
  /** Unmet prerequisites. Each carries an action a user can actually perform. */
  blocking: z.array(
    z.object({
      code: z.string(),
      message: z.string(),
      action: z.string(),
      href: z.string().optional(),
    }),
  ),
  /** Required inputs still empty. Shrinks as the user fills the form in. */
  needsInput: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      kind: z.string(),
      help: z.string(),
      suggested: z.string().optional(),
      /**
       * `kind: 'credential'` only — the providers that clear this row, ANY one
       * of which is enough. The page renders the same `SecretPicker` the
       * personality tool-settings form uses: existing keys of `secretKind` are
       * offered for selection, and a new one is created through the vault's own
       * write path. The VALUE never travels on this wire in either direction,
       * exactly as the Telegram bot token is kept off `inputs` (D14).
       */
      credentialOptions: z
        .array(
          z.object({
            /**
             * What a binding names: the provider — narrowed by the caller
             * against the derived provider roster. Left as a plain string here
             * so a tool whose provider roster grows still produces a VALID
             * response (the server simply offers no option for it) rather than
             * one this contract rejects.
             */
            provider: z.string(),
            label: z.string(),
            /**
             * The name the tool resolves under this provider when nothing binds
             * it — `apiKey`. Read off the key store's own ref, so preflight can
             * tell "no binding, but the default key is there" from "unset".
             */
            defaultSecretName: z.string(),
            getKeyUrl: z.string().optional(),
          }),
        )
        .optional(),
      /** `kind: 'credential'` only — the `secretKind` the picker filters by. */
      secretKind: z.string().optional(),
    }),
  ),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
  willCreate: z.object({
    personality: z.object({ id: z.string(), isNew: z.boolean() }),
    cronJobs: z.array(
      z.object({
        name: z.string(),
        schedule: z.string(),
        nextRun: z.string().nullable(),
        exists: z.boolean(),
      }),
    ),
    mcpAttachments: z.array(z.string()),
  }),
  /** The preview (D5) — `renderCharacterSheet` over the proposed config. */
  characterSheet: z.string(),
  /** What the installer cannot do, echoed so the confirm step needs no second call. */
  postInstall: z.array(RecipePostInstallSchema),
});
export type RecipePreflight = z.infer<typeof RecipePreflightSchema>;

/**
 * Stage 6. `ok: false` is an APPLY failure that was compensated — stages 1-4
 * refuse by throwing (`RECIPE_NOT_FOUND` / `RECIPE_INVALID` / `RECIPE_STALE` /
 * `RECIPE_BLOCKED`) because nothing was attempted and an all-empty report
 * would say less than the error does.
 */
export const RecipeInstallReportSchema = z.object({
  ok: z.boolean(),
  created: z.object({
    /**
     * The personality this install WROTE: the one it created (create mode) or
     * the one it attached its section to (attach mode). Null when nothing was
     * written — a re-install that skipped it, or a rolled-back failure.
     */
    personality: z.string().nullable(),
    /** `@briefer_bot` when the install set up the channel bot itself. */
    channelBot: z.string().nullable(),
    cronJobs: z.array(z.string()),
    mcpAttachments: z.array(z.string()),
  }),
  skipped: z.array(z.object({ what: z.string(), because: z.string() })),
  /** Compensating deletes this apply performed, and whether each one worked. */
  rolledBack: z.array(z.object({ what: z.string(), ok: z.boolean() })),
  /** Compensation that itself failed — named, with the page that cleans it up. */
  orphaned: z.array(z.object({ what: z.string(), href: z.string() })),
  /** Why the apply failed. Null on success. */
  failure: z.object({ code: z.string(), message: z.string(), action: z.string() }).nullable(),
  /** The honest-completion checklist (D6) — what is left for the human. */
  remaining: z.array(RecipePostInstallSchema),
  /** Pre-filled into the composer. Never auto-sent. */
  starterPrompt: z.string(),
});
export type RecipeInstallReport = z.infer<typeof RecipeInstallReportSchema>;

/**
 * One chat that has messaged a bot, as a one-shot `getUpdates` found it.
 *
 * R0's invariant is intact: a chat id is resolved by the SERVER and chosen from
 * a list. There is no free-text chat id field anywhere, here or in the UI.
 */
export const RecipeDiscoveredChatSchema = z.object({
  chatId: z.string(),
  /** The group's title, or the sender's name — never a bare id. */
  label: z.string(),
  /** `private` | `group` | `supergroup` | `channel`. */
  kind: z.string(),
});
export type RecipeDiscoveredChat = z.infer<typeof RecipeDiscoveredChatSchema>;

/**
 * `status` is the whole contract here:
 *
 * - `ok` — Telegram answered; `chats` is what has messaged this bot.
 * - `waiting` — the token is good, but nothing has messaged the bot yet. The
 *   user opens Telegram, sends a message, and presses the button again.
 * - `gateway_owns_token` — Telegram answered 409, which means the RUNNING
 *   GATEWAY is long-polling this token. Not an error: the gateway's own pairing
 *   store and lane keys already know the chat, so the page falls back to
 *   `cron.deliveryTargets` and says so.
 * - `rejected` / `unreachable` — the token was refused, or Telegram could not
 *   be reached. `error` is one line for a human and NEVER contains the token.
 */
export const RecipeDiscoverChatsOutputSchema = z.object({
  status: z.enum(['ok', 'waiting', 'gateway_owns_token', 'rejected', 'unreachable']),
  /** `@botname`, echoed back so the user can confirm they pasted the right token. */
  botLabel: z.string().nullable(),
  chats: z.array(RecipeDiscoveredChatSchema),
  error: z.string().nullable(),
});
export type RecipeDiscoverChatsOutput = z.infer<typeof RecipeDiscoverChatsOutputSchema>;

/**
 * Inline channel setup, sent with `recipes.install`.
 *
 * The token is a CREDENTIAL and is deliberately NOT a `requires.inputs` entry:
 * inputs are echoed in `needsInput`, cached in the client's preflight query key
 * and re-sent on every keystroke, and substituted into SOUL.md through
 * `{{input.*}}`. A separate field keeps the token off all four paths — it
 * travels once, on the one call that needs it.
 *
 * `chatId` is a `recipes.discoverChats` row the user picked. The install
 * re-reads Telegram to authorize it rather than trusting this value.
 */
export const RecipeChannelSetupSchema = z.object({
  platform: z.literal('telegram'),
  token: z.string().min(1),
  chatId: z.string().min(1),
});
export type RecipeChannelSetup = z.infer<typeof RecipeChannelSetupSchema>;

/**
 * Which named secret a credential requirement is answered with, keyed by the
 * `requires.secrets[].toolName` it answers. Sent with `recipes.preflight` (so
 * the row clears live) and with `recipes.install` (which writes it onto the
 * personality's tool settings as `providers/<provider>/<secret>`).
 *
 * A REFERENCE, never a credential: `secret` is a vault NAME. The value is
 * written by `namedSecrets.create` — the store that owns it — and never enters
 * a recipe input, a preflight report, an install call or an error.
 */
export const RecipeSecretBindingsSchema = z.record(
  z.string(),
  z.object({ provider: z.string().min(1), secret: z.string().min(1) }),
);
export type RecipeSecretBindings = z.infer<typeof RecipeSecretBindingsSchema>;

// ---------------------------------------------------------------------------
// Outbox — the personality approval queue (plan `trust-before-reach.md` Part 2)
//
// A gated `send_message` does not send: it queues a publication here, and a
// human approves exactly one revision of one text to one destination before the
// gateway dispatcher hands it to the delivery ledger.
//
// These are WIRE shapes for that queue, deliberately named `…View`: the
// authoritative types live in `@ethosagent/outbox` (`OutboxItem`,
// `OutboxRevision`, `ReviewReceipt`), and the two must not share a name in a
// file that imports both. Optional fields cross the wire as `null` rather than
// absent, matching `DeliveryObligationSchema` above.
//
// Epoch milliseconds, not ISO strings — same reason the deliveries namespace
// uses them: these are ledger-adjacent timestamps compared against fixed
// windows (7-day expiry, 24h approval validity), never rendered as calendar
// dates by the server.
// ---------------------------------------------------------------------------

/**
 * The item lifecycle. This enum is the wire half of `OutboxState` in
 * `@ethosagent/outbox`, and the two are pinned to each other by the COMPILER,
 * in both directions, at `apps/web-api/src/services/outbox.service.ts`:
 * `ALL_STATES` feeds `options` into `listByState` (so a value here that the
 * store does not know fails to typecheck), and `toView` assigns the store's
 * `item.state` into this enum (so a state the store gained and this did not
 * fails to typecheck). Adding a state to one without the other does not build.
 */
export const OutboxStateSchema = z.enum([
  'awaiting_review',
  'awaiting_approval',
  'approved',
  'sending',
  'sent',
  'unconfirmed',
  'failed',
  'rejected',
  'expired',
]);

/** The advisory reviewer's receipt. Never blocks and never approves (O-D4). */
export const OutboxReviewReceiptViewSchema = z.object({
  verdict: z.enum(['pass', 'fail', 'unclear', 'unavailable']),
  reasons: z.string(),
  /** The revision the reviewer actually read — a later human edit does not
   *  re-run the review, so the receipt keeps this number. */
  revision: z.number().int().positive(),
  reviewedAt: z.number(),
});
export type OutboxReviewReceiptView = z.infer<typeof OutboxReviewReceiptViewSchema>;

/** One immutable revision of the text. */
export const OutboxRevisionViewSchema = z.object({
  revision: z.number().int().positive(),
  text: z.string(),
  contentHash: z.string(),
  /** `agent` for the proposal, otherwise the id of the human who edited. */
  author: z.string(),
  createdAt: z.number(),
});
export type OutboxRevisionView = z.infer<typeof OutboxRevisionViewSchema>;

export const OutboxItemViewSchema = z.object({
  id: z.string(),
  personalityId: z.string(),
  /** The bot that will send. Fixed at propose; a human may edit only the text. */
  botKey: z.string(),
  platform: z.string(),
  chatId: z.string(),
  /** Null for the root chat — a thread is a distinct conversation. */
  threadId: z.string().nullable(),
  revision: z.number().int().positive(),
  /** What `outbox.approve` must carry back for the approval to bind. */
  contentHash: z.string(),
  /**
   * The CURRENT revision's text, byte-exact and NOT truncated — unlike
   * `deliveries.summary`, where the operator is auditing what is owed. Here the
   * whole point is that a human reads the exact bytes that will be published
   * before approving them, so a preview would defeat the feature.
   */
  text: z.string(),
  state: OutboxStateSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  approverPersonality: z.string().nullable(),
  review: OutboxReviewReceiptViewSchema.nullable(),
  /** Who approved, and which revision they approved. Cleared by an edit, a
   *  revoke and a rejection — the approval belongs to a revision. */
  approvedBy: z.string().nullable(),
  approvedAt: z.number().nullable(),
  approvedRevision: z.number().int().positive().nullable(),
  /** When the gateway dispatcher claimed the row. After this, revoke loses. */
  claimedAt: z.number().nullable(),
  sentAt: z.number().nullable(),
  /** Set on `unconfirmed`: the ledger row that owns every retry from then on. */
  obligationId: z.string().nullable(),
  failureReason: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  /** The lane the proposing turn ran in — the UI's "drafted in" line. */
  originSessionKey: z.string().nullable(),
});
export type OutboxItemView = z.infer<typeof OutboxItemViewSchema>;

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
