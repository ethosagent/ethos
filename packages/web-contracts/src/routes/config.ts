import { oc } from '@orpc/contract';
import { z } from 'zod';
import { ProviderEntrySchema } from '../schemas';
import {
  AuxModelGetSchema,
  QuickCommandGetSchema,
  RetentionDurationSchema,
  RetentionSubkeySchema,
  WebhookGetSchema,
} from './_shared';
import { ConfigUpdateInput, ConfigUpdateOutput } from './config-update';
import {
  VoiceBargeInTuningGetSchema,
  VoiceBotGetSchema,
  VoiceInboundPrewarmSchema,
  VoiceProviderEntryGetSchema,
  VoiceRealtimeProviderEntryGetSchema,
  VoiceSttProviderEntryGetSchema,
  VoiceTrunkCodecSchema,
  VoiceTrunkProviderSchema,
} from './config-voice';

// ---------------------------------------------------------------------------
// Config
//
// Read-only view of the parts of `~/.ethos/config.yaml` the web UI can edit.
// The full file (with raw API keys) never crosses the wire — `apiKey` is
// returned as a redacted preview ("sk-…abc1") so users can confirm which key
// is active without leaking it to the browser.
// ---------------------------------------------------------------------------
/**
 * B3 (plan ux-feedback-and-config-clarity §6.2–6.3) — the `Resolved` block:
 * which configuration is actually in effect, from `resolveEffectiveConfig`
 * in `@ethosagent/config`. Settings → General renders it read-only; the same
 * resolver feeds `ethos status` and `ethos doctor`. `apiKey` carries only the
 * provider and the SOURCE of the key (env var name / vault ref) — never a
 * value or preview.
 */
const ConfigResolvedSchema = z.object({
  /** `ETHOS_STATE_DIR` when set, else `~/.ethos`. */
  stateDir: z.string(),
  configPath: z.string(),
  personality: z.object({
    id: z.string(),
    /** Which key decided it (`default` = neither key set). */
    source: z.enum(['activeContext', 'personality', 'default']),
    /** The `personality:` value an activeContext outranked. */
    shadowed: z.string().optional(),
  }),
  model: z.object({
    id: z.string(),
    /** The config-level rung that decided `id` (`model:` or `modelRouting.<id>`). */
    rung: z.string(),
  }),
  apiKey: z.object({
    provider: z.string(),
    /**
     * `missing` = env unset AND the resolver was handed a vault listing that
     * lacks the ref (see `EffectiveConfig.apiKey.source` in
     * `@ethosagent/config`). web-api resolves without a vault listing today,
     * so it never sends `missing` — the variant is here so the schema mirrors
     * the resolver's enum, additively.
     */
    source: z.enum(['env', 'vault', 'inline', 'missing']),
    /** The vault ref consulted (absent for `inline`). */
    ref: z.string().optional(),
    /** The environment variable that supplied the key (source `env`). */
    envVar: z.string().optional(),
    /** Present when the env var wins AND the vault also holds the ref. */
    overrides: z.literal('vault').optional(),
  }),
  /** Parse-time warnings for the file as it stands (B2 unknown-key lines). */
  warnings: z.array(z.string()),
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
  /** The effective configuration (B3) — see `ConfigResolvedSchema`. */
  resolved: ConfigResolvedSchema,
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
  /** `voice.inbound.allowlist` — caller numbers treated as known for pre-warm.
   *  Caller ID is not identity, so a match never reaches the owner's own
   *  personality (INB-001b, `decideInboundCall`). Null = key absent, which the consumer reads as "screen
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
/** @experimental */
export const config = {
  get: oc.output(ConfigGetOutput),
  update: oc.input(ConfigUpdateInput).output(ConfigUpdateOutput),
};
