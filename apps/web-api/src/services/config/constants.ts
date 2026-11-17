// ---------------------------------------------------------------------------
// Settings-page passthrough groups
//
// Every field below maps 1:1 onto a flat config.yaml key that has no other UI
// home (channel bots, teams, evolver, and toolSettings are managed by their
// own RPC namespaces). All of them live in the repository's `passthrough`
// map — the repo round-trips unknown keys verbatim, so the service is the
// single place that knows the key names, defaults, and bounds. Bounds mirror
// packages/config's own parse validation; the RPC layer re-enforces them via
// the Zod schemas in @ethosagent/web-contracts.
// ---------------------------------------------------------------------------

/** `retention.<subkey>` / `personalities.<id>.retention.<subkey>` subkeys. */
export type RetentionSubkey =
  | 'messages'
  | 'traces'
  | 'spans'
  | 'blobs'
  | 'archive'
  | 'channelTranscript'
  | 'events.error'
  | 'events.audit'
  | 'events.channel'
  | 'events.install';

export const RETENTION_SUBKEYS: readonly RetentionSubkey[] = [
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
];

/** Duration grammar accepted by extensions/observability-sqlite parseDuration. */
export const RETENTION_DURATION_RE = /^(forever|\d+[dwmy])$/;

/** Record keys serialized as `<prefix>.<key>.<field>` config.yaml lines must
 *  survive the line-based format — same identifier rule as bot ids. */
export const RECORD_KEY_RE = /^[A-Za-z0-9_-]+$/;

/** `logs.level` values, ordered by severity. Mirrors `LOG_LEVELS` in
 *  `@ethosagent/config` (and `LogLevel` in `@ethosagent/types`). */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevelValue = (typeof LOG_LEVELS)[number];

/** The two `StrictHostKeyChecking` values `execution.ssh.strictHostKeys` takes.
 *  Duplicated from `@ethosagent/config` for the reason every other enum in this
 *  file is: this reader parses the raw passthrough map and shares no code with
 *  the CLI loader, so an unrecognised value must read back as "unset" here too
 *  rather than as a string the runtime will not honour. */
export const SSH_STRICT_HOST_KEYS = ['accept-new', 'yes'] as const;

/**
 * The `webhooks.<id>.<field>` leaves `WebhookUpdateInput` models — i.e. the
 * complete set of keys the update path rewrites from the patch.
 *
 * Used as a DENYLIST when carrying a hook's other keys through the
 * wipe-and-rebuild in `update`. Deliberately not an allowlist of the
 * config-file-only fields (`events`, `deliver.<n>.*`, `hmac.*`,
 * `rateLimit.*`): an allowlist has to be extended for every field added to
 * `WebhookHookConfig`, and forgetting silently deletes that field on the next
 * save — which is exactly the bug this set exists to prevent. Naming what this
 * layer owns makes everything it does not own survive by default.
 */
export const WEBHOOK_MODELLED_FIELDS = new Set([
  'personalityId',
  'secret',
  'sessionKey',
  'prefilter',
  'prefilterTimeoutSeconds',
  'mode',
]);

// ---------------------------------------------------------------------------
// Telephony (`voice.trunk` / `voice.livekit` / `voice.inbound` /
// `voice.bargeIn` / `voice.bots`)
//
// All five families are passthrough keys — the repository round-trips them
// verbatim and the CLI's own parser is the one that gives them meaning. What
// this layer adds is redaction (the trunk password, the webhook secret and the
// LiveKit credentials never leave here in the clear) and refusal of values the
// CLI parser would reject, so a bad save is a response the operator sees rather
// than a parse error on the agent's next boot.
// ---------------------------------------------------------------------------

/** The audio surfaces `voice.bargeIn.<surface>` accepts. Mirrors
 *  `VOICE_BARGE_IN_SURFACES` in packages/config — web-api has no dependency on
 *  it, the same precedent as VOICE_TUNING (voice-tuning.ts). `browser` since L1 (plan §7
 *  "Conflict 2"): the browser pipeline lane runs on the same `VoiceSession`
 *  orchestrator as `call`/`satellite` now, and reads the legacy
 *  `display.voice_*` keys (voice-tuning.ts) as a fallback only when
 *  `voice.bargeIn.browser` is not configured — see
 *  `readLegacyBrowserBargeInTuning` (voice-tuning.ts). */
export const VOICE_BARGE_IN_SURFACES = ['call', 'satellite', 'browser'] as const;

export type VoiceBargeInSurface = (typeof VOICE_BARGE_IN_SURFACES)[number];

export const VOICE_TRUNK_PROVIDERS = ['twilio', 'telnyx', 'generic', 'livekit'] as const;
export const VOICE_TRUNK_CODECS = ['opus', 'g711'] as const;
export const VOICE_INBOUND_PREWARM_MODES = ['allowlisted', 'none', 'all'] as const;

/** The three `voice.livekit.*` keys the CLI parser requires together — a block
 *  missing any one of them is a parse error, not a partial config. */
export const VOICE_LIVEKIT_KEYS = [
  'voice.livekit.url',
  'voice.livekit.apiKey',
  'voice.livekit.apiSecret',
] as const;

/** `voice.trunk.*` update fields. Listed rather than derived so the "did the
 *  operator touch the trunk at all" question has one answer. */
export const TRUNK_PATCH_KEYS = [
  'voiceTrunkProvider',
  'voiceTrunkId',
  'voiceTrunkFromNumber',
  'voiceTrunkUsername',
  'voiceTrunkPassword',
  'voiceTrunkWebhookSecret',
  'voiceTrunkWebhookPath',
  'voiceTrunkCodec',
] as const;

export const LIVEKIT_PATCH_KEYS = [
  'voiceLivekitUrl',
  'voiceLivekitApiKey',
  'voiceLivekitApiSecret',
] as const;

/** Every telephony update field, in one list: it decides whether `update` has
 *  to read the current config back (for secret carry-over and the
 *  required-together checks) and it is spliced into SETTINGS_PATCH_KEYS so none
 *  of these ever reaches the repository's typed patch. */
export const TELEPHONY_PATCH_KEYS = [
  ...TRUNK_PATCH_KEYS,
  ...LIVEKIT_PATCH_KEYS,
  'voiceInboundAllowlist',
  'voiceInboundReceptionist',
  'voiceInboundConcurrencyCap',
  'voiceInboundPerCallerPerHour',
  'voiceInboundDailyBudgetUsd',
  'voiceInboundPrewarm',
  'voiceInboundOwnerPlatform',
  'voiceInboundOwnerChatId',
  'voiceInboundOwnerBotKey',
  'voiceBargeIn',
  'voiceBots',
] as const;

/** ConfigUpdateInput fields handled via passthrough writes — stripped from the
 *  repository patch (the repo only knows its typed RawConfig fields). */
export const SETTINGS_PATCH_KEYS = [
  'apiVersion',
  'verbose',
  'displayVerbosity',
  'displayBusyInputMode',
  'displayToolPreviewLength',
  'displayResumeHint',
  'displayResumeRecapTurns',
  'displayBellOnComplete',
  'compaction',
  'voiceFiller',
  'memoryVault',
  'memoryApproval',
  'memoryConsolidation',
  'memoryCapture',
  'background',
  'retention',
  'personalityRetention',
  'webhooks',
  'quickCommands',
  'channelToolsets',
  'voiceTtsProviders',
  'voiceSttProviders',
  'voiceRealtimeProviders',
  'voiceChannelTtsOut',
  'wakeRoutes',
  'backup',
  'nightlyPass',
  'weeklyDigest',
  'modelCatalog',
  'logsRotation',
  'webSearchBackend',
  'webExtractBackend',
  'webSearxngUrl',
  'auxCompression',
  'auxVision',
  'auxWeb',
  'a2aEnabled',
  'pluginsAutoInstall',
  'webBaseUrl',
  'retentionVacuumAfterPrune',
  'retentionMinVacuumIntervalDays',
  'logsLevel',
  'memoryCharLimits',
  'executionDocker',
  'executionSsh',
  'kanban',
  'cronMaxParallelJobs',
  'toolLoop',
  'browser',
  'gatewayMaxInboundMediaBytes',
  'teamSupervisorRestartLoopGuard',
  'discordMissedMessageBackfill',
  ...TELEPHONY_PATCH_KEYS,
] as const;

// `${secrets:ref}` — same indirection syntax the CLI's config loader
// resolves (apps/ethos/src/config.ts).
export const SECRETS_REF_RE = /\$\{secrets:([^}]+)\}/g;
