import { z } from 'zod';
import {
  AuxModelUpdateSchema,
  ConfigRecordKeySchema,
  ModelRegistryAdoptedModelSchema,
  QuickCommandUpdateSchema,
  RetentionDurationSchema,
  RetentionSubkeySchema,
  WebhookUpdateSchema,
} from './_shared';
import {
  VoiceBargeInTuningUpdateSchema,
  VoiceBotUpdateSchema,
  VoiceInboundPrewarmSchema,
  VoiceProviderEntryUpdateSchema,
  VoiceProviderNameRegex,
  VoiceRealtimeProviderEntryUpdateSchema,
  VoiceSttProviderEntryUpdateSchema,
  VoiceTrunkCodecSchema,
  VoiceTrunkProviderSchema,
} from './config-voice';

// For the Settings-page additions below, every scalar accepts `null` meaning
// "delete the config.yaml key and fall back to the built-in default" —
// `undefined`/omitted always means "leave unchanged". Record fields
// (webhooks, quickCommands, channelToolsets, retention, personalityRetention)
// are full replacements: entries absent from the provided record are removed.
export const ConfigUpdateInput = z.object({
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
export const ConfigUpdateOutput = z.object({
  ok: z.literal(true),
  /**
   * Models this save adopted into the registry, in the same config.yaml write:
   * a saved provider row whose `model` had no registry entry for its
   * `(providerKey, modelId)` pair. Absent when nothing was adopted. A row sent
   * with `id: null` / `''` is never adopted (adopting would write its id back).
   */
  adoptedModels: z.array(ModelRegistryAdoptedModelSchema).optional(),
  /**
   * B2 (web save half): the config parser's warnings for the file THIS save
   * just wrote — `config.yaml:<n> unknown key '<k>' — did you mean …?` lines
   * for keys the save kept in passthrough but nothing reads. Absent when the
   * parse raised none. The settings save bar renders the count and the lines.
   */
  warnings: z.array(z.string()).optional(),
});
