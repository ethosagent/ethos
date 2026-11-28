import type { AdoptedModel, CatalogModelLookup } from '@ethosagent/config';
import type { SecretsResolver } from '@ethosagent/types';
import type { ConfigRepository } from '../../repositories/config.repository';
import type {
  LogLevelValue,
  RetentionSubkey,
  VOICE_INBOUND_PREWARM_MODES,
  VOICE_TRUNK_CODECS,
  VOICE_TRUNK_PROVIDERS,
} from './constants';
import type {
  AuxModelUpdateInput,
  QuickCommandUpdateInput,
  VoiceBargeInTuningUpdate,
  VoiceBotUpdateInput,
  VoiceFillerUpdate,
  VoiceProviderUpdateInput,
  VoiceRealtimeProviderUpdateInput,
  VoiceSttProviderUpdateInput,
  WebhookUpdateInput,
} from './types';

/** One provider-chain row as the Settings page sends it. */
export interface ProviderRowInput {
  provider: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  /** `providers.<n>.id`. Omitted keeps the stored entry's id; `null` or `''`
   *  clears it; a string sets it. Checked by `assertProviderIds`. */
  id?: string | null;
  /** `providers.<n>.failover`. Omitted keeps the stored flag; `false` writes
   *  it; `true` removes a stored `false` (absent means true, D23b). */
  failover?: boolean;
  /** Position in `get().providers` (= the repository's chain) the row was
   *  loaded from. Absent for a row added in the editor. */
  sourceIndex?: number;
}

export interface ConfigUpdateInput {
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  personality?: string;
  memory?: 'markdown' | 'vector' | 'vault';
  modelRouting?: Record<string, string>;
  skin?: string;
  /** The whole chain, in order. A row loaded from `get().providers` carries its
   *  position there as `sourceIndex`; see `overlayProviderRow`. */
  providers?: ProviderRowInput[];
  /** `get().providersVersion` the `providers` list was built from. Required
   *  with `providers`; a stale one is refused with `CONFIG_CONFLICT`. */
  providersVersion?: string;
  approvalMode?: 'manual' | 'smart' | 'off';
  verbosity?: 'concise' | 'balanced' | 'verbose';
  debugMode?: boolean;
  contextLayering?: boolean;
  debugPanelEnabled?: boolean;
  debugPanelModel?: string | null;
  adminEnabled?: boolean;
  streamingEdits?: 'off' | 'dms' | 'all';
  callStyle?: 'liquid' | 'orb' | 'rings' | 'personality';
  callAccent?: string;
  autoCompact?: boolean;
  memoryConsolidationEnabled?: boolean;
  memoryCaptureEnabled?: boolean;
  memoryCaptureModel?: string;
  memoryNotices?: boolean;
  voiceChime?: boolean;
  voiceEndpointSilenceMs?: number;
  voiceBargeThreshold?: number;
  voiceBargeSustainMs?: number;
  voiceSpeechThreshold?: number;
  voiceSpeechMinMs?: number;
  voiceProvider?: string;
  voiceApiKey?: string;
  voiceBaseUrl?: string;
  voiceModel?: string;
  voiceTtsProvider?: string;
  voiceTtsApiKey?: string;
  voiceTtsVoice?: string;
  voiceTtsBaseUrl?: string;
  voiceTtsModel?: string;
  voiceSttCommand?: string | null;
  voiceTtsCommand?: string | null;
  voiceTtsOutputFormat?: 'opus' | 'mp3' | 'wav' | 'pcm' | null;
  voiceTtsTimeoutMs?: number | null;
  voiceTtsMaxTextLength?: number | null;
  voiceSttTimeoutMs?: number | null;
  voiceTrustedPlugins?: string[] | null;
  voiceDefaultMode?: 'off' | 'mirror_inbound' | 'all' | null;
  /** `voice.channels.<platform>.ttsOut`. Present REPLACES the whole map — an
   *  omitted platform loses its override and inherits `voice.defaultMode`
   *  again. An unrecognized platform id is refused, not dropped. */
  voiceChannelTtsOut?: Record<string, boolean>;
  /** `voice.transcode.ffmpegPath`; null clears the key. */
  voiceTranscodeFfmpegPath?: string | null;
  /** `voice.transcode.bitrateKbps`, 8–320; null clears the key. */
  voiceTranscodeBitrateKbps?: number | null;
  /** `voice.transcode.timeout`, SECONDS, 1–600; null clears the key. */
  voiceTranscodeTimeoutSec?: number | null;
  /** `voice.artifacts.abandonAfterDays`, 1–365; null clears the key. */
  voiceArtifactAbandonAfterDays?: number | null;
  /** `voice.artifacts.maxTotalMb`, 1–102400; null clears the key. */
  voiceArtifactMaxTotalMb?: number | null;
  /** `voice.tts.providers.*`. Present REPLACES the whole roster — an omitted
   *  entry is a deletion, and its vault key is dropped with it. */
  voiceTtsProviders?: Record<string, VoiceProviderUpdateInput>;
  /** `voice.stt.providers.*`. Same full-replacement rule. */
  voiceSttProviders?: Record<string, VoiceSttProviderUpdateInput>;
  /** `voice.realtime.providers.*`. Same full-replacement rule. */
  voiceRealtimeProviders?: Record<string, VoiceRealtimeProviderUpdateInput>;
  /** `voice.realtime.default`; null clears the key. */
  voiceRealtimeDefault?: string | null;
  /** `voice.tier`; null clears the key. */
  voiceTier?: 'pipeline' | 'realtime' | null;
  /** `voice.realtime.sessionBudgetUsd`; null clears the cap. */
  voiceRealtimeSessionBudgetUsd?: number | null;
  // -- Telephony -------------------------------------------------------------
  // The four secrets are WRITE-ONLY and never echoed back, so a blank or
  // omitted value KEEPS the stored one — the browser only ever saw a preview,
  // and treating blank as "erase" would delete a credential on every unrelated
  // save. `null` clears one.
  //
  // `voiceTrunkProvider: null` drops the whole `voice.trunk.*` block and
  // `voiceLivekitUrl: null` the whole `voice.livekit.*` block (secrets
  // included): the CLI parser needs provider+trunkId and url+apiKey+apiSecret
  // together, so a block that lost its anchor would not load.
  /** `voice.trunk.provider`; null clears the whole trunk block. */
  voiceTrunkProvider?: (typeof VOICE_TRUNK_PROVIDERS)[number] | null;
  voiceTrunkId?: string | null;
  voiceTrunkFromNumber?: string | null;
  voiceTrunkUsername?: string | null;
  /** Write-only; blank keeps the stored secret, null clears it. */
  voiceTrunkPassword?: string | null;
  /** Write-only; blank keeps the stored secret, null clears it. */
  voiceTrunkWebhookSecret?: string | null;
  /** Must start with `/`. */
  voiceTrunkWebhookPath?: string | null;
  voiceTrunkCodec?: (typeof VOICE_TRUNK_CODECS)[number] | null;
  /** `voice.livekit.url`; null clears the whole LiveKit block. */
  voiceLivekitUrl?: string | null;
  /** Write-only; blank keeps, null clears. */
  voiceLivekitApiKey?: string | null;
  /** Write-only; blank keeps, null clears. */
  voiceLivekitApiSecret?: string | null;
  /** Null or an empty list clears the key. */
  voiceInboundAllowlist?: string[] | null;
  voiceInboundReceptionist?: string | null;
  voiceInboundConcurrencyCap?: number | null;
  voiceInboundPerCallerPerHour?: number | null;
  voiceInboundDailyBudgetUsd?: number | null;
  voiceInboundPrewarm?: (typeof VOICE_INBOUND_PREWARM_MODES)[number] | null;
  /** Null clears the whole `voice.inbound.owner.*` block — platform and chatId
   *  are required together. */
  voiceInboundOwnerPlatform?: string | null;
  voiceInboundOwnerChatId?: string | null;
  voiceInboundOwnerBotKey?: string | null;
  /** `voice.bargeIn.*`. Present = REPLACE the whole block; an omitted surface
   *  loses its tuning. An unknown surface is refused, not dropped. */
  voiceBargeIn?: Record<string, VoiceBargeInTuningUpdate>;
  /** `voice.filler.*`. Per-field merge; null clears one key. */
  voiceFiller?: VoiceFillerUpdate;
  /** `voice.bots[]`. Present = REPLACE the whole list, renumbered from 0; a
   *  removed row is a deletion. */
  voiceBots?: VoiceBotUpdateInput[];
  // Settings-page additions. For every scalar below, `null` (or '') deletes
  // the config.yaml key so the built-in default applies again; `undefined`
  // leaves it unchanged. Record fields are full replacements.
  apiVersion?: string | null;
  verbose?: boolean | null;
  displayVerbosity?: 'quiet' | 'default' | 'verbose' | 'debug' | null;
  displayBusyInputMode?: 'interrupt' | 'queue' | 'steer' | null;
  displayToolPreviewLength?: number | null;
  displayResumeHint?: boolean | null;
  displayResumeRecapTurns?: number | null;
  displayBellOnComplete?: boolean | null;
  compaction?: {
    pressure?: number | null;
    target?: number | null;
    gateDelta?: number | null;
    retryOnOverflow?: boolean | null;
    abortOnSummaryFailure?: boolean | null;
    smallWindow?: 'auto' | 'on' | 'off' | null;
  };
  memoryVault?: {
    path?: string | null;
    agentDir?: string | null;
    prefetch?: string[] | null;
    exclude?: string[] | null;
  };
  memoryApproval?: {
    mode?: 'off' | 'automated' | 'all' | null;
    cap?: number | null;
    ttlDays?: number | null;
  };
  world?: {
    enabled?: boolean | null;
    contextMaxChars?: number | null;
    contextHops?: 1 | 2 | null;
    extraction?: 'off' | 'propose' | null;
    proposalsCap?: number | null;
    proposalsTtlDays?: number | null;
  };
  memoryConsolidation?: {
    halfLifeDays?: number | null;
    threshold?: number | null;
    exemptUser?: boolean | null;
    flushThreshold?: number | null;
    timeboxMs?: number | null;
    maxTokens?: number | null;
    maxDeltaChars?: number | null;
    minMessagesSinceFlush?: number | null;
  };
  memoryCapture?: {
    provider?: string | null;
    /** Write-only; never echoed back. */
    apiKey?: string | null;
    baseUrl?: string | null;
    maxPerHour?: number | null;
    maxPerDay?: number | null;
  };
  background?: {
    enabled?: boolean | null;
    maxConcurrentJobs?: number | null;
    maxJobsPerRoot?: number | null;
    maxJobsPerPersonality?: number | null;
    defaultMaxCostUsd?: number | null;
    maxRootBackgroundUsd?: number | null;
    queuedTtlMs?: number | null;
    staleMs?: number | null;
    heartbeatMs?: number | null;
    retentionDays?: number | null;
  };
  retention?: Partial<Record<RetentionSubkey, string>>;
  personalityRetention?: Record<string, Partial<Record<RetentionSubkey, string>>>;
  webhooks?: Record<string, WebhookUpdateInput>;
  quickCommands?: Record<string, QuickCommandUpdateInput>;
  channelToolsets?: Record<string, string[]>;
  /**
   * `voice.wake.routes.<id>` — the wake-phrase → personality table, replaced
   * wholesale (a present key drops every existing route first, like the voice
   * rosters above). A route the operator deleted in the UI must actually stop
   * answering the door, so a merge would be the wrong semantics here.
   */
  wakeRoutes?: Record<
    string,
    { phrase: string; personality: string; privileged?: boolean; enabled?: boolean }
  >;
  backup?: {
    enabled?: boolean | null;
    cron?: string | null;
    scope?: string[] | null;
    keep?: number | null;
    dir?: string | null;
  };
  nightlyPass?: { enabled?: boolean | null; cron?: string | null };
  weeklyDigest?: { enabled?: boolean | null; cron?: string | null; recipients?: string[] | null };
  modelCatalog?: { enabled?: boolean | null; url?: string | null; ttlHours?: number | null };
  logsRotation?: { enabled?: boolean | null; maxBytes?: number | null; maxFiles?: number | null };
  webSearchBackend?: 'exa' | 'tavily' | 'brave' | null;
  webExtractBackend?: 'htmltext' | null;
  auxCompression?: AuxModelUpdateInput;
  auxVision?: AuxModelUpdateInput;
  auxWeb?: AuxModelUpdateInput;
  a2aEnabled?: boolean | null;
  pluginsAutoInstall?: boolean | null;
  webBaseUrl?: string | null;
  retentionVacuumAfterPrune?: boolean | null;
  retentionMinVacuumIntervalDays?: number | null;
  logsLevel?: LogLevelValue | null;
  memoryCharLimits?: { memory?: number | null; user?: number | null };
  executionDocker?: { cpu?: number | null; diskMb?: number | null };
  executionSsh?: {
    host?: string | null;
    user?: string | null;
    port?: number | null;
    identityFile?: string | null;
    knownHostsFile?: string | null;
    strictHostKeys?: 'accept-new' | 'yes' | null;
    remoteWorkdir?: string | null;
  };
  kanban?: { maxInProgress?: number | null; maxInProgressPerProfile?: number | null };
  cronMaxParallelJobs?: number | null;
  toolLoop?: { maxToolCallsWarnAt?: number | null; maxIdenticalToolCallsWarnAt?: number | null };
  /** Per-field merge; null clears one key. `proxyServer: null` is the one
   *  exception — it clears the WHOLE `browser.proxy.*` block, credentials
   *  included, because `@ethosagent/config` refuses boot on credentials with
   *  no server to carry them. */
  browser?: {
    navigationTimeoutMs?: number | null;
    commandTimeoutMs?: number | null;
    headed?: boolean | 'auto' | null;
    idleTimeoutMs?: number | null;
    stealthEnabled?: boolean | null;
    profilesEnabled?: boolean | null;
    proxyServer?: string | null;
    proxyUsername?: string | null;
    /** Write-only; blank keeps the stored secret, null clears the block. */
    proxyPassword?: string | null;
  };
  webSearxngUrl?: string | null;
  gatewayMaxInboundMediaBytes?: number | null;
  teamSupervisorRestartLoopGuard?: { maxRestarts?: number | null; windowSeconds?: number | null };
  discordMissedMessageBackfill?: {
    enabled?: boolean | null;
    windowSeconds?: number | null;
    limit?: number | null;
  };
}

/** What `update` reports beyond "it saved". */
export interface ConfigUpdateResult {
  /** Models adopted into the registry by this save (`adoptChainModelsOnSave`). */
  adoptedModels: AdoptedModel[];
  /**
   * B2 (web save half) — the CLI parser's warnings for the file this save
   * wrote: `config.yaml:<n> unknown key '<k>' — did you mean …?` lines for
   * keys the save kept in passthrough but nothing reads. The settings save
   * bar renders the count and the lines.
   */
  warnings: string[];
}

export interface ConfigServiceOptions {
  config: ConfigRepository;
  /** Resolves `${secrets:ref}` indirection in stored API keys (admin
   *  provider health checks). Optional — when omitted, secret-ref keys
   *  resolve to '' so checks fail honestly instead of probing with the
   *  literal reference string. */
  secrets?: SecretsResolver;
  /**
   * Validates the personality a `voice.bots[]` entry binds to.
   *
   * A seam, not a dependency on the whole service: the only question asked is
   * "does this id exist", and the answer has to come from the registry the
   * gateway will resolve against. Optional because a deployment (or a test)
   * without it still has a working config writer — the check is then skipped,
   * the same way `secrets` degrades.
   */
  personalities?: { exists(id: string): Promise<boolean> };
  /**
   * Fired after a successful `update()` write lands.
   *
   * A seam, not a dependency: this service must not know that wake satellites
   * exist, but a Settings save is the one moment the pushed routing table can
   * change, and eng-review D5 makes that save the trigger for the push. The
   * composition root closes over whatever needs telling. Awaited so a caller
   * that reads back immediately sees the effect, but a listener that throws
   * must not fail the config write that already landed.
   */
  onUpdated?: () => void | Promise<void>;
  /** Catalog facts for a model adopted on save. Absent = the in-process catalog. */
  lookupCatalog?: CatalogModelLookup;
}
