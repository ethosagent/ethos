import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import {
  type AdoptedModel,
  type EffectiveConfig,
  fillFromTopLevel,
  parseConfigYaml,
  providerChainVersion,
  resolveEffectiveConfig,
  secretRefFromValue,
} from '@ethosagent/config';
import { EthosError } from '@ethosagent/types';
import { lookupCatalogModel } from '@ethosagent/wiring/model-catalog';
import type { RawConfig, RawProviderEntry } from '../repositories/config.repository';
import {
  LIVEKIT_PATCH_KEYS,
  LOG_LEVELS,
  RETENTION_SUBKEYS,
  type RetentionSubkey,
  SECRETS_REF_RE,
  SETTINGS_PATCH_KEYS,
  SSH_STRICT_HOST_KEYS,
  TELEPHONY_PATCH_KEYS,
  TRUNK_PATCH_KEYS,
  VOICE_BARGE_IN_SURFACES,
  VOICE_INBOUND_PREWARM_MODES,
  VOICE_LIVEKIT_KEYS,
  VOICE_TRUNK_CODECS,
  VOICE_TRUNK_PROVIDERS,
  type VoiceBargeInSurface,
  WEBHOOK_MODELLED_FIELDS,
} from './config/constants';
import type { ConfigGetResult } from './config/get-result';
import {
  auxTimeoutSeconds,
  parseAuxModel,
  parseBrowserHeaded,
  parseCallAccent,
  parseCallStyle,
  parseChannelToolsets,
  parsePersonalityRetention,
  parseQuickCommands,
  parseRetentionMap,
  parseStreamingEdits,
  parseVoiceBargeIn,
  parseVoiceBots,
  parseVoiceChannelTtsOut,
  parseVoiceFiller,
  parseVoiceRealtimeProviders,
  parseVoiceSttProviders,
  parseVoiceTtsProviders,
  parseWebhooks,
  parseWebSearchBackend,
  passBool,
  passBoundedInt,
  passNum,
  passNumOrNull,
  passPositiveNum,
  passStr,
  pickEnum,
  pickEnumOrNull,
  splitList,
} from './config/parse';
import {
  adoptChainModelsOnSave,
  assertProviderIds,
  assertProviderRows,
  chainImportSource,
  claimStoredSources,
  mirrorTopLevel,
  overlayProviderRow,
  providerChainSecretRefs,
  topLevelChainEntry,
  topLevelChainSecretRefs,
} from './config/providers';
import { redactKey } from './config/redact';
import type { AuxModelUpdateInput } from './config/types';
import type {
  ConfigServiceOptions,
  ConfigUpdateInput,
  ConfigUpdateResult,
} from './config/update-input';
import { invalidValue, validateSettingsPatch } from './config/validate';
import {
  readLegacyBrowserBargeInTuning,
  readVoiceTuning,
  VOICE_TUNING,
} from './config/voice-tuning';

export type { ConfigGetResult } from './config/get-result';
export type {
  AuxModelGetResult,
  AuxModelUpdateInput,
  QuickCommandGetResult,
  QuickCommandUpdateInput,
  VoiceBargeInTuningResult,
  VoiceBargeInTuningUpdate,
  VoiceBotGetResult,
  VoiceBotUpdateInput,
  VoiceFillerGetResult,
  VoiceFillerUpdate,
  VoiceProviderGetResult,
  VoiceProviderUpdateInput,
  VoiceRealtimeProviderGetResult,
  VoiceRealtimeProviderUpdateInput,
  VoiceSttProviderGetResult,
  VoiceSttProviderUpdateInput,
  WebhookGetResult,
  WebhookUpdateInput,
} from './config/types';
export type {
  ConfigServiceOptions,
  ConfigUpdateInput,
  ConfigUpdateResult,
  ProviderRowInput,
} from './config/update-input';
export type { RetentionSubkey, VoiceBargeInSurface };
export {
  chainImportSource,
  providerChainSecretRefs,
  readLegacyBrowserBargeInTuning,
  redactKey,
  topLevelChainEntry,
  topLevelChainSecretRefs,
  VOICE_BARGE_IN_SURFACES,
};

// Read/update the parts of `~/.ethos/config.yaml` the web UI exposes. The
// raw API key NEVER leaves this layer — `get` returns a redacted preview
// (`sk-…abc1`) so the UI can show "which key is active" without leaking
// it. `update` accepts a fresh key but does not echo it back.

export class ConfigService {
  constructor(private readonly opts: ConfigServiceOptions) {}

  /**
   * Run the CLI's parser (`parseConfigYaml`) over the same bytes the
   * repository serves and resolve what they select (B2/B3). The repository's
   * own reader keeps unknown keys silently in passthrough BY DESIGN; the CLI
   * parser is the one that records them as warnings, and
   * `resolveEffectiveConfig` reads its output. `ETHOS_STATE_DIR` is pinned to
   * this repository's data dir so the resolved paths describe the file
   * actually served, not whatever the process environment defaults to.
   * `overrides: 'vault'` is never claimed here — that needs a vault listing
   * this service does not perform (see `resolveEffectiveConfig`'s caveats).
   */
  private async resolveEffective(): Promise<EffectiveConfig> {
    const src = (await this.opts.config.readSource()) ?? '';
    return resolveEffectiveConfig(parseConfigYaml(src), {
      ...process.env,
      ETHOS_STATE_DIR: dirname(this.opts.config.configPath),
    });
  }

  async get(): Promise<ConfigGetResult> {
    const raw = await this.opts.config.read();
    if (!raw?.provider) {
      throw new EthosError({
        code: 'CONFIG_MISSING',
        cause: 'Config not found at ~/.ethos/config.yaml',
        action: 'Run onboarding from the web UI or `ethos setup` from the CLI.',
      });
    }
    const p = raw.passthrough;
    const resolved = await this.resolveEffective();
    return {
      provider: raw.provider ?? '',
      model: raw.model ?? '',
      resolved,
      apiKeyPreview: (await this.keyPreview(raw.apiKey)) ?? redactKey(undefined),
      baseUrl: raw.baseUrl ?? null,
      personality: raw.personality ?? 'researcher',
      memory: raw.memory ?? 'markdown',
      modelRouting: raw.modelRouting,
      skin: raw.skin ?? 'default',
      providers: await Promise.all(
        raw.providers.map(async (p) => ({
          provider: p.provider,
          model: p.model ?? null,
          apiKeyPreview: (await this.keyPreview(p.apiKey)) ?? redactKey(undefined),
          baseUrl: p.baseUrl ?? null,
          id: p.id ?? null,
          // Absent in the file means a failover hop (D23b).
          failover: p.failover ?? true,
        })),
      ),
      providersVersion: providerChainVersion(raw.providers),
      providersNotices: raw.providerNotices,
      approvalMode: raw.approvalMode ?? 'manual',
      verbosity: raw.verbosity ?? 'balanced',
      debugMode: raw.debugMode ?? false,
      contextLayering: raw.contextLayering ?? false,
      debugPanelEnabled: raw.debugPanelEnabled ?? false,
      debugPanelModel: raw.debugPanelModel ?? null,
      adminEnabled: raw.passthrough['admin.enabled'] === 'true',
      streamingEdits: parseStreamingEdits(raw.passthrough['display.streaming_edits']),
      callStyle: parseCallStyle(raw.passthrough['display.call_style']),
      callAccent: parseCallAccent(raw.passthrough['display.call_accent']),
      // Default ON since the context-economy Phase 2 flip — off only when
      // explicitly disabled.
      autoCompact: raw.passthrough['compaction.autoCompact'] !== 'false',
      memoryConsolidationEnabled: raw.passthrough['memoryConsolidation.enabled'] === 'true',
      memoryCaptureEnabled: raw.passthrough['memoryCapture.enabled'] === 'true',
      memoryCaptureModel: raw.passthrough['memoryCapture.model'] || null,
      memoryNotices: raw.passthrough['display.memory_notices'] === 'true',
      // Default ON — the talk-mode chime plays unless explicitly disabled.
      voiceChime: raw.passthrough['display.voice_chime'] !== 'false',
      voiceEndpointSilenceMs: readVoiceTuning(
        raw.passthrough,
        'display.voice_endpoint_silence_ms',
        VOICE_TUNING['display.voice_endpoint_silence_ms'].default,
      ),
      voiceBargeThreshold: readVoiceTuning(
        raw.passthrough,
        'display.voice_barge_threshold',
        VOICE_TUNING['display.voice_barge_threshold'].default,
      ),
      voiceBargeSustainMs: readVoiceTuning(
        raw.passthrough,
        'display.voice_barge_sustain_ms',
        VOICE_TUNING['display.voice_barge_sustain_ms'].default,
      ),
      voiceSpeechThreshold: readVoiceTuning(
        raw.passthrough,
        'display.voice_speech_threshold',
        VOICE_TUNING['display.voice_speech_threshold'].default,
      ),
      voiceSpeechMinMs: readVoiceTuning(
        raw.passthrough,
        'display.voice_speech_min_ms',
        VOICE_TUNING['display.voice_speech_min_ms'].default,
      ),
      voiceProvider: raw.voiceProvider ?? null,
      voiceApiKeyPreview: await this.keyPreview(raw.voiceApiKey),
      voiceBaseUrl: raw.voiceBaseUrl ?? null,
      voiceModel: raw.voiceModel ?? null,
      voiceTtsProvider: raw.voiceTtsProvider ?? null,
      voiceTtsApiKeyPreview: await this.keyPreview(raw.voiceTtsApiKey),
      voiceTtsVoice: raw.voiceTtsVoice ?? null,
      voiceTtsBaseUrl: raw.voiceTtsBaseUrl ?? null,
      voiceTtsModel: raw.voiceTtsModel ?? null,
      voiceSttCommand: passStr(p, 'auxiliary.asr.command'),
      voiceTtsCommand: passStr(p, 'auxiliary.tts.command'),
      voiceTtsOutputFormat: pickEnumOrNull(p['auxiliary.tts.outputFormat'], [
        'opus',
        'mp3',
        'wav',
        'pcm',
      ]),
      voiceTtsTimeoutMs: auxTimeoutSeconds(passNumOrNull(p, 'auxiliary.tts.timeout')),
      voiceTtsMaxTextLength: passNumOrNull(p, 'auxiliary.tts.maxTextLength'),
      voiceSttTimeoutMs: auxTimeoutSeconds(passNumOrNull(p, 'auxiliary.asr.timeout')),
      // An absent key = the gate is off, which is NOT the same as an allowlist
      // that happens to be empty.
      voiceTrustedPlugins:
        p['voice.trustedPlugins'] === undefined ? null : splitList(p['voice.trustedPlugins']),
      voiceDefaultMode: pickEnumOrNull(p['voice.defaultMode'], ['off', 'mirror_inbound', 'all']),
      voiceChannelTtsOut: parseVoiceChannelTtsOut(p),
      voiceTranscodeFfmpegPath: passStr(p, 'voice.transcode.ffmpegPath'),
      voiceTranscodeBitrateKbps: passNumOrNull(p, 'voice.transcode.bitrateKbps'),
      voiceTranscodeTimeoutSec: passNumOrNull(p, 'voice.transcode.timeout'),
      voiceArtifactAbandonAfterDays: passNumOrNull(p, 'voice.artifacts.abandonAfterDays'),
      voiceArtifactMaxTotalMb: passNumOrNull(p, 'voice.artifacts.maxTotalMb'),
      voiceRealtimeDefault: passStr(p, 'voice.realtime.default'),
      voiceTier: pickEnumOrNull(p['voice.tier'], ['pipeline', 'realtime']),
      voiceRealtimeSessionBudgetUsd: passNumOrNull(p, 'voice.realtime.sessionBudgetUsd'),
      voiceTrunkProvider: pickEnumOrNull(p['voice.trunk.provider'], VOICE_TRUNK_PROVIDERS),
      voiceTrunkId: passStr(p, 'voice.trunk.trunkId'),
      voiceTrunkFromNumber: passStr(p, 'voice.trunk.fromNumber'),
      voiceTrunkUsername: passStr(p, 'voice.trunk.username'),
      voiceTrunkPasswordPreview: await this.keyPreview(p['voice.trunk.password']),
      voiceTrunkWebhookSecretPreview: await this.keyPreview(p['voice.trunk.webhookSecret']),
      voiceTrunkWebhookPath: passStr(p, 'voice.trunk.webhookPath'),
      voiceTrunkCodec: pickEnumOrNull(p['voice.trunk.codec'], VOICE_TRUNK_CODECS),
      voiceLivekitUrl: passStr(p, 'voice.livekit.url'),
      voiceLivekitApiKeyPreview: await this.keyPreview(p['voice.livekit.apiKey']),
      voiceLivekitApiSecretPreview: await this.keyPreview(p['voice.livekit.apiSecret']),
      // Absent key = no allowlist = "screen everyone", which is NOT the same as
      // an allowlist that happens to be empty (same distinction the
      // `voice.trustedPlugins` read above draws).
      voiceInboundAllowlist:
        p['voice.inbound.allowlist'] === undefined ? null : splitList(p['voice.inbound.allowlist']),
      voiceInboundReceptionist: passStr(p, 'voice.inbound.receptionist'),
      voiceInboundConcurrencyCap: passNumOrNull(p, 'voice.inbound.concurrencyCap'),
      voiceInboundPerCallerPerHour: passNumOrNull(p, 'voice.inbound.perCallerPerHour'),
      voiceInboundDailyBudgetUsd: passNumOrNull(p, 'voice.inbound.dailyBudgetUsd'),
      voiceInboundPrewarm: pickEnumOrNull(p['voice.inbound.prewarm'], VOICE_INBOUND_PREWARM_MODES),
      voiceInboundOwnerPlatform: passStr(p, 'voice.inbound.owner.platform'),
      voiceInboundOwnerChatId: passStr(p, 'voice.inbound.owner.chatId'),
      voiceInboundOwnerBotKey: passStr(p, 'voice.inbound.owner.botKey'),
      voiceBargeIn: parseVoiceBargeIn(p),
      voiceFiller: parseVoiceFiller(p),
      voiceBots: parseVoiceBots(p),
      apiVersion: passStr(p, 'apiVersion'),
      verbose: passBool(p, 'verbose', false),
      displayVerbosity: pickEnum(
        p['display.verbosity'],
        ['quiet', 'default', 'verbose', 'debug'],
        'default',
      ),
      displayBusyInputMode: pickEnum(
        p['display.busy_input_mode'],
        ['interrupt', 'queue', 'steer'],
        'interrupt',
      ),
      displayToolPreviewLength: passNum(p, 'display.tool_preview_length', 0),
      displayResumeHint: passBool(p, 'display.resume_hint', true),
      displayResumeRecapTurns: passNum(p, 'display.resume_recap_turns', 3),
      displayBellOnComplete: passBool(p, 'display.bell_on_complete', false),
      compaction: {
        pressure: passNumOrNull(p, 'compaction.pressure'),
        target: passNumOrNull(p, 'compaction.target'),
        gateDelta: passNumOrNull(p, 'compaction.gateDelta'),
        // Default ON — only an explicit false disables the overflow retry.
        retryOnOverflow: p['compaction.retryOnOverflow'] !== 'false',
        // Default OFF — an emergency-summary failure stays the generic overflow
        // rejection unless the operator asks for the distinct error.
        abortOnSummaryFailure: passBool(p, 'compaction.abortOnSummaryFailure', false),
        smallWindow: pickEnum(p['compaction.smallWindow'], ['auto', 'on', 'off'], 'auto'),
      },
      memoryVault: {
        path: passStr(p, 'memoryVault.path'),
        agentDir: passStr(p, 'memoryVault.agentDir'),
        prefetch: splitList(p['memoryVault.prefetch']),
        exclude: splitList(p['memoryVault.exclude']),
      },
      memoryApproval: {
        mode: pickEnum(p['memoryApproval.mode'], ['off', 'automated', 'all'], 'off'),
        cap: passNum(p, 'memoryApproval.cap', 200),
        ttlDays: passNum(p, 'memoryApproval.ttlDays', 30),
      },
      world: {
        enabled: passBool(p, 'world.enabled', false),
        contextMaxChars: passNum(p, 'world.contextMaxChars', 2400),
        contextHops: p['world.contextHops']?.trim() === '1' ? 1 : 2,
        extraction: pickEnum(p['world.extraction'], ['off', 'propose'], 'off'),
        proposals: {
          cap: passNum(p, 'world.proposals.cap', 500),
          ttlDays: passNum(p, 'world.proposals.ttlDays', 30),
        },
      },
      memoryConsolidation: {
        halfLifeDays: passNum(p, 'memoryConsolidation.halfLifeDays', 30),
        threshold: passNum(p, 'memoryConsolidation.threshold', 0.05),
        // Default ON — USER.md is exempt from decay unless explicitly disabled.
        exemptUser: p['memoryConsolidation.exemptUser'] !== 'false',
        flushThreshold: passNum(p, 'memoryConsolidation.flushThreshold', 0.7),
        timeboxMs: passNum(p, 'memoryConsolidation.timeboxMs', 30_000),
        maxTokens: passNum(p, 'memoryConsolidation.maxTokens', 1024),
        maxDeltaChars: passNum(p, 'memoryConsolidation.maxDeltaChars', 4000),
        minMessagesSinceFlush: passNum(p, 'memoryConsolidation.minMessagesSinceFlush', 8),
      },
      memoryCapture: {
        provider: passStr(p, 'memoryCapture.provider'),
        apiKeyPreview: await this.keyPreview(p['memoryCapture.apiKey']),
        baseUrl: passStr(p, 'memoryCapture.baseUrl'),
        maxPerHour: passNum(p, 'memoryCapture.maxPerHour', 6),
        maxPerDay: passNum(p, 'memoryCapture.maxPerDay', 30),
      },
      // Defaults mirror backgroundDefaults() in packages/config — web-api has
      // no @ethosagent/config dependency, so the values are duplicated here
      // (same precedent as VOICE_TUNING above).
      background: {
        enabled: passBool(p, 'background.enabled', false),
        maxConcurrentJobs: passNum(p, 'background.max_concurrent_jobs', 2),
        maxJobsPerRoot: passNum(p, 'background.max_jobs_per_root', 3),
        maxJobsPerPersonality: passNum(p, 'background.max_jobs_per_personality', 5),
        defaultMaxCostUsd: passNum(p, 'background.default_max_cost_usd', 1),
        maxRootBackgroundUsd: passNum(p, 'background.max_root_background_usd', 5),
        queuedTtlMs: passNum(p, 'background.queued_ttl_ms', 900_000),
        staleMs: passNum(p, 'background.stale_ms', 90_000),
        heartbeatMs: passNum(p, 'background.heartbeat_ms', 30_000),
        retentionDays: passNum(p, 'background.retention_days', 30),
      },
      retention: parseRetentionMap(p, 'retention.'),
      personalityRetention: parsePersonalityRetention(p),
      webhooks: parseWebhooks(p),
      quickCommands: parseQuickCommands(p),
      channelToolsets: parseChannelToolsets(p),
      voiceTtsProviders: await parseVoiceTtsProviders(p, (v) => this.keyPreview(v)),
      voiceSttProviders: await parseVoiceSttProviders(p, (v) => this.keyPreview(v)),
      voiceRealtimeProviders: await parseVoiceRealtimeProviders(p, (v) => this.keyPreview(v)),
      backup: {
        // The one default resolved here, because a Switch has no third state:
        // `backupEnabled()` in `@ethosagent/wiring` reads an absent key as ON.
        // The other four stay raw — their defaults are computed, not literal.
        enabled: passBool(p, 'backup.enabled', true),
        cron: passStr(p, 'backup.cron'),
        scope: splitList(p['backup.scope']),
        keep: passNumOrNull(p, 'backup.keep'),
        dir: passStr(p, 'backup.dir'),
      },
      nightlyPass: {
        enabled: passBool(p, 'nightlyPass.enabled', false),
        cron: p['nightlyPass.cron'] || '0 3 * * *',
      },
      weeklyDigest: {
        enabled: passBool(p, 'weeklyDigest.enabled', false),
        cron: p['weeklyDigest.cron'] || '0 9 * * 1',
        recipients: splitList(p['weeklyDigest.recipients']),
      },
      modelCatalog: {
        enabled: passBool(p, 'modelCatalog.enabled', true),
        url: passStr(p, 'modelCatalog.url'),
        ttlHours: passNum(p, 'modelCatalog.ttlHours', 24),
      },
      logsRotation: {
        enabled: passBool(p, 'logs.rotation.enabled', true),
        maxBytes: passNumOrNull(p, 'logs.rotation.maxBytes'),
        maxFiles: passNumOrNull(p, 'logs.rotation.maxFiles'),
      },
      webSearchBackend: parseWebSearchBackend(p['web.search_backend']),
      webSearxngUrl: passStr(p, 'web.searxng.url'),
      webExtractBackend: p['web.extract_backend'] === 'htmltext' ? 'htmltext' : null,
      auxCompression: await parseAuxModel(p, 'auxiliary.compression', (v) => this.keyPreview(v)),
      auxVision: await parseAuxModel(p, 'auxiliary.vision', (v) => this.keyPreview(v)),
      auxWeb: await parseAuxModel(p, 'auxiliary.web', (v) => this.keyPreview(v)),
      a2aEnabled: passBool(p, 'a2a.enabled', false),
      pluginsAutoInstall:
        p['plugins.auto_install'] === undefined ? null : p['plugins.auto_install'] === 'true',
      webBaseUrl: passStr(p, 'webBaseUrl'),
      // Defaults below mirror the `build*` helpers in packages/config — web-api
      // parses the same file through its own reader and shares no code with them.
      retentionVacuumAfterPrune: passBool(p, 'retention.vacuumAfterPrune', false),
      // Bounds below are the ones `validateSettingsPatch` enforces on the write
      // path. An on-disk value outside them is one `@ethosagent/config` drops on
      // load, so reporting it here would show a number the runtime is not using.
      retentionMinVacuumIntervalDays: passBoundedInt(p, 'retention.minVacuumIntervalDays', 0),
      logsLevel: pickEnum(p['logs.level'], LOG_LEVELS, 'debug'),
      memoryCharLimits: {
        memory: passBoundedInt(p, 'memory.charLimits.memory', 1) ?? 524_288,
        user: passBoundedInt(p, 'memory.charLimits.user', 1) ?? 524_288,
      },
      executionDocker: {
        cpu: passPositiveNum(p, 'execution.docker.cpu') ?? 2,
        diskMb: passBoundedInt(p, 'execution.docker.diskMb', 1),
      },
      executionSsh: {
        // RAW. No defaults anywhere in this block: a defaulted `user` or `port`
        // would render a target string the operator never wrote, and the pane
        // shows that string as the thing it just probed.
        host: passStr(p, 'execution.ssh.host'),
        user: passStr(p, 'execution.ssh.user'),
        port: passBoundedInt(p, 'execution.ssh.port', 1, 65535),
        identityFile: passStr(p, 'execution.ssh.identityFile'),
        knownHostsFile: passStr(p, 'execution.ssh.knownHostsFile'),
        strictHostKeys: pickEnumOrNull(p['execution.ssh.strictHostKeys'], SSH_STRICT_HOST_KEYS),
        remoteWorkdir: passStr(p, 'execution.ssh.remoteWorkdir'),
      },
      kanban: {
        maxInProgress: passBoundedInt(p, 'kanban.maxInProgress', 1),
        maxInProgressPerProfile: passBoundedInt(p, 'kanban.maxInProgressPerProfile', 1),
      },
      cronMaxParallelJobs: passBoundedInt(p, 'cron.maxParallelJobs', 1),
      toolLoop: {
        maxToolCallsWarnAt: passBoundedInt(p, 'toolLoop.maxToolCallsWarnAt', 1),
        maxIdenticalToolCallsWarnAt: passBoundedInt(p, 'toolLoop.maxIdenticalToolCallsWarnAt', 1),
      },
      browser: {
        navigationTimeoutMs:
          passBoundedInt(p, 'browser.navigationTimeoutMs', 1_000, 600_000) ?? 30_000,
        commandTimeoutMs: passBoundedInt(p, 'browser.commandTimeoutMs', 1_000, 600_000) ?? 10_000,
        headed: parseBrowserHeaded(p['browser.headed']),
        idleTimeoutMs: passBoundedInt(p, 'browser.idleTimeoutMs', 60_000, 86_400_000) ?? 600_000,
        stealthEnabled: passBool(p, 'browser.stealth.enabled', false),
        // `false`, not `true`. `buildBrowser` emits no `browser.profiles` block
        // when the key is absent, so `buildLaunchOptions` sees `undefined` and
        // its `profilesEnabled === true` test fails — the browser opens no
        // persistent profile. Reporting `true` here told the operator their
        // logged-in sessions persisted when they did not.
        profilesEnabled: passBool(p, 'browser.profiles.enabled', false),
        proxyServer: passStr(p, 'browser.proxy.server'),
        proxyUsername: passStr(p, 'browser.proxy.username'),
        // Redacted, exactly like `voice.trunk.password`: the resolved proxy
        // credential must never reach the browser.
        proxyPasswordPreview: await this.keyPreview(p['browser.proxy.password']),
      },
      gatewayMaxInboundMediaBytes: passBoundedInt(
        p,
        'gateway.maxInboundMediaBytes',
        1024,
        134_217_728,
      ),
      teamSupervisorRestartLoopGuard: {
        maxRestarts: passBoundedInt(p, 'teamSupervisor.restartLoopGuard.maxRestarts', 1, 1000) ?? 5,
        windowSeconds:
          passBoundedInt(p, 'teamSupervisor.restartLoopGuard.windowSeconds', 1, 86_400) ?? 60,
      },
      discordMissedMessageBackfill: {
        // Default ON — the adapter backfills unless an explicit false says not to.
        enabled: passBool(p, 'discord.missedMessageBackfill.enabled', true),
        windowSeconds: passBoundedInt(p, 'discord.missedMessageBackfill.windowSeconds', 1, 604_800),
        limit: passBoundedInt(p, 'discord.missedMessageBackfill.limit', 1, 100) ?? 50,
      },
    };
  }

  /**
   * Whether the web admin panel is enabled. Gated by `admin.enabled: true`
   * in ~/.ethos/config.yaml — default false; admin access must be enabled
   * explicitly. Missing config counts as disabled.
   */
  async adminEnabled(): Promise<boolean> {
    const raw = await this.opts.config.read();
    return raw?.passthrough['admin.enabled'] === 'true';
  }

  /**
   * Whether a goal check may carry a shell `command`. Gated by
   * `goals.allowCheckCommands: true` in ~/.ethos/config.yaml (parsed for the
   * CLI by `parseConfigYaml` in packages/config) — default false. Read per
   * call so an edit takes effect without a restart. Missing config counts as
   * disabled.
   */
  async goalCheckCommandsAllowed(): Promise<boolean> {
    const raw = await this.opts.config.read();
    return raw?.passthrough['goals.allowCheckCommands'] === 'true';
  }

  /**
   * Resolve the stored credentials for a provider so admin health checks
   * probe with the real key. The raw key still never crosses the RPC
   * boundary — it travels provider-ward only. Prefers the provider-chain
   * entry; falls back to the primary provider fields. Returns null when
   * the provider isn't configured.
   */
  async resolveProviderCredentials(
    provider: string,
  ): Promise<{ apiKey: string; baseUrl?: string } | null> {
    const raw = await this.opts.config.read();
    if (!raw) return null;
    const entry = raw.providers.find((p) => p.provider === provider);
    if (entry) {
      return {
        apiKey: await this.resolveSecretRefs(entry.apiKey ?? ''),
        ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
      };
    }
    if (raw.provider === provider) {
      return {
        apiKey: await this.resolveSecretRefs(raw.apiKey ?? ''),
        ...(raw.baseUrl ? { baseUrl: raw.baseUrl } : {}),
      };
    }
    return null;
  }

  /** Redacted preview of a stored credential. Values in config.yaml are
   *  `${secrets:<ref>}` references (G-SEC), so resolve before redacting —
   *  redacting the reference itself would render `${s…Key}` and tell the
   *  user nothing about which key is set. */
  private async keyPreview(value: string | undefined): Promise<string | null> {
    if (!value) return null;
    return redactKey(await this.resolveSecretRefs(value));
  }

  /** Substitute `${secrets:ref}` references via the resolver. An
   *  unresolvable reference (or no resolver) yields '' — the caller's
   *  health check then fails honestly rather than probing with a
   *  literal `${secrets:...}` string. */
  private async resolveSecretRefs(value: string): Promise<string> {
    const matches = [...value.matchAll(SECRETS_REF_RE)];
    if (matches.length === 0) return value;
    if (!this.opts.secrets) return '';
    let resolved = value;
    for (const m of matches) {
      const ref = m[1];
      if (!ref) continue;
      const secret = await this.opts.secrets.get(ref);
      if (secret === null) return '';
      resolved = resolved.replace(m[0], () => secret);
    }
    return resolved;
  }

  async update(patch: ConfigUpdateInput): Promise<ConfigUpdateResult> {
    // Empty-string apiKey would erase the existing key. Treat as no-op.
    const cleaned: typeof patch = { ...patch };
    if (cleaned.apiKey !== undefined && cleaned.apiKey === '') delete cleaned.apiKey;
    delete cleaned.providersVersion;

    // A `providers` list is checked FIRST, before any write below — a stale or
    // malformed one must leave the file and the vault exactly as they were.
    // The same version is re-checked inside the repository's write lock
    // (`ConfigRepository.update`), which closes the window between this read
    // and that write.
    const before = await this.opts.config.read();
    if (patch.providers !== undefined) {
      assertProviderRows(patch.providers, patch.providersVersion);
      const storedChain = before?.providers ?? [];
      assertProviderIds(
        claimStoredSources(patch.providers, storedChain).map((row) =>
          overlayProviderRow(row, storedChain),
        ),
        storedChain,
        before?.modelRegistry,
      );
      if (providerChainVersion(before?.providers ?? []) !== patch.providersVersion) {
        throw new EthosError({
          code: 'CONFIG_CONFLICT',
          cause:
            'The provider chain changed after this page loaded it (another tab, or `ethos fallback`). Nothing was saved.',
          action: 'Reload Settings, check the provider chain, and save again.',
        });
      }
    }

    // These behavior flags are flat config keys (`admin.enabled`,
    // `display.streaming_edits`, `compaction.autoCompact`, …), not typed fields
    // on the repository's RawConfig. Translate each into a passthrough write and
    // strip it from the patch so it doesn't reach the repository. Passthrough
    // merges add/overwrite only, so writing `memoryConsolidation.enabled` here
    // preserves the sibling `memoryConsolidation.*` decay-tuning keys.
    const passthroughPatch: Record<string, string> = {};
    if (patch.adminEnabled !== undefined) {
      passthroughPatch['admin.enabled'] = patch.adminEnabled ? 'true' : 'false';
    }
    if (patch.streamingEdits !== undefined) {
      passthroughPatch['display.streaming_edits'] = patch.streamingEdits;
    }
    if (patch.callStyle !== undefined) {
      passthroughPatch['display.call_style'] = patch.callStyle;
    }
    if (patch.callAccent !== undefined) {
      passthroughPatch['display.call_accent'] = parseCallAccent(patch.callAccent);
    }
    if (patch.autoCompact !== undefined) {
      passthroughPatch['compaction.autoCompact'] = patch.autoCompact ? 'true' : 'false';
    }
    if (patch.memoryConsolidationEnabled !== undefined) {
      passthroughPatch['memoryConsolidation.enabled'] = patch.memoryConsolidationEnabled
        ? 'true'
        : 'false';
    }
    if (patch.memoryCaptureEnabled !== undefined) {
      passthroughPatch['memoryCapture.enabled'] = patch.memoryCaptureEnabled ? 'true' : 'false';
    }
    if (patch.memoryCaptureModel !== undefined) {
      passthroughPatch['memoryCapture.model'] = patch.memoryCaptureModel;
    }
    if (patch.memoryNotices !== undefined) {
      passthroughPatch['display.memory_notices'] = patch.memoryNotices ? 'true' : 'false';
    }
    if (patch.voiceChime !== undefined) {
      passthroughPatch['display.voice_chime'] = patch.voiceChime ? 'true' : 'false';
    }
    // Voice tuning: clamp each provided value to its range and persist as a
    // string under its flat `display.voice_*` key. Clamp defends direct callers;
    // the RPC layer already rejects out-of-range via the Zod bounds.
    for (const [key, spec] of Object.entries(VOICE_TUNING)) {
      const value = patch[spec.field];
      if (value === undefined) continue;
      const clamped = Math.min(spec.max, Math.max(spec.min, value));
      passthroughPatch[key] = String(clamped);
      delete cleaned[spec.field];
    }

    // Settings-page passthrough groups. Bounds are validated (mirroring
    // packages/config's parse validation) so a direct — non-RPC — caller
    // can't persist values the CLI loader would reject or drop.
    validateSettingsPatch(patch);
    // Scalars: undefined = leave unchanged; null (or '') = delete the key so
    // the built-in default applies again; anything else = stringify and set.
    const deleteKeys: string[] = [];
    const set = (key: string, v: string | number | boolean | null | undefined): void => {
      if (v === undefined) return;
      if (v === null || v === '') {
        deleteKeys.push(key);
        return;
      }
      passthroughPatch[key] = String(v);
    };
    const setList = (key: string, v: string[] | null | undefined, sep = ','): void => {
      if (v === undefined) return;
      if (v === null || v.length === 0) {
        deleteKeys.push(key);
        return;
      }
      passthroughPatch[key] = v.join(sep);
    };

    set('apiVersion', patch.apiVersion);
    set('verbose', patch.verbose);
    set('display.verbosity', patch.displayVerbosity);
    set('display.busy_input_mode', patch.displayBusyInputMode);
    set('display.tool_preview_length', patch.displayToolPreviewLength);
    set('display.resume_hint', patch.displayResumeHint);
    set('display.resume_recap_turns', patch.displayResumeRecapTurns);
    set('display.bell_on_complete', patch.displayBellOnComplete);
    if (patch.compaction) {
      set('compaction.pressure', patch.compaction.pressure);
      set('compaction.target', patch.compaction.target);
      set('compaction.gateDelta', patch.compaction.gateDelta);
      set('compaction.retryOnOverflow', patch.compaction.retryOnOverflow);
      set('compaction.abortOnSummaryFailure', patch.compaction.abortOnSummaryFailure);
      set('compaction.smallWindow', patch.compaction.smallWindow);
    }
    if (patch.voiceFiller) {
      set('voice.filler.enabled', patch.voiceFiller.enabled);
      set('voice.filler.afterMs', patch.voiceFiller.afterMs);
      set('voice.filler.text', patch.voiceFiller.text);
      set('voice.filler.tickIntervalMs', patch.voiceFiller.tickIntervalMs);
    }
    if (patch.memoryVault) {
      set('memoryVault.path', patch.memoryVault.path);
      set('memoryVault.agentDir', patch.memoryVault.agentDir);
      // ', ' separator matches packages/config's writeConfig serialization.
      setList('memoryVault.prefetch', patch.memoryVault.prefetch, ', ');
      setList('memoryVault.exclude', patch.memoryVault.exclude, ', ');
    }
    if (patch.memoryApproval) {
      set('memoryApproval.mode', patch.memoryApproval.mode);
      set('memoryApproval.cap', patch.memoryApproval.cap);
      set('memoryApproval.ttlDays', patch.memoryApproval.ttlDays);
    }
    if (patch.world) {
      set('world.enabled', patch.world.enabled);
      set('world.contextMaxChars', patch.world.contextMaxChars);
      set('world.contextHops', patch.world.contextHops);
      set('world.extraction', patch.world.extraction);
      set('world.proposals.cap', patch.world.proposalsCap);
      set('world.proposals.ttlDays', patch.world.proposalsTtlDays);
    }
    if (patch.memoryConsolidation) {
      set('memoryConsolidation.halfLifeDays', patch.memoryConsolidation.halfLifeDays);
      set('memoryConsolidation.threshold', patch.memoryConsolidation.threshold);
      set('memoryConsolidation.exemptUser', patch.memoryConsolidation.exemptUser);
      set('memoryConsolidation.flushThreshold', patch.memoryConsolidation.flushThreshold);
      set('memoryConsolidation.timeboxMs', patch.memoryConsolidation.timeboxMs);
      set('memoryConsolidation.maxTokens', patch.memoryConsolidation.maxTokens);
      set('memoryConsolidation.maxDeltaChars', patch.memoryConsolidation.maxDeltaChars);
      set(
        'memoryConsolidation.minMessagesSinceFlush',
        patch.memoryConsolidation.minMessagesSinceFlush,
      );
    }
    if (patch.memoryCapture) {
      set('memoryCapture.provider', patch.memoryCapture.provider);
      set('memoryCapture.apiKey', patch.memoryCapture.apiKey);
      set('memoryCapture.baseUrl', patch.memoryCapture.baseUrl);
      set('memoryCapture.maxPerHour', patch.memoryCapture.maxPerHour);
      set('memoryCapture.maxPerDay', patch.memoryCapture.maxPerDay);
    }
    if (patch.background) {
      set('background.enabled', patch.background.enabled);
      set('background.max_concurrent_jobs', patch.background.maxConcurrentJobs);
      set('background.max_jobs_per_root', patch.background.maxJobsPerRoot);
      set('background.max_jobs_per_personality', patch.background.maxJobsPerPersonality);
      set('background.default_max_cost_usd', patch.background.defaultMaxCostUsd);
      set('background.max_root_background_usd', patch.background.maxRootBackgroundUsd);
      set('background.queued_ttl_ms', patch.background.queuedTtlMs);
      set('background.stale_ms', patch.background.staleMs);
      set('background.heartbeat_ms', patch.background.heartbeatMs);
      set('background.retention_days', patch.background.retentionDays);
    }
    if (patch.backup) {
      set('backup.enabled', patch.backup.enabled);
      set('backup.cron', patch.backup.cron);
      setList('backup.scope', patch.backup.scope);
      set('backup.keep', patch.backup.keep);
      set('backup.dir', patch.backup.dir);
    }
    if (patch.nightlyPass) {
      set('nightlyPass.enabled', patch.nightlyPass.enabled);
      set('nightlyPass.cron', patch.nightlyPass.cron);
    }
    if (patch.weeklyDigest) {
      set('weeklyDigest.enabled', patch.weeklyDigest.enabled);
      set('weeklyDigest.cron', patch.weeklyDigest.cron);
      setList('weeklyDigest.recipients', patch.weeklyDigest.recipients);
    }
    if (patch.modelCatalog) {
      set('modelCatalog.enabled', patch.modelCatalog.enabled);
      set('modelCatalog.url', patch.modelCatalog.url);
      set('modelCatalog.ttlHours', patch.modelCatalog.ttlHours);
    }
    if (patch.logsRotation) {
      set('logs.rotation.enabled', patch.logsRotation.enabled);
      set('logs.rotation.maxBytes', patch.logsRotation.maxBytes);
      set('logs.rotation.maxFiles', patch.logsRotation.maxFiles);
    }
    set('logs.level', patch.logsLevel);
    set('retention.vacuumAfterPrune', patch.retentionVacuumAfterPrune);
    set('retention.minVacuumIntervalDays', patch.retentionMinVacuumIntervalDays);
    set('cron.maxParallelJobs', patch.cronMaxParallelJobs);
    set('gateway.maxInboundMediaBytes', patch.gatewayMaxInboundMediaBytes);
    if (patch.memoryCharLimits) {
      set('memory.charLimits.memory', patch.memoryCharLimits.memory);
      set('memory.charLimits.user', patch.memoryCharLimits.user);
    }
    if (patch.executionDocker) {
      set('execution.docker.cpu', patch.executionDocker.cpu);
      set('execution.docker.diskMb', patch.executionDocker.diskMb);
    }
    if (patch.executionSsh) {
      set('execution.ssh.host', patch.executionSsh.host);
      set('execution.ssh.user', patch.executionSsh.user);
      set('execution.ssh.port', patch.executionSsh.port);
      set('execution.ssh.identityFile', patch.executionSsh.identityFile);
      set('execution.ssh.knownHostsFile', patch.executionSsh.knownHostsFile);
      set('execution.ssh.strictHostKeys', patch.executionSsh.strictHostKeys);
      set('execution.ssh.remoteWorkdir', patch.executionSsh.remoteWorkdir);
    }
    if (patch.kanban) {
      set('kanban.maxInProgress', patch.kanban.maxInProgress);
      set('kanban.maxInProgressPerProfile', patch.kanban.maxInProgressPerProfile);
    }
    if (patch.toolLoop) {
      set('toolLoop.maxToolCallsWarnAt', patch.toolLoop.maxToolCallsWarnAt);
      set('toolLoop.maxIdenticalToolCallsWarnAt', patch.toolLoop.maxIdenticalToolCallsWarnAt);
    }
    // `patch.browser` is written below, next to the other anchored blocks: its
    // proxy sub-block needs `deletePrefix`/`carrySecret`, which are declared
    // further down.
    if (patch.teamSupervisorRestartLoopGuard) {
      const g = patch.teamSupervisorRestartLoopGuard;
      set('teamSupervisor.restartLoopGuard.maxRestarts', g.maxRestarts);
      set('teamSupervisor.restartLoopGuard.windowSeconds', g.windowSeconds);
    }
    if (patch.discordMissedMessageBackfill) {
      const b = patch.discordMissedMessageBackfill;
      set('discord.missedMessageBackfill.enabled', b.enabled);
      set('discord.missedMessageBackfill.windowSeconds', b.windowSeconds);
      set('discord.missedMessageBackfill.limit', b.limit);
    }
    set('web.search_backend', patch.webSearchBackend);
    set('web.extract_backend', patch.webExtractBackend);
    set('web.searxng.url', patch.webSearxngUrl);
    const setAux = (prefix: string, aux: AuxModelUpdateInput | undefined): void => {
      if (!aux) return;
      set(`${prefix}.model`, aux.model);
      set(`${prefix}.provider`, aux.provider);
      set(`${prefix}.apiKey`, aux.apiKey);
      set(`${prefix}.baseUrl`, aux.baseUrl);
    };
    setAux('auxiliary.compression', patch.auxCompression);
    setAux('auxiliary.vision', patch.auxVision);
    setAux('auxiliary.web', patch.auxWeb);
    // Voice keys with no other UI home. `auxiliary.*` keys the CLI parses but
    // the repository does not model, plus the two `voice.*` keys.
    set('auxiliary.asr.command', patch.voiceSttCommand);
    set('auxiliary.tts.command', patch.voiceTtsCommand);
    set('auxiliary.tts.outputFormat', patch.voiceTtsOutputFormat);
    set('auxiliary.tts.timeout', patch.voiceTtsTimeoutMs);
    set('auxiliary.tts.maxTextLength', patch.voiceTtsMaxTextLength);
    set('auxiliary.asr.timeout', patch.voiceSttTimeoutMs);
    set('voice.defaultMode', patch.voiceDefaultMode);
    set('voice.transcode.ffmpegPath', patch.voiceTranscodeFfmpegPath);
    set('voice.transcode.bitrateKbps', patch.voiceTranscodeBitrateKbps);
    // The yaml key is `timeout`; the field says `Sec` because the unit is the
    // one thing a bare `timeout` next to five `*Ms` neighbours cannot convey.
    set('voice.transcode.timeout', patch.voiceTranscodeTimeoutSec);
    set('voice.artifacts.abandonAfterDays', patch.voiceArtifactAbandonAfterDays);
    set('voice.artifacts.maxTotalMb', patch.voiceArtifactMaxTotalMb);
    set('voice.tier', patch.voiceTier);
    set('voice.realtime.default', patch.voiceRealtimeDefault);
    set('voice.realtime.sessionBudgetUsd', patch.voiceRealtimeSessionBudgetUsd);
    // Clearing the list removes the key, which turns the egress gate off — the
    // gate is armed by DECLARING the key, so there is nothing to keep here.
    setList('voice.trustedPlugins', patch.voiceTrustedPlugins, ', ');
    set('a2a.enabled', patch.a2aEnabled);
    set('plugins.auto_install', patch.pluginsAutoInstall);
    set('webBaseUrl', patch.webBaseUrl);

    // Record groups replace their whole key family: every existing key under
    // the prefix is deleted, then the provided entries are re-written. The
    // read below also supplies stored webhook secrets so an update that omits
    // `secret` keeps the existing one.
    const replacesRecords =
      patch.retention !== undefined ||
      patch.personalityRetention !== undefined ||
      patch.webhooks !== undefined ||
      patch.quickCommands !== undefined ||
      patch.channelToolsets !== undefined ||
      patch.voiceTtsProviders !== undefined ||
      patch.voiceSttProviders !== undefined ||
      patch.voiceRealtimeProviders !== undefined ||
      patch.voiceChannelTtsOut !== undefined ||
      patch.wakeRoutes !== undefined ||
      patch.voiceBargeIn !== undefined ||
      patch.voiceBots !== undefined;
    // The telephony blocks need the same read for two more reasons: a write-only
    // secret has to re-write the value already on disk, and the required-field
    // check below asks what the block looks like AFTER the patch lands.
    const touchesTelephony = TELEPHONY_PATCH_KEYS.some((key) => patch[key] !== undefined);
    // `browser.proxy.*` needs the same read for the same two reasons: the
    // write-only password re-writes the value already on disk, and the
    // required-together check asks what the block looks like AFTER the patch.
    const touchesBrowserProxy =
      patch.browser?.proxyServer !== undefined ||
      patch.browser?.proxyUsername !== undefined ||
      patch.browser?.proxyPassword !== undefined;
    const currentPassthrough =
      replacesRecords || touchesTelephony || touchesBrowserProxy
        ? ((await this.opts.config.read())?.passthrough ?? {})
        : {};
    const deletePrefix = (prefix: string): void => {
      for (const key of Object.keys(currentPassthrough)) {
        if (key.startsWith(prefix)) deleteKeys.push(key);
      }
    };
    if (patch.retention !== undefined) {
      // Scoped to the duration subkeys this record owns, NOT the whole prefix:
      // `retention.vacuumAfterPrune` / `retention.minVacuumIntervalDays` are
      // separate scalars that happen to share it, and a prefix sweep would
      // silently clear them whenever a TTL was edited.
      const owned = new Set(RETENTION_SUBKEYS.map((sub) => `retention.${sub}`));
      for (const key of Object.keys(currentPassthrough)) {
        if (owned.has(key)) deleteKeys.push(key);
      }
      for (const [sub, dur] of Object.entries(patch.retention)) {
        set(`retention.${sub}`, dur);
      }
    }
    if (patch.personalityRetention !== undefined) {
      for (const key of Object.keys(currentPassthrough)) {
        if (/^personalities\.[^.]+\.retention\./.test(key)) deleteKeys.push(key);
      }
      for (const [pid, map] of Object.entries(patch.personalityRetention)) {
        if (!map) continue;
        for (const [sub, dur] of Object.entries(map)) {
          set(`personalities.${pid}.retention.${sub}`, dur);
        }
      }
    }
    if (patch.voiceChannelTtsOut !== undefined) {
      // Full replacement, same rule as the rosters: an omitted platform is not
      // "unchanged", it is "no override" — which is a different deployment
      // decision from `false` and has to be expressible.
      deletePrefix('voice.channels.');
      for (const [platform, ttsOut] of Object.entries(patch.voiceChannelTtsOut)) {
        set(`voice.channels.${platform}.ttsOut`, ttsOut);
      }
    }
    if (patch.channelToolsets !== undefined) {
      deletePrefix('channel_toolsets.');
      for (const [platform, tools] of Object.entries(patch.channelToolsets)) {
        setList(`channel_toolsets.${platform}`, tools);
      }
    }
    if (patch.quickCommands !== undefined) {
      deletePrefix('quick_commands.');
      for (const [name, qc] of Object.entries(patch.quickCommands)) {
        if (!qc) continue;
        set(`quick_commands.${name}.type`, qc.type);
        if (qc.type === 'exec') set(`quick_commands.${name}.command`, qc.command);
        else set(`quick_commands.${name}.reply`, qc.reply);
        if (qc.gateway) set(`quick_commands.${name}.gateway`, true);
        if (qc.channels && qc.channels.length > 0) {
          setList(`quick_commands.${name}.channels`, qc.channels);
        }
      }
    }
    // Write-only key, shared by all three rosters: a provided value wins,
    // otherwise the stored one is re-written so a form that never saw the key
    // cannot erase it. The value re-written is the `${secrets:…}` reference,
    // which `externalizeSecret` passes through untouched — no second vault
    // entry. The stored key is looked up under the OLD spelling too, so an
    // operator who saves an existing `voice.providers.*` entry keeps its
    // credential.
    const carryRosterKey = (
      kind: 'tts' | 'stt' | 'realtime',
      name: string,
      provided?: string,
    ): void => {
      const apiKey =
        provided ||
        currentPassthrough[`voice.${kind}.providers.${name}.apiKey`] ||
        (kind === 'tts' ? currentPassthrough[`voice.providers.${name}.apiKey`] : undefined);
      if (apiKey) passthroughPatch[`voice.${kind}.providers.${name}.apiKey`] = apiKey;
    };
    if (patch.voiceTtsProviders !== undefined) {
      // Both spellings are dropped, and only the new one is written back: a
      // save from Settings migrates a legacy roster rather than duplicating it.
      deletePrefix('voice.providers.');
      deletePrefix('voice.tts.providers.');
      for (const [name, entry] of Object.entries(patch.voiceTtsProviders)) {
        if (!entry) continue;
        set(`voice.tts.providers.${name}.provider`, entry.provider);
        set(`voice.tts.providers.${name}.model`, entry.model);
        carryRosterKey('tts', name, entry.apiKey);
        set(`voice.tts.providers.${name}.voice`, entry.voice);
        set(`voice.tts.providers.${name}.baseUrl`, entry.baseUrl);
        set(`voice.tts.providers.${name}.command`, entry.command);
        set(`voice.tts.providers.${name}.outputFormat`, entry.outputFormat);
        set(`voice.tts.providers.${name}.timeout`, entry.timeout);
        set(`voice.tts.providers.${name}.maxTextLength`, entry.maxTextLength);
      }
    }
    if (patch.voiceSttProviders !== undefined) {
      deletePrefix('voice.stt.providers.');
      for (const [name, entry] of Object.entries(patch.voiceSttProviders)) {
        if (!entry) continue;
        set(`voice.stt.providers.${name}.provider`, entry.provider);
        set(`voice.stt.providers.${name}.model`, entry.model);
        carryRosterKey('stt', name, entry.apiKey);
        set(`voice.stt.providers.${name}.baseUrl`, entry.baseUrl);
        set(`voice.stt.providers.${name}.command`, entry.command);
        set(`voice.stt.providers.${name}.timeout`, entry.timeout);
      }
    }
    if (patch.voiceRealtimeProviders !== undefined) {
      deletePrefix('voice.realtime.providers.');
      for (const [name, entry] of Object.entries(patch.voiceRealtimeProviders)) {
        if (!entry) continue;
        set(`voice.realtime.providers.${name}.provider`, entry.provider);
        set(`voice.realtime.providers.${name}.model`, entry.model);
        carryRosterKey('realtime', name, entry.apiKey);
        set(`voice.realtime.providers.${name}.baseUrl`, entry.baseUrl);
        set(`voice.realtime.providers.${name}.voice`, entry.voice);
        set(`voice.realtime.providers.${name}.costPerMinuteUsd`, entry.costPerMinuteUsd);
      }
    }
    if (patch.wakeRoutes !== undefined) {
      // Wholesale replacement — see the field's docs. `privileged` and
      // `enabled` are written only when explicitly false/true so a hand-written
      // config that never said either keeps saying nothing.
      deletePrefix('voice.wake.routes.');
      for (const [id, route] of Object.entries(patch.wakeRoutes)) {
        if (!route) continue;
        set(`voice.wake.routes.${id}.phrase`, route.phrase);
        set(`voice.wake.routes.${id}.personality`, route.personality);
        if (route.privileged !== undefined) {
          set(`voice.wake.routes.${id}.privileged`, route.privileged);
        }
        if (route.enabled !== undefined) {
          set(`voice.wake.routes.${id}.enabled`, route.enabled);
        }
      }
    }
    // -- Telephony ------------------------------------------------------------
    // Write-only credential, same rule the rosters use: a provided value wins,
    // otherwise the stored `${secrets:…}` reference is re-written so a form that
    // only ever saw a preview cannot erase the key. `null` is the explicit
    // "clear it", which is the one thing a blank field must NOT mean here.
    const carrySecret = (key: string, provided: string | null | undefined): void => {
      if (provided === null) {
        deleteKeys.push(key);
        return;
      }
      const value = provided || currentPassthrough[key];
      if (value) passthroughPatch[key] = value;
    };
    // The trunk and LiveKit blocks are ANCHORED: the CLI parser requires
    // provider+trunkId (and url+apiKey+apiSecret) together, so clearing the
    // anchor has to take the whole family — including the vault-backed secrets —
    // rather than leaving a half block that fails to load.
    if (patch.voiceTrunkProvider === null) {
      deletePrefix('voice.trunk.');
    } else if (TRUNK_PATCH_KEYS.some((key) => patch[key] !== undefined)) {
      set('voice.trunk.provider', patch.voiceTrunkProvider);
      set('voice.trunk.trunkId', patch.voiceTrunkId);
      set('voice.trunk.fromNumber', patch.voiceTrunkFromNumber);
      set('voice.trunk.username', patch.voiceTrunkUsername);
      set('voice.trunk.webhookPath', patch.voiceTrunkWebhookPath);
      set('voice.trunk.codec', patch.voiceTrunkCodec);
      carrySecret('voice.trunk.password', patch.voiceTrunkPassword);
      carrySecret('voice.trunk.webhookSecret', patch.voiceTrunkWebhookSecret);
    }
    if (patch.voiceLivekitUrl === null) {
      deletePrefix('voice.livekit.');
    } else if (LIVEKIT_PATCH_KEYS.some((key) => patch[key] !== undefined)) {
      set('voice.livekit.url', patch.voiceLivekitUrl);
      carrySecret('voice.livekit.apiKey', patch.voiceLivekitApiKey);
      carrySecret('voice.livekit.apiSecret', patch.voiceLivekitApiSecret);
    }
    if (patch.browser) {
      set('browser.navigationTimeoutMs', patch.browser.navigationTimeoutMs);
      set('browser.commandTimeoutMs', patch.browser.commandTimeoutMs);
      set('browser.headed', patch.browser.headed);
      set('browser.idleTimeoutMs', patch.browser.idleTimeoutMs);
      set('browser.stealth.enabled', patch.browser.stealthEnabled);
      set('browser.profiles.enabled', patch.browser.profilesEnabled);
      // The proxy block is ANCHORED on `server`, the same way the trunk and
      // LiveKit blocks above are: `@ethosagent/config` refuses BOOT on
      // credentials with no server to carry them, so clearing the anchor has to
      // take the username and the vault-backed password with it rather than
      // leaving half a block that fails to load.
      if (patch.browser.proxyServer === null) {
        deletePrefix('browser.proxy.');
      } else {
        set('browser.proxy.server', patch.browser.proxyServer);
        set('browser.proxy.username', patch.browser.proxyUsername);
        carrySecret('browser.proxy.password', patch.browser.proxyPassword);
      }
    }
    // ', ' matches the separator packages/config's writeConfig serializes with.
    setList('voice.inbound.allowlist', patch.voiceInboundAllowlist, ', ');
    set('voice.inbound.receptionist', patch.voiceInboundReceptionist);
    set('voice.inbound.concurrencyCap', patch.voiceInboundConcurrencyCap);
    set('voice.inbound.perCallerPerHour', patch.voiceInboundPerCallerPerHour);
    set('voice.inbound.dailyBudgetUsd', patch.voiceInboundDailyBudgetUsd);
    set('voice.inbound.prewarm', patch.voiceInboundPrewarm);
    // The owner destination is anchored the same way: platform and chatId are
    // required together, and half a route silently drops the one notification
    // the block was configured to deliver.
    if (patch.voiceInboundOwnerPlatform === null) {
      deletePrefix('voice.inbound.owner.');
    } else {
      set('voice.inbound.owner.platform', patch.voiceInboundOwnerPlatform);
      set('voice.inbound.owner.chatId', patch.voiceInboundOwnerChatId);
      set('voice.inbound.owner.botKey', patch.voiceInboundOwnerBotKey);
    }
    if (patch.voiceBargeIn !== undefined) {
      deletePrefix('voice.bargeIn.');
      for (const [surface, tuning] of Object.entries(patch.voiceBargeIn)) {
        if (!tuning) continue;
        set(`voice.bargeIn.${surface}.energyThreshold`, tuning.energyThreshold);
        set(`voice.bargeIn.${surface}.minSpeechMs`, tuning.minSpeechMs);
        set(`voice.bargeIn.${surface}.silenceMs`, tuning.silenceMs);
      }
    }
    if (patch.voiceBots !== undefined) {
      // Renumbered from 0 on every save: the index is positional, not an
      // identity (that is what `id` is for), and leaving gaps would make the
      // next save's ordering depend on which row was deleted.
      deletePrefix('voice.bots.');
      for (const [index, bot] of patch.voiceBots.entries()) {
        if (!bot) continue;
        if (bot.id) set(`voice.bots.${index}.id`, bot.id);
        set(`voice.bots.${index}.match`, bot.match);
        set(`voice.bots.${index}.bind.type`, bot.bind.type);
        set(`voice.bots.${index}.bind.name`, bot.bind.name);
        // Written only when true, matching writeConfig — a config that never
        // said `allowSlashSwitch` keeps saying nothing.
        if (bot.bind.allowSlashSwitch) set(`voice.bots.${index}.bind.allowSlashSwitch`, true);
      }
    }
    if (patch.webhooks !== undefined) {
      deletePrefix('webhooks.');
      // `webhooks.<id>.*` carries fields this layer never models —
      // `events`/`eventHeader`/`eventField`, `deliverOnly`/`deliver.<n>.*`,
      // `hmac.*`, `rateLimit.*` — all config-file-only by design, with no UI.
      // The prefix wipe above takes them too, so without this carry a save
      // from the Triggers form silently deletes every one of them: the hook
      // stops filtering, fanning out, verifying signatures and throttling,
      // with no error shown. Same mechanism the write-only `secret` uses,
      // generalized to "everything the patch does not speak for".
      //
      // Only hooks PRESENT in the patch are carried: a hook the operator
      // removed is a real deletion, and resurrecting its keys would undo it.
      const carryUnmodelledKeys = (hookId: string): void => {
        // Exact-id prefix, not a fuzzy one: hook ids match [A-Za-z0-9_-]+
        // (`checkRecordKey`, and the reader's own `^webhooks\.([^.]+)\.` parse)
        // so they contain no '.'. `webhooks.ab.x` therefore cannot start with
        // `webhooks.a.` — that would need a '.' as the second character of the
        // id — and hook `a` can never pick up hook `ab`'s keys.
        const prefix = `webhooks.${hookId}.`;
        for (const [key, value] of Object.entries(currentPassthrough)) {
          if (!key.startsWith(prefix)) continue;
          if (WEBHOOK_MODELLED_FIELDS.has(key.slice(prefix.length))) continue;
          passthroughPatch[key] = value;
        }
      };
      for (const [hookId, hook] of Object.entries(patch.webhooks)) {
        if (!hook) continue;
        carryUnmodelledKeys(hookId);
        set(`webhooks.${hookId}.personalityId`, hook.personalityId);
        // Write-only secret: provided value wins, then the stored secret,
        // then a generated one for a brand-new hook. Never echoed back.
        const secret =
          hook.secret ??
          currentPassthrough[`webhooks.${hookId}.secret`] ??
          randomBytes(24).toString('base64url');
        passthroughPatch[`webhooks.${hookId}.secret`] = secret;
        if (hook.sessionKey) set(`webhooks.${hookId}.sessionKey`, hook.sessionKey);
        if (hook.prefilter) set(`webhooks.${hookId}.prefilter`, hook.prefilter);
        if (hook.prefilterTimeoutSeconds !== undefined) {
          set(`webhooks.${hookId}.prefilterTimeoutSeconds`, hook.prefilterTimeoutSeconds);
        }
        if (hook.mode) set(`webhooks.${hookId}.mode`, hook.mode);
      }
    }
    // Required-together checks, run against the block as it will be ON DISK
    // rather than against the patch: a form that sends only `trunkId` leaves a
    // provider already in the file perfectly valid, and a form that clears the
    // provider while leaving a password behind does not. Only the merged view
    // can tell those apart.
    const keysAfterWrite = (prefix: string): Set<string> => {
      const keys = new Set(Object.keys(currentPassthrough).filter((k) => k.startsWith(prefix)));
      for (const key of deleteKeys) if (key.startsWith(prefix)) keys.delete(key);
      for (const key of Object.keys(passthroughPatch)) if (key.startsWith(prefix)) keys.add(key);
      return keys;
    };
    const requireTogether = (prefix: string, required: readonly string[]): void => {
      const keys = keysAfterWrite(prefix);
      if (keys.size === 0) return;
      for (const key of required) {
        if (!keys.has(key)) {
          invalidValue(key, `is required whenever any ${prefix}* key is set`);
        }
      }
    };
    if (touchesTelephony) {
      requireTogether('voice.trunk.', ['voice.trunk.provider', 'voice.trunk.trunkId']);
      requireTogether('voice.livekit.', VOICE_LIVEKIT_KEYS);
      requireTogether('voice.inbound.owner.', [
        'voice.inbound.owner.platform',
        'voice.inbound.owner.chatId',
      ]);
    }
    // Credentials with nowhere to go: `buildBrowser` refuses boot on a
    // username/password with no `browser.proxy.server`, because an operator
    // who believes a proxy is carrying their traffic and has none is the
    // fail-open case that block exists to catch.
    if (touchesBrowserProxy) requireTogether('browser.proxy.', ['browser.proxy.server']);
    // A bot bound to a personality that does not exist fails SILENTLY on a
    // ringing phone — the call connects to nothing. The editor is the last place
    // the operator can still see the typo, so it is refused here, the same check
    // `WakeRoutesService` makes for a wake phrase. Team binds are not checked:
    // a team is not in the personality registry.
    const personalities = this.opts.personalities;
    if (personalities && patch.voiceBots) {
      for (const [index, bot] of patch.voiceBots.entries()) {
        if (bot?.bind.type !== 'personality') continue;
        if (!(await personalities.exists(bot.bind.name))) {
          invalidValue(
            `voiceBots.${index}.bind.name`,
            `names unknown personality '${bot.bind.name}'`,
          );
        }
      }
    }

    for (const key of SETTINGS_PATCH_KEYS) delete cleaned[key];

    // Convert providers to repository format when present. The incoming list
    // is the WHOLE chain in its new order (the Settings page sends it on every
    // save), but a row carries only what the page shows. A row that names the
    // stored entry it was loaded from (`sourceIndex`) is overlaid onto that
    // entry, so the key reference, `apiVersion` / `region` / `awsProfile` and
    // any unmodelled `passthrough` survive; see `overlayProviderRow`. Pinned by
    // `__tests__/services/config-provider-chain.test.ts`.
    // Every vault secret the stored chain points at is a deletion candidate;
    // `deleteOrphanedSecrets` keeps the ones the written config still names.
    let repoProviders: RawProviderEntry[] | undefined;
    let chainSecretRefs: string[] = [];
    if (cleaned.providers) {
      const stored = before?.providers ?? [];
      repoProviders = claimStoredSources(cleaned.providers, stored).map((p) =>
        overlayProviderRow(p, stored),
      );
      chainSecretRefs = providerChainSecretRefs(stored);
      // Below two entries the runtime runs on the top-level fields, from two
      // on on the chain alone (`createLLM`, packages/wiring). A config with no
      // chain shows ONE row, built from the top-level fields: saving it back
      // must not write a one-entry chain (the runtime ignores it, and it went
      // keyless into entry 0 the moment a second row was added). And when this
      // save grows a chain of fewer than two entries past one, entry 0 takes
      // the primary's place, so it takes the top-level key reference, base
      // URL, model and provider-specific fields too (`fillFromTopLevel`).
      const legacySingleRow =
        stored.length === 0 &&
        cleaned.providers.length === 1 &&
        cleaned.providers[0]?.sourceIndex === undefined;
      const head = repoProviders[0];
      if (legacySingleRow) {
        repoProviders = undefined;
      } else if (stored.length < 2 && repoProviders.length >= 2 && head && before?.provider) {
        repoProviders[0] = fillFromTopLevel(head, topLevelChainEntry(before));
      }
      // The rows are not repository entries; only `repoProviders` is written.
      delete cleaned.providers;
    }

    // A patch that moves the top-level `provider` moves the whole top-level
    // entry with it — key, model, base URL and the provider-specific lines —
    // and never leaves the old provider's behind (`mirrorTopLevel`). Applied
    // here, before the passthrough deletes below, because two of those lines
    // live in passthrough.
    const mirror = mirrorTopLevel(cleaned, before, repoProviders);
    for (const [key, value] of Object.entries(mirror.set)) passthroughPatch[key] = value;
    for (const key of mirror.clear) {
      delete passthroughPatch[key];
      if (before?.passthrough[key] !== undefined) deleteKeys.push(key);
    }

    // A key both deleted (prefix replacement) and re-set in the same patch
    // must survive — the delete pass runs first, so drop it from the list.
    const finalDeletes = [...new Set(deleteKeys)].filter((k) => !(k in passthroughPatch));
    // `webhooks.<id>.secret` and the roster `apiKey`s are all externalized, and
    // the config key is the only thing pointing at the vault entry. Dropping the
    // key alone leaves the material behind forever, so parse the ref that was
    // STORED and hand it to the post-write cleanup.
    //
    // A ref that some SURVIVING key still carries is not dropped: the legacy →
    // `voice.tts.providers.*` migration deletes the old key while re-writing
    // its exact `${secrets:…}` value under the new one, and deleting the vault
    // entry there would blank a credential the operator never touched.
    const survivingRefs = new Set(
      Object.values(passthroughPatch)
        .map((v) => (typeof v === 'string' ? secretRefFromValue(v) : null))
        .filter((ref): ref is string => ref !== null),
    );
    const droppedSecretRefs = finalDeletes
      .filter(
        (k) =>
          /^webhooks\.[^.]+\.secret$/.test(k) ||
          /^voice\.(?:(?:tts|stt|realtime)\.)?providers\.[^.]+\.apiKey$/.test(k) ||
          // Telephony credentials. Reachable from the UI for the first time in
          // this phase, and both are cleared by dropping their whole block
          // (`voiceTrunkProvider: null`, `voiceLivekitUrl: null`), which deletes
          // the only config key pointing at the vault entry.
          /^voice\.trunk\.(?:password|webhookSecret)$/.test(k) ||
          /^voice\.livekit\.(?:apiKey|apiSecret)$/.test(k) ||
          // Same shape: cleared by dropping the whole block
          // (`browser.proxyServer: null`), which deletes the only config key
          // pointing at the vault entry.
          k === 'browser.proxy.password',
      )
      .map((k) => secretRefFromValue(currentPassthrough[k] ?? ''))
      .filter((ref): ref is string => ref !== null && !survivingRefs.has(ref));
    if (finalDeletes.length > 0) {
      await this.opts.config.deletePassthroughKeys(finalDeletes);
    }

    const passthrough = Object.keys(passthroughPatch).length > 0 ? passthroughPatch : undefined;
    delete cleaned.adminEnabled;
    delete cleaned.streamingEdits;
    delete cleaned.callStyle;
    delete cleaned.callAccent;
    delete cleaned.autoCompact;
    delete cleaned.memoryConsolidationEnabled;
    delete cleaned.memoryCaptureEnabled;
    delete cleaned.memoryCaptureModel;
    delete cleaned.memoryNotices;
    delete cleaned.voiceChime;
    // Written above as flat config keys; never repository fields.
    delete cleaned.voiceSttCommand;
    delete cleaned.voiceTtsCommand;
    delete cleaned.voiceTtsOutputFormat;
    delete cleaned.voiceTtsTimeoutMs;
    delete cleaned.voiceTtsMaxTextLength;
    delete cleaned.voiceSttTimeoutMs;
    delete cleaned.voiceTrustedPlugins;
    delete cleaned.voiceDefaultMode;
    delete cleaned.voiceTranscodeFfmpegPath;
    delete cleaned.voiceTranscodeBitrateKbps;
    delete cleaned.voiceTranscodeTimeoutSec;
    delete cleaned.voiceArtifactAbandonAfterDays;
    delete cleaned.voiceArtifactMaxTotalMb;
    delete cleaned.voiceTier;
    delete cleaned.voiceRealtimeDefault;
    delete cleaned.voiceRealtimeSessionBudgetUsd;
    // The rows are not repository entries — `repoProviders` below is what they
    // overlay onto (an `id: null` row means "clear", which a stored entry cannot
    // hold).
    const { providers: _providerRows, ...settings } = cleaned;

    // Adopt on save (D11a): a saved chain row declaring a model the registry
    // lacks is adopted in THIS write, decided inside the repository's lock
    // against the merged config (`adoptChainModelsOnSave`). Only a save that
    // writes a chain adopts — the legacy single row never materializes one.
    const skipAdoption =
      repoProviders !== undefined && patch.providers
        ? new Set(
            patch.providers.flatMap((row, index) =>
              row.id === null || row.id === '' ? [index] : [],
            ),
          )
        : undefined;
    let adoptedModels: AdoptedModel[] = [];
    const lookupCatalog = this.opts.lookupCatalog ?? lookupCatalogModel;

    await this.opts.config.update(
      {
        ...settings,
        ...mirror.fields,
        ...(repoProviders !== undefined ? { providers: repoProviders } : {}),
        ...(passthrough !== undefined ? { passthrough } : {}),
        ...(patch.voiceProvider !== undefined
          ? { voiceProvider: patch.voiceProvider || undefined }
          : {}),
        ...(patch.voiceApiKey !== undefined ? { voiceApiKey: patch.voiceApiKey || undefined } : {}),
        ...(patch.voiceBaseUrl !== undefined
          ? { voiceBaseUrl: patch.voiceBaseUrl || undefined }
          : {}),
        ...(patch.voiceModel !== undefined ? { voiceModel: patch.voiceModel || undefined } : {}),
        ...(patch.voiceTtsProvider !== undefined
          ? { voiceTtsProvider: patch.voiceTtsProvider || undefined }
          : {}),
        ...(patch.voiceTtsApiKey !== undefined
          ? { voiceTtsApiKey: patch.voiceTtsApiKey || undefined }
          : {}),
        ...(patch.voiceTtsVoice !== undefined
          ? { voiceTtsVoice: patch.voiceTtsVoice || undefined }
          : {}),
        ...(patch.voiceTtsBaseUrl !== undefined
          ? { voiceTtsBaseUrl: patch.voiceTtsBaseUrl || undefined }
          : {}),
        ...(patch.voiceTtsModel !== undefined
          ? { voiceTtsModel: patch.voiceTtsModel || undefined }
          : {}),
      },
      {
        ...(patch.providers !== undefined ? { providersVersion: patch.providersVersion } : {}),
        ...(skipAdoption !== undefined
          ? {
              beforeWrite: (next: RawConfig) => {
                const adoption = adoptChainModelsOnSave(next, skipAdoption, lookupCatalog);
                adoptedModels = adoption.adopted;
                return adoption.next;
              },
            }
          : {}),
      },
    );

    await this.deleteOrphanedSecrets([
      ...droppedSecretRefs,
      ...chainSecretRefs,
      ...topLevelChainSecretRefs(before),
    ]);
    try {
      await this.opts.onUpdated?.();
    } catch {
      // The write landed; a broken listener is not the caller's problem.
    }
    // B2: re-parse what this save actually wrote, so the response reports the
    // unknown keys the write kept (passthrough) but nothing will read.
    const { warnings } = await this.resolveEffective();
    return { adoptedModels, warnings };
  }

  /**
   * Replace the API key of one provider (`admin.rotateKey`): the top-level
   * `apiKey` when the top-level `provider` matches, and the `apiKey` of EVERY
   * chain entry whose `provider` matches. Every other field of every entry —
   * order, `region`, `apiVersion`, `passthrough`, the other entries' keys — is
   * the stored entry as the codec read it. The key reaches the file only as a
   * vault reference (`ConfigRepository.externalizeSecrets`). Pinned by
   * `__tests__/services/config-provider-chain.test.ts`.
   *
   * Refuses with `INVALID_INPUT` (HTTP 400) when nothing is configured for
   * `provider`, or when `key` is empty — an empty key would ERASE the stored
   * one — and with `CONFIG_CONFLICT` (409) when the chain changed between the
   * read and the write. Writes nothing in any of those cases.
   */
  async rotateProviderKey(provider: string, key: string): Promise<void> {
    const raw = await this.opts.config.read();
    if (!raw) {
      throw new EthosError({
        code: 'CONFIG_MISSING',
        cause: 'Config not found at ~/.ethos/config.yaml',
        action: 'Run onboarding from the web UI or `ethos setup` from the CLI.',
      });
    }
    if (!key) {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: 'The new key is empty.',
        action: 'Pass the new API key; nothing was changed.',
      });
    }
    const top = raw.provider === provider;
    const inChain = raw.providers.some((p) => p.provider === provider);
    if (!top && !inChain) {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: `No provider "${provider}" is configured, so there is no key to rotate.`,
        action: 'Name a provider from admin.getStatus, or add it in Settings first.',
      });
    }
    // Conditional on the chain this was built from, re-checked inside the
    // repository's write lock: a concurrent change refuses with
    // CONFIG_CONFLICT rather than overwriting it with this stale copy.
    await this.opts.config.update(
      {
        ...(top ? { apiKey: key } : {}),
        ...(inChain
          ? {
              providers: raw.providers.map((p) =>
                p.provider === provider ? { ...p, apiKey: key } : p,
              ),
            }
          : {}),
      },
      { providersVersion: providerChainVersion(raw.providers) },
    );
    await this.deleteOrphanedSecrets([
      ...(inChain ? providerChainSecretRefs(raw.providers) : []),
      ...(top ? topLevelChainSecretRefs(raw) : []),
    ]);
    try {
      await this.opts.onUpdated?.();
    } catch {
      // The write landed; a broken listener is not the caller's problem.
    }
  }

  /**
   * Drop vault entries whose last config reference was just removed.
   *
   * Runs AFTER the config write, never before: delete-first plus a failed
   * write leaves config referencing material that is gone, while write-first
   * leaves at worst vault litter. `ConfigRepository.deletePassthroughKeys` is
   * deliberately vault-blind — it is the shared "drop a config key" primitive —
   * so the deletion belongs here, alongside the caller that knows the key
   * carried a credential (same shape as PlatformsRepository's removals).
   *
   * Refs still named ANYWHERE in config.yaml or another operator-authored
   * file that can hold one (`ConfigRepository.secretRefsInUse`: mcp.json,
   * keys.json, `personalities/<id>/*.yaml`, …), even inside a longer value, are
   * kept: deleting one would break whatever names it. Webhook refs embed the webhook
   * id and chain refs an index, so a collision needs a hand-edited config.yaml
   * or two chain entries sharing a ref, but the check costs one read and the
   * failure mode it guards is a live credential deleted out from under its user.
   *
   * A failing delete propagates (ARCHITECTURE.md §V S7 — no silent failure).
   * The config change already landed; the error is how the operator learns
   * credential material was left behind.
   *
   * Public because `ModelRegistryService`'s provider writes (a replaced key, a
   * removed entry) end the same way and must not grow a second copy.
   */
  async deleteOrphanedSecrets(refs: string[]): Promise<void> {
    const secrets = this.opts.secrets;
    if (!secrets || refs.length === 0) return;
    const surviving = await this.opts.config.secretRefsInUse();
    for (const ref of new Set(refs)) {
      if (surviving.has(ref)) continue;
      await secrets.delete(ref);
    }
  }
}
