import type { EffectiveConfig } from '@ethosagent/config';
import type {
  LogLevelValue,
  RetentionSubkey,
  VOICE_INBOUND_PREWARM_MODES,
  VOICE_TRUNK_CODECS,
  VOICE_TRUNK_PROVIDERS,
} from './constants';
import type {
  AuxModelGetResult,
  QuickCommandGetResult,
  VoiceBargeInTuningResult,
  VoiceBotGetResult,
  VoiceFillerGetResult,
  VoiceProviderGetResult,
  VoiceRealtimeProviderGetResult,
  VoiceSttProviderGetResult,
  WebhookGetResult,
} from './types';

export interface ConfigGetResult {
  provider: string;
  model: string;
  apiKeyPreview: string;
  baseUrl: string | null;
  /**
   * B3 — the effective configuration (`resolveEffectiveConfig` in
   * `@ethosagent/config`, run over the same file this repository reads).
   * Settings → General renders it read-only. Never carries a key value.
   */
  resolved: EffectiveConfig;
  personality: string;
  memory: 'markdown' | 'vector' | 'vault';
  modelRouting: Record<string, string>;
  skin: string;
  providers: Array<{
    provider: string;
    model: string | null;
    apiKeyPreview: string;
    baseUrl: string | null;
    /** `providers.<n>.id`; null when the entry carries none. */
    id: string | null;
    /** `providers.<n>.failover`, absent read as `true` (D23b). */
    failover: boolean;
  }>;
  /** `providerChainVersion` of the stored chain these `providers` came from.
   *  `update` requires it back with any `providers` list. */
  providersVersion: string;
  /** What the provider-chain codec dropped out of config.yaml and why — a
   *  `providers.<n>` index with no `provider` line loses the whole entry. The
   *  CLI surfaces the same notices at boot and in `ethos doctor`. */
  providersNotices: string[];
  approvalMode: 'manual' | 'smart' | 'off';
  verbosity: 'concise' | 'balanced' | 'verbose';
  debugMode: boolean;
  contextLayering: boolean;
  debugPanelEnabled: boolean;
  debugPanelModel: string | null;
  adminEnabled: boolean;
  streamingEdits: 'off' | 'dms' | 'all';
  /** Call Stage treatment (display.call_style): `personality` or a pinned one. */
  callStyle: 'liquid' | 'orb' | 'rings' | 'personality';
  /** In-call overlay color (display.call_accent): `personality` or a hex. */
  callAccent: string;
  autoCompact: boolean;
  memoryConsolidationEnabled: boolean;
  memoryCaptureEnabled: boolean;
  memoryCaptureModel: string | null;
  memoryNotices: boolean;
  voiceChime: boolean;
  voiceEndpointSilenceMs: number;
  voiceBargeThreshold: number;
  voiceBargeSustainMs: number;
  voiceSpeechThreshold: number;
  voiceSpeechMinMs: number;
  voiceProvider: string | null;
  voiceApiKeyPreview: string | null;
  voiceBaseUrl: string | null;
  voiceModel: string | null;
  voiceTtsProvider: string | null;
  voiceTtsApiKeyPreview: string | null;
  voiceTtsVoice: string | null;
  voiceTtsBaseUrl: string | null;
  voiceTtsModel: string | null;
  /** `auxiliary.asr.command` / `auxiliary.tts.command` — the shell templates the
   *  `command-stt` / `command-tts` providers run. */
  voiceSttCommand: string | null;
  voiceTtsCommand: string | null;
  voiceTtsOutputFormat: 'opus' | 'mp3' | 'wav' | 'pcm' | null;
  voiceTtsTimeoutMs: number | null;
  voiceTtsMaxTextLength: number | null;
  voiceSttTimeoutMs: number | null;
  /** `null` = the key is absent = the local-only egress gate is OFF. */
  voiceTrustedPlugins: string[] | null;
  voiceDefaultMode: 'off' | 'mirror_inbound' | 'all' | null;
  /** `voice.channels.<platform>.ttsOut` — an absent platform has no override. */
  voiceChannelTtsOut: Record<string, boolean>;
  voiceTranscodeFfmpegPath: string | null;
  voiceTranscodeBitrateKbps: number | null;
  /** `voice.transcode.timeout`, SECONDS. */
  voiceTranscodeTimeoutSec: number | null;
  voiceArtifactAbandonAfterDays: number | null;
  voiceArtifactMaxTotalMb: number | null;
  // Settings-page additions — see the passthrough-groups comment in constants.ts.
  apiVersion: string | null;
  verbose: boolean;
  displayVerbosity: 'quiet' | 'default' | 'verbose' | 'debug';
  displayBusyInputMode: 'interrupt' | 'queue' | 'steer';
  displayToolPreviewLength: number;
  displayResumeHint: boolean;
  displayResumeRecapTurns: number;
  displayBellOnComplete: boolean;
  compaction: {
    pressure: number | null;
    target: number | null;
    gateDelta: number | null;
    retryOnOverflow: boolean;
    abortOnSummaryFailure: boolean;
    smallWindow: 'auto' | 'on' | 'off';
  };
  memoryVault: {
    path: string | null;
    agentDir: string | null;
    prefetch: string[];
    exclude: string[];
  };
  memoryApproval: {
    mode: 'off' | 'automated' | 'all';
    cap: number;
    ttlDays: number;
  };
  world: {
    enabled: boolean;
    contextMaxChars: number;
    contextHops: 1 | 2;
    extraction: 'off' | 'propose';
    proposals: { cap: number; ttlDays: number };
  };
  memoryConsolidation: {
    halfLifeDays: number;
    threshold: number;
    exemptUser: boolean;
    flushThreshold: number;
    timeboxMs: number;
    maxTokens: number;
    maxDeltaChars: number;
    minMessagesSinceFlush: number;
  };
  memoryCapture: {
    provider: string | null;
    apiKeyPreview: string | null;
    baseUrl: string | null;
    maxPerHour: number;
    maxPerDay: number;
  };
  background: {
    enabled: boolean;
    maxConcurrentJobs: number;
    maxJobsPerRoot: number;
    maxJobsPerPersonality: number;
    defaultMaxCostUsd: number;
    maxRootBackgroundUsd: number;
    queuedTtlMs: number;
    staleMs: number;
    heartbeatMs: number;
    retentionDays: number;
  };
  retention: Partial<Record<RetentionSubkey, string>>;
  personalityRetention: Record<string, Partial<Record<RetentionSubkey, string>>>;
  webhooks: Record<string, WebhookGetResult>;
  quickCommands: Record<string, QuickCommandGetResult>;
  channelToolsets: Record<string, string[]>;
  /** `voice.tts.providers.*` — the named TTS roster. `auxiliary.tts` is the
   *  default entry and lives in the `voiceTts*` fields above, not here. */
  voiceTtsProviders: Record<string, VoiceProviderGetResult>;
  /** `voice.stt.providers.*` — the named STT roster. `auxiliary.asr` is the
   *  default entry and lives in the `voice*` STT fields above, not here. */
  voiceSttProviders: Record<string, VoiceSttProviderGetResult>;
  /** `voice.realtime.providers.*` — the named realtime roster. This one has no
   *  `auxiliary.*` default entry; `voiceRealtimeDefault` names one of these. */
  voiceRealtimeProviders: Record<string, VoiceRealtimeProviderGetResult>;
  /** `voice.realtime.default` — a roster label, never a provider id. */
  voiceRealtimeDefault: string | null;
  /** `voice.tier` — the deployment's default voice engine. */
  voiceTier: 'pipeline' | 'realtime' | null;
  /** `voice.realtime.sessionBudgetUsd` — USD cap on one session. */
  voiceRealtimeSessionBudgetUsd: number | null;
  // -- Telephony (`voice.trunk` / `voice.livekit` / `voice.inbound` /
  //    `voice.bargeIn` / `voice.bots`) ---------------------------------------
  voiceTrunkProvider: (typeof VOICE_TRUNK_PROVIDERS)[number] | null;
  voiceTrunkId: string | null;
  voiceTrunkFromNumber: string | null;
  voiceTrunkUsername: string | null;
  /** REDACTED. The raw password never leaves this layer. */
  voiceTrunkPasswordPreview: string | null;
  /** REDACTED. The raw webhook secret never leaves this layer. */
  voiceTrunkWebhookSecretPreview: string | null;
  voiceTrunkWebhookPath: string | null;
  voiceTrunkCodec: (typeof VOICE_TRUNK_CODECS)[number] | null;
  voiceLivekitUrl: string | null;
  /** REDACTED. */
  voiceLivekitApiKeyPreview: string | null;
  /** REDACTED. */
  voiceLivekitApiSecretPreview: string | null;
  /** Null = key absent = "screen everyone"; an empty list is not expressible
   *  on disk (a flat `key:` line with no value does not parse). */
  voiceInboundAllowlist: string[] | null;
  voiceInboundReceptionist: string | null;
  voiceInboundConcurrencyCap: number | null;
  voiceInboundPerCallerPerHour: number | null;
  voiceInboundDailyBudgetUsd: number | null;
  voiceInboundPrewarm: (typeof VOICE_INBOUND_PREWARM_MODES)[number] | null;
  voiceInboundOwnerPlatform: string | null;
  voiceInboundOwnerChatId: string | null;
  voiceInboundOwnerBotKey: string | null;
  /** Keyed by surface; an absent surface was never tuned. */
  voiceBargeIn: Record<string, VoiceBargeInTuningResult>;
  /** `voice.filler.*` — the tool-call filler/tick keep-alive. Global, not per-surface. */
  voiceFiller: VoiceFillerGetResult;
  voiceBots: VoiceBotGetResult[];
  /** `backup.*` exactly as config.yaml carries it — null / `[]` mean unset,
   *  never "off". The resolved values (and the computed `dir` default) come
   *  from `resolveBackupSettings` via `backup.status`, not from here. */
  backup: {
    enabled: boolean;
    cron: string | null;
    scope: string[];
    keep: number | null;
    dir: string | null;
  };
  nightlyPass: { enabled: boolean; cron: string };
  weeklyDigest: { enabled: boolean; cron: string; recipients: string[] };
  modelCatalog: { enabled: boolean; url: string | null; ttlHours: number };
  logsRotation: { enabled: boolean; maxBytes: number | null; maxFiles: number | null };
  webSearchBackend: 'exa' | 'tavily' | 'brave' | null;
  webExtractBackend: 'htmltext' | null;
  auxCompression: AuxModelGetResult;
  auxVision: AuxModelGetResult;
  auxWeb: AuxModelGetResult;
  a2aEnabled: boolean;
  pluginsAutoInstall: boolean | null;
  webBaseUrl: string | null;
  /** `retention.vacuumAfterPrune`; default false (opt-in). */
  retentionVacuumAfterPrune: boolean;
  /** `retention.minVacuumIntervalDays`; null = no minimum interval. */
  retentionMinVacuumIntervalDays: number | null;
  /** `logs.level`; default 'debug' — the ungated behaviour the tier replaced. */
  logsLevel: LogLevelValue;
  /** `memory.charLimits.*` — markdown backend per-key ceilings. */
  memoryCharLimits: { memory: number; user: number };
  /** `execution.docker.*` — container resource caps; `diskMb` null = no quota. */
  executionDocker: { cpu: number; diskMb: number | null };
  /** `execution.ssh.*` — the single remote target. `host` null = none configured. */
  executionSsh: {
    host: string | null;
    user: string | null;
    port: number | null;
    identityFile: string | null;
    knownHostsFile: string | null;
    strictHostKeys: 'accept-new' | 'yes' | null;
    remoteWorkdir: string | null;
  };
  /** `kanban.*` WIP caps; null = uncapped. */
  kanban: { maxInProgress: number | null; maxInProgressPerProfile: number | null };
  /** `cron.maxParallelJobs`; null = uncapped. */
  cronMaxParallelJobs: number | null;
  /** `toolLoop.*` soft-warn tiers; null = no warn tier. */
  toolLoop: { maxToolCallsWarnAt: number | null; maxIdenticalToolCallsWarnAt: number | null };
  /** `browser.*` — Playwright budgets plus launch posture. */
  browser: {
    navigationTimeoutMs: number;
    commandTimeoutMs: number;
    /** Three-state. `'auto'` is carried verbatim — the session factory, the
     *  only layer that may probe this machine, resolves it. */
    headed: boolean | 'auto';
    idleTimeoutMs: number;
    /** Absent = off. Nothing may read absence as on. */
    stealthEnabled: boolean;
    /** Absent = off, matching the runtime: `buildLaunchOptions` in
     *  `@ethosagent/tools-browser` opens a persistent profile only on an
     *  explicit `=== true`. */
    profilesEnabled: boolean;
    proxyServer: string | null;
    proxyUsername: string | null;
    /** REDACTED. The raw proxy password never leaves this layer. */
    proxyPasswordPreview: string | null;
  };
  /** `web.searxng.url` — self-hosted metasearch endpoint; null = not configured. */
  webSearxngUrl: string | null;
  /** `gateway.maxInboundMediaBytes`; null = each adapter's platform default. */
  gatewayMaxInboundMediaBytes: number | null;
  /** `teamSupervisor.restartLoopGuard.*` — member auto-restart brake. Unset =
   *  5 respawns in 60s, one more than the previous hardcoded guard, which gave
   *  up on the fifth crash and so performed four restarts. */
  teamSupervisorRestartLoopGuard: { maxRestarts: number; windowSeconds: number };
  /** `discord.missedMessageBackfill.*`; `windowSeconds` null = no age bound. */
  discordMissedMessageBackfill: {
    enabled: boolean;
    windowSeconds: number | null;
    limit: number;
  };
}
