import type { RealtimeProviderEntry, SttProviderEntry, TtsProviderEntry } from '@ethosagent/types';
import {
  buildA2aConfig,
  buildCompaction,
  LOG_LEVELS,
  normalizeAuxEntryTimeout,
  parseBusyMode,
  parseCallStyle,
  parseStreamingEdits,
  parseToolPreviewLength,
  parseVerbosity,
} from './builders/agent';
import { buildBrowser, buildMcpConfig, buildToolLoop } from './builders/browser';
import { buildChannels, createChannelsCollector } from './builders/channels';
import { buildBackgroundConfig, buildCronConfig } from './builders/cron-background';
import { buildWeeklyDigest } from './builders/digest';
import { buildExecutionConfig } from './builders/execution';
import {
  buildChannelFilter,
  buildDiscordBackfill,
  buildGateway,
  buildGrounding,
  buildIdleWatcher,
  buildKanban,
  buildPauseClockCorrection,
  buildPauseLifecycleHttp,
  buildRestartLoopGuard,
} from './builders/gateway';
import { buildLearningReplayConfig } from './builders/learning';
import {
  buildMemoryApprovalConfig,
  buildMemoryCaptureConfig,
  buildMemoryConsolidationConfig,
  buildMemoryVaultConfig,
} from './builders/memory';
import { buildNodes } from './builders/nodes';
import {
  buildDiscordDefaultMode,
  buildSlackApps,
  buildTeamsConfig,
  buildTelegramBots,
  buildWhatsApps,
} from './builders/platforms';
import { buildPersonalitiesConfig, buildRetentionConfig } from './builders/retention';
import {
  buildBackupConfig,
  buildChannelDigestConfig,
  buildMemoryCharLimits,
  buildMemoryConsolidation,
  buildStorageConfig,
  storageEncryptionRemovedNotice,
} from './builders/storage';
import {
  buildChannelToolsets,
  buildPluginIsolation,
  buildQuickCommands,
  parseToolLoading,
} from './builders/tools';
import { parseBoundedFloat, parseBoundedInt, splitList } from './builders/utils';
import { buildWebhooks } from './builders/webhooks';
import type { EthosConfig } from './config-types';
import { buildDecisionsConfig, DECISIONS_LINE_RE } from './decisions';
import {
  type ActiveContext,
  normalizeWebSearchRecency,
  ownToolSettingsSlot,
  RESERVED_TOOL_SETTINGS_KEYS,
  type ToolSettingsMap,
} from './keys';
import { ConfigKeyUse } from './known-keys';
import {
  buildModelProfiles,
  buildModelRegistryFromLines,
  claimModelRegistryLine,
  newModelRegistryLineAcc,
} from './model-registry-config';
import {
  parseErrorsByConfig,
  parseWarningsByConfig,
  personalityDefaultedByConfig,
} from './notices';
import { buildNotificationsConfig } from './notifications';
import { isProviderChainLine, type ProviderConfig, parseProviderChain } from './provider-chain';
import { parseConfigScalar } from './scalar';
import {
  type AuxiliaryCompressionConfig,
  type AuxiliaryVisionConfig,
  type AuxiliaryWebConfig,
  type AwsConfig,
  type AwsSecretsConfig,
  DEFAULT_PERSONALITY_ID,
  type ModelCatalogConfig,
  type TelemetryConfig,
  type TelemetryLangfuseExportConfig,
  type TelemetryOtlpExportConfig,
  type WebConfig,
} from './section-types';
import {
  buildVoiceBargeIn,
  buildVoiceBots,
  buildVoiceInbound,
  buildVoiceLiveKit,
  buildVoiceProviderEntry,
  buildVoiceProviderRoster,
  buildVoiceTrunk,
  buildWakeNodes,
  buildWakeRoutes,
  isVoiceChannelPlatform,
  parseCallAccent,
  REALTIME_ENTRY_FIELDS,
  STT_ENTRY_FIELDS,
  TTS_ENTRY_FIELDS,
} from './voice';

/**
 * The ONE parser for `config.yaml`'s flat-key dialect.
 *
 * Exported because `readRawConfig` reads only `ethosDir()/config.yaml`, and a
 * host that owns its own data directory (apps/web-api's `opts.dataDir`) must
 * parse the file it actually reads rather than re-deriving a second, poorer
 * parser for the keys it happens to care about.
 */
export function parseConfigYaml(src: string): EthosConfig {
  // U4 — every map below whose keys are config.yaml keys is tracked, so the
  // unknown-key notice is derived from what this function actually reads.
  const keyUse = new ConfigKeyUse();
  const kv: Record<string, string> = keyUse.track('', {});
  const modelRouting: Record<string, string> = {};
  const pluginIsolationKv: Record<string, string> = {};
  const pluginIsolationOverridesKv: Record<string, string> = {};
  const toolSettings: ToolSettingsMap = {};
  const activeContextKv: Record<string, string> = keyUse.track('activeContext.', {});
  const retentionKv: Record<string, string> = keyUse.track('retention.', {});
  const personalitiesRetKv: Record<string, Record<string, string>> = {};
  const displayKv: Record<string, string> = keyUse.track('display.', {});
  const evolverKv: Record<string, string> = keyUse.track('evolver.', {});
  const backgroundKv: Record<string, string> = keyUse.track('background.', {});
  /** `background.acp.agents.<name>.<field>` — the named ACP-agent roster (T4/I3). */
  const backgroundAcpAgentsKv: Record<string, Record<string, string>> = {};
  // The `cron:` section: `fireUrl` / `maxParallelJobs` / `defaultMaxRunMs`.
  const cronKv: Record<string, string> = keyUse.track('cron.', {});
  // U11 — `notifications.quietHours` / `.timezone`, and the per-bot overrides.
  const notificationsKv: Record<string, string> = keyUse.track('notifications.', {});
  const notificationBotsKv: Record<string, Record<string, string>> = keyUse.trackIndexed(
    'notifications.bots.',
    {},
  );
  const auxiliaryCompressionKv: Record<string, string> = keyUse.track('auxiliary.compression.', {});
  const auxiliaryVisionKv: Record<string, string> = keyUse.track('auxiliary.vision.', {});
  const auxiliaryWebKv: Record<string, string> = keyUse.track('auxiliary.web.', {});
  const auxiliaryAsrKv: Record<string, string> = keyUse.track('auxiliary.asr.', {});
  const auxiliaryTtsKv: Record<string, string> = keyUse.track('auxiliary.tts.', {});
  const webKv: Record<string, string> = keyUse.track('web.', {});
  const modelCatalogKv: Record<string, string> = keyUse.track('modelCatalog.', {});
  const modelCatalogProvidersKv: Record<string, Record<string, string>> = {};
  // What the registry codec dropped and why — filed under `parseWarningsByConfig`
  // beside `providerNotices`, the same channel `parseProviderChain` uses.
  const modelRegistryNotices: string[] = [];
  // D2 — every `modelRegistry.*` line, claimed by `claimModelRegistryLine`, the
  // one reader apps/web-api's ConfigRepository shares via `parseModelRegistry`.
  const modelRegistryLines = newModelRegistryLineAcc(modelRegistryNotices);
  // §7 — models.<providerId>/<modelId>.<field>: <value>. Keyed by the full
  // `<providerId>/<modelId>` string; field path → raw value.
  const modelsKv: Record<string, Record<string, string>> = {};
  // §5 — global compaction.<field>: <value> (pressure | target | ...flags).
  const compactionKv: Record<string, string> = keyUse.track('compaction.', {});
  // memory.charLimits.<memory|user>: <chars> — markdown-backend per-key ceilings.
  const memoryCharLimitsKv: Record<string, string> = keyUse.track('memory.charLimits.', {});
  // execution.docker.<cpu|diskMb|image>: <value> — container caps + the sandbox image.
  const executionDockerKv: Record<string, string> = keyUse.track('execution.docker.', {});
  // execution.ssh.<field>: <value> — the deployment's single remote target.
  const executionSshKv: Record<string, string> = keyUse.track('execution.ssh.', {});
  // execution.allowLocalFallback: <bool> — S6 / D3 opt-in to host fallback.
  // Tracked so a typo of it gets this key as its suggestion (U4).
  const executionFlagsKv: Record<string, string> = keyUse.track('execution.', {});
  // kanban.<maxInProgress|maxInProgressPerProfile>: <n> — board WIP caps.
  const kanbanKv: Record<string, string> = keyUse.track('kanban.', {});
  // grounding.<field>: <value> — ground-truth verification policy. The nested
  // `grounding.kanban.*` keys get their own map so the two levels cannot
  // collide on a shared field name.
  const groundingKv: Record<string, string> = keyUse.track('grounding.', {});
  const groundingKanbanKv: Record<string, string> = keyUse.track('grounding.kanban.', {});
  // toolLoop.<field>: <n> — the loop's hard tool caps and their soft-warn tiers.
  const toolLoopKv: Record<string, string> = keyUse.track('toolLoop.', {});
  // mcp.discoveryConcurrency: <1-16> — the MCP discovery connect pool.
  const mcpKv: Record<string, string> = keyUse.track('mcp.', {});
  // browser.<field>: <value> — Playwright budgets plus launch posture. The
  // nested keys are stored under their DOTTED sub-path (`proxy.server`,
  // `stealth.enabled`) rather than in per-level maps: no flat key contains a
  // dot, so the two levels cannot collide on one map.
  const browserKv: Record<string, string> = keyUse.track('browser.', {});
  // gateway.<field>: <value> — gateway-wide, non-credential knobs.
  const gatewayKv: Record<string, string> = keyUse.track('gateway.', {});
  // gateway.private_chats.<platform>: <chatId,...> — trusted rooms (D9).
  const privateChatsKv: Record<string, string> = keyUse.track('gateway.private_chats.', {});
  const channels = createChannelsCollector();
  // decisions.<field>: <value> — the decision provider, stored under the
  // dotted sub-path (`sites.injection`, `thresholds.approver.deny`).
  const decisionsKv: Record<string, string> = keyUse.track('decisions.', {});
  // teamSupervisor.restartLoopGuard.<field>: <n> — member auto-restart brake.
  // Unset = 5 respawns in 60s (one more than the old hardcoded four).
  const restartLoopGuardKv: Record<string, string> = keyUse.track(
    'teamSupervisor.restartLoopGuard.',
    {},
  );
  // discord.missedMessageBackfill.<field>: <value> — channel-history backfill.
  const discordBackfillKv: Record<string, string> = keyUse.track(
    'discord.missedMessageBackfill.',
    {},
  );
  // discord.<field>: <value> — non-backfill Discord knobs (defaultChannelMode).
  const discordKv: Record<string, string> = keyUse.track('discord.', {});
  // Call-capture personality binding (decision 3) — callCapture.personalityId: <id>.
  const callCaptureKv: Record<string, string> = keyUse.track('callCapture.', {});
  // Phase 3 — memoryConsolidation.<field>: <value> (silent flush config).
  const memoryConsolidationKv: Record<string, string> = keyUse.track('memoryConsolidation.', {});
  // Scale-to-zero idle watcher — idleWatcher.<field>: <value>.
  const idleWatcherKv: Record<string, string> = keyUse.track('idleWatcher.', {});
  const nodesKv: Record<string, string> = keyUse.track('nodes.', {}); // laptop tool nodes (D18)
  // Resume-side clock correction — pauseClockCorrection.<field>: <value>.
  const pauseClockCorrectionKv: Record<string, string> = keyUse.track('pauseClockCorrection.', {});
  // Pause/resume lifecycle notifications — pauseLifecycle.http.<field>: <value>.
  const pauseLifecycleHttpKv: Record<string, string> = keyUse.track('pauseLifecycle.http.', {});
  const logsRotationKv: Record<string, string> = keyUse.track('logs.rotation.', {});
  const awsSecretsKv: Record<string, string> = keyUse.track('aws.secrets.', {});
  const telemetryLangfuseKv: Record<string, string> = keyUse.track(
    'telemetry.export.langfuse.',
    {},
  );
  const telemetryOtlpKv: Record<string, string> = keyUse.track('telemetry.export.otlp.', {});
  // Header names are free-form (dots, dashes, any case), so they get their
  // own map behind the longer prefix rather than riding `telemetryOtlpKv`.
  const telemetryOtlpHeadersKv: Record<string, string> = keyUse.track(
    'telemetry.export.otlp.headers.',
    {},
  );
  // Indexed list shapes: telegram.bots.<n>.<field> and slack.apps.<n>.<field>,
  // plus their nested `.bind.<field>` sub-keys. Per-team config keyed by name.
  const telegramBotsKv: Record<number, Record<string, string>> = keyUse.trackIndexed(
    'telegram.bots.',
    {},
  );
  const slackAppsKv: Record<number, Record<string, string>> = keyUse.trackIndexed(
    'slack.apps.',
    {},
  );
  const whatsappKv: Record<number, Record<string, string>> = keyUse.trackIndexed('whatsapp.', {});
  const voiceBotsKv: Record<number, Record<string, string>> = keyUse.trackIndexed(
    'voice.bots.',
    {},
  );
  const voiceLiveKitKv: Record<string, string> = keyUse.track('voice.livekit.', {});
  const voiceTrunkKv: Record<string, string> = keyUse.track('voice.trunk.', {});
  /** `voice.inbound.<field>` — the scalar inbound-call policy knobs. */
  const voiceInboundKv: Record<string, string> = keyUse.track('voice.inbound.', {});
  /** `voice.inbound.owner.<field>` — the notification destination, one level down. */
  const voiceInboundOwnerKv: Record<string, string> = keyUse.track('voice.inbound.owner.', {});
  /** `voice.bargeIn.<surface>.<field>` — VAD thresholds, keyed by surface. */
  const voiceBargeInKv: Record<string, Record<string, string>> = {};
  /** `voice.filler.<field>` — the tool-call filler/tick knobs, range-checked on the way in. */
  const voiceFillerKv: {
    enabled?: boolean;
    afterMs?: number;
    text?: string;
    tickIntervalMs?: number;
  } = {};
  /** `voice.tts.providers.<name>.<field>` — the named TTS roster, keyed by name. */
  const voiceTtsProvidersKv: Record<string, Record<string, string>> = {};
  /** The older `voice.providers.<name>.<field>` spelling, merged under the above. */
  const voiceTtsProvidersLegacyKv: Record<string, Record<string, string>> = {};
  /** `voice.stt.providers.<name>.<field>` — the named STT roster. */
  const voiceSttProvidersKv: Record<string, Record<string, string>> = {};
  /** `voice.realtime.providers.<name>.<field>` — the named realtime roster. */
  const voiceRealtimeProvidersKv: Record<string, Record<string, string>> = {};
  /** Raw `voice.trustedPlugins` line; `undefined` = key absent = gate off. */
  let voiceTrustedPluginsRaw: string | undefined;
  /** `voice.defaultMode`; `undefined` = key absent = the built-in default. */
  let voiceDefaultMode: 'off' | 'mirror_inbound' | 'all' | undefined;
  /** `voice.tier`; `undefined` = key absent = the surface decides. */
  let voiceTier: 'pipeline' | 'realtime' | undefined;
  /** `voice.realtime.default` — names a realtime roster entry. */
  let voiceRealtimeDefault: string | undefined;
  /** `voice.realtime.sessionBudgetUsd` — USD cap on one session's accrued cost. */
  let voiceRealtimeSessionBudgetUsd: number | undefined;
  /** `voice.channels.<platform>.ttsOut` — per-channel TTS-out overrides. */
  const voiceChannelsKv: Record<string, { ttsOut?: boolean }> = {};
  /** `voice.transcode.<field>` — ffmpeg stage knobs, range-checked on the way in. */
  const voiceTranscodeKv: { ffmpegPath?: string; bitrateKbps?: number; timeout?: number } = {};
  /** `voice.artifacts.<field>` — retention bounds, range-checked on the way in. */
  const voiceArtifactsKv: { abandonAfterDays?: number; maxTotalMb?: number } = {};
  /** `voice.wake.<field>` — satellite wake knobs, range-checked on the way in. */
  const voiceWakeKv: {
    enabled?: boolean;
    engine?: 'fallback' | 'sherpa' | 'openwakeword';
    sensitivity?: number;
    confirmationFrames?: number;
    edgeStt?: boolean;
    idleTimeout?: number;
  } = {};
  /** `voice.wake.routes.<id>.<field>` — raw route fields, keyed by route id. */
  const voiceWakeRoutesKv: Record<string, Record<string, string>> = {};
  /** `voice.wake.nodes.<id>.<field>` — per-satellite overrides, keyed by node id. */
  const voiceWakeNodesKv: Record<string, Record<string, string>> = {};
  const teamsKv: Record<string, Record<string, string>> = {};
  const webhooksKv: Record<string, Record<string, string>> = {};
  // FW-16 — quick_commands.<name>.<field>: <value>
  const qcKv: Record<string, Record<string, string>> = {};
  // Context-economy Phase 1 — channel_toolsets.<platform>: <tool,list>
  const channelToolsetsKv: Record<string, string> = {};
  // Chapter 1 safety: channel_filter.<platform>.<field>: <value>
  const channelFilterKv: Record<string, Record<string, string>> = {};
  // B2 — `lineIdx` is 0-based; warnings print the 1-based line number.
  for (const [lineIdx, line] of src.split('\n').entries()) {
    // telegram.bots.<index>.bind.<field>: <value>
    const tbind = line.match(/^telegram\.bots\.(\d+)\.bind\.(\S+):\s*(.+)$/);
    if (tbind) {
      const idx = Number(tbind[1]);
      telegramBotsKv[idx] ??= {};
      telegramBotsKv[idx][`bind.${tbind[2]}`] = parseConfigScalar(tbind[3]);
      continue;
    }
    // telegram.bots.<index>.<field>: <value>
    const tbot = line.match(/^telegram\.bots\.(\d+)\.(\S+):\s*(.+)$/);
    if (tbot) {
      const idx = Number(tbot[1]);
      telegramBotsKv[idx] ??= {};
      telegramBotsKv[idx][tbot[2]] = parseConfigScalar(tbot[3]);
      continue;
    }
    // slack.apps.<index>.bind.<field>: <value>
    const sbind = line.match(/^slack\.apps\.(\d+)\.bind\.(\S+):\s*(.+)$/);
    if (sbind) {
      const idx = Number(sbind[1]);
      slackAppsKv[idx] ??= {};
      slackAppsKv[idx][`bind.${sbind[2]}`] = parseConfigScalar(sbind[3]);
      continue;
    }
    // slack.apps.<index>.<field>: <value>
    const sapp = line.match(/^slack\.apps\.(\d+)\.(\S+):\s*(.+)$/);
    if (sapp) {
      const idx = Number(sapp[1]);
      slackAppsKv[idx] ??= {};
      slackAppsKv[idx][sapp[2]] = parseConfigScalar(sapp[3]);
      continue;
    }
    // whatsapp.<index>.bind.<field>: <value>
    const wabind = line.match(/^whatsapp\.(\d+)\.bind\.(\S+):\s*(.+)$/);
    if (wabind) {
      const idx = Number(wabind[1]);
      whatsappKv[idx] ??= {};
      whatsappKv[idx][`bind.${wabind[2]}`] = parseConfigScalar(wabind[3]);
      continue;
    }
    // whatsapp.<index>.<field>: <value>
    const wa = line.match(/^whatsapp\.(\d+)\.(\S+):\s*(.+)$/);
    if (wa) {
      const idx = Number(wa[1]);
      whatsappKv[idx] ??= {};
      whatsappKv[idx][wa[2]] = parseConfigScalar(wa[3]);
      continue;
    }
    // voice.bots.<index>.bind.<field>: <value>
    const vbind = line.match(/^voice\.bots\.(\d+)\.bind\.(\S+):\s*(.+)$/);
    if (vbind) {
      const idx = Number(vbind[1]);
      voiceBotsKv[idx] ??= {};
      voiceBotsKv[idx][`bind.${vbind[2]}`] = parseConfigScalar(vbind[3]);
      continue;
    }
    // voice.bots.<index>.<field>: <value>
    const vbot = line.match(/^voice\.bots\.(\d+)\.(\S+):\s*(.+)$/);
    if (vbot) {
      const idx = Number(vbot[1]);
      voiceBotsKv[idx] ??= {};
      voiceBotsKv[idx][vbot[2]] = parseConfigScalar(vbot[3]);
      continue;
    }
    // voice.<tts|stt|realtime>.providers.<name>.<field>: <value> — the named
    // rosters. The name is anchored to the identifier charset so the split is
    // unambiguous and the last level is a plain field, exactly the way
    // `telegram.bots.<n>.<field>` is matched. One regex serves all three rosters
    // so they cannot acquire different name rules.
    const vprov = line.match(
      /^voice\.(tts|stt|realtime)\.providers\.([A-Za-z0-9_-]+)\.(\w+):\s*(.+)$/,
    );
    if (vprov) {
      const bag =
        vprov[1] === 'stt'
          ? voiceSttProvidersKv
          : vprov[1] === 'realtime'
            ? voiceRealtimeProvidersKv
            : voiceTtsProvidersKv;
      const name = vprov[2];
      bag[name] ??= {};
      bag[name][vprov[3]] = parseConfigScalar(vprov[4]);
      continue;
    }
    // voice.realtime.default / voice.realtime.sessionBudgetUsd. Matched AFTER
    // the roster line above, whose third level is `providers` and whose tail
    // carries dots — so this `(\w+)` can never swallow a roster key.
    const vrt = line.match(/^voice\.realtime\.(\w+):\s*(.+)$/);
    if (vrt) {
      const value = parseConfigScalar(vrt[2]);
      if (vrt[1] === 'default') {
        voiceRealtimeDefault = value;
      } else if (vrt[1] === 'sessionBudgetUsd') {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) voiceRealtimeSessionBudgetUsd = n;
      }
      continue;
    }
    // voice.providers.<name>.<field> — the OLDER spelling of the TTS roster,
    // from before STT had one. Read-time alias only: it is merged UNDER the new
    // spelling below (so a file carrying both is decided by the key, not by
    // line order) and re-serializes as `voice.tts.providers.*`.
    const vprovLegacy = line.match(/^voice\.providers\.([A-Za-z0-9_-]+)\.(\w+):\s*(.+)$/);
    if (vprovLegacy) {
      const name = vprovLegacy[1];
      voiceTtsProvidersLegacyKv[name] ??= {};
      voiceTtsProvidersLegacyKv[name][vprovLegacy[2]] = parseConfigScalar(vprovLegacy[3]);
      continue;
    }
    // voice.livekit.<field>: <value>
    const vlk = line.match(/^voice\.livekit\.(\w+):\s*(.+)$/);
    if (vlk) {
      voiceLiveKitKv[vlk[1]] = parseConfigScalar(vlk[2]);
      continue;
    }
    // voice.trunk.<field>: <value>
    const vtr = line.match(/^voice\.trunk\.(\w+):\s*(.+)$/);
    if (vtr) {
      voiceTrunkKv[vtr[1]] = parseConfigScalar(vtr[2]);
      continue;
    }
    // voice.inbound.owner.<field>: <value> — matched BEFORE the scalar line
    // below, which the `\w+` in its key position could not have swallowed
    // anyway; the order is what makes that safe to read rather than to prove.
    const vino = line.match(/^voice\.inbound\.owner\.(\w+):\s*(.+)$/);
    if (vino) {
      voiceInboundOwnerKv[vino[1]] = parseConfigScalar(vino[2]);
      continue;
    }
    // voice.inbound.<field>: <value>
    const vin = line.match(/^voice\.inbound\.(\w+):\s*(.+)$/);
    if (vin) {
      voiceInboundKv[vin[1]] = parseConfigScalar(vin[2]);
      continue;
    }
    // voice.bargeIn.<surface>.<field>: <value>. The surface is anchored to the
    // identifier charset and validated by name in the builder — an unknown
    // surface is a parse error, not a dropped line, because a threshold typed
    // against a surface nothing reads is silently no tuning at all.
    const vbi = line.match(/^voice\.bargeIn\.([A-Za-z0-9_-]+)\.(\w+):\s*(.+)$/);
    if (vbi) {
      const surface = vbi[1];
      voiceBargeInKv[surface] ??= {};
      voiceBargeInKv[surface][vbi[2]] = parseConfigScalar(vbi[3]);
      continue;
    }
    // voice.filler.<field> — the tool-call keep-alive knobs. An unknown value
    // is ignored rather than clamped or thrown on, same rule as `voice.wake`.
    const vfl = line.match(/^voice\.filler\.(\w+):\s*(.+)$/);
    if (vfl) {
      const field = vfl[1];
      const value = parseConfigScalar(vfl[2]);
      if (field === 'enabled') {
        if (value === 'true' || value === 'false') voiceFillerKv.enabled = value === 'true';
      } else if (field === 'afterMs') {
        const n = parseBoundedInt(value, 0, 60_000);
        if (n !== undefined) voiceFillerKv.afterMs = n;
      } else if (field === 'text') {
        if (value) voiceFillerKv.text = value;
      } else if (field === 'tickIntervalMs') {
        const n = parseBoundedInt(value, 0, 60_000);
        if (n !== undefined) voiceFillerKv.tickIntervalMs = n;
      }
      continue;
    }
    // voice.trustedPlugins: <comma-separated provider ids>. Declaring the key
    // AT ALL turns the local-only egress gate on, so an empty value is
    // meaningful (= trust nothing non-local) and must not collapse to absent.
    const vtp = line.match(/^voice\.trustedPlugins:\s*(.*)$/);
    if (vtp) {
      voiceTrustedPluginsRaw = parseConfigScalar(vtp[1]);
      continue;
    }
    // voice.defaultMode: off | mirror_inbound | all — where a new lane starts.
    const vdm = line.match(/^voice\.defaultMode:\s*(.+)$/);
    if (vdm) {
      const mode = parseConfigScalar(vdm[1]);
      if (mode === 'off' || mode === 'mirror_inbound' || mode === 'all') {
        voiceDefaultMode = mode;
      }
      continue;
    }
    // voice.tier: pipeline | realtime — the deployment's default voice engine.
    // An unknown value is ignored rather than thrown on, exactly like the mode
    // above: a typo here must not make the whole config unloadable.
    const vtier = line.match(/^voice\.tier:\s*(.+)$/);
    if (vtier) {
      const tier = parseConfigScalar(vtier[1]);
      if (tier === 'pipeline' || tier === 'realtime') voiceTier = tier;
      continue;
    }
    // voice.channels.<platform>.ttsOut: true | false — which channels speak
    // their replies without being asked. Only the platforms in
    // VOICE_CHANNEL_PLATFORMS are accepted; an unknown id or a non-boolean is
    // dropped, so a typo cannot invent a channel entry no adapter will read.
    const vch = line.match(/^voice\.channels\.([A-Za-z0-9_-]+)\.ttsOut:\s*(.+)$/);
    if (vch) {
      const platform = vch[1];
      const value = parseConfigScalar(vch[2]);
      if (isVoiceChannelPlatform(platform) && (value === 'true' || value === 'false')) {
        voiceChannelsKv[platform] = { ttsOut: value === 'true' };
      }
      continue;
    }
    // voice.transcode.<field> — ffmpeg stage. Out-of-range or non-numeric
    // values are ignored, same rule as the mode and tier above.
    const vtc = line.match(/^voice\.transcode\.(\w+):\s*(.+)$/);
    if (vtc) {
      const value = parseConfigScalar(vtc[2]);
      if (vtc[1] === 'ffmpegPath') {
        if (value) voiceTranscodeKv.ffmpegPath = value;
      } else if (vtc[1] === 'bitrateKbps') {
        const n = parseBoundedInt(value, 8, 320);
        if (n !== undefined) voiceTranscodeKv.bitrateKbps = n;
      } else if (vtc[1] === 'timeout') {
        const n = parseBoundedInt(value, 1, 600);
        if (n !== undefined) voiceTranscodeKv.timeout = n;
      }
      continue;
    }
    // voice.artifacts.<field> — retention for synthesized voice artifacts.
    const vart = line.match(/^voice\.artifacts\.(\w+):\s*(.+)$/);
    if (vart) {
      const value = parseConfigScalar(vart[2]);
      if (vart[1] === 'abandonAfterDays') {
        const n = parseBoundedInt(value, 1, 365);
        if (n !== undefined) voiceArtifactsKv.abandonAfterDays = n;
      } else if (vart[1] === 'maxTotalMb') {
        const n = parseBoundedInt(value, 1, 102400);
        if (n !== undefined) voiceArtifactsKv.maxTotalMb = n;
      }
      continue;
    }
    // voice.wake.routes.<id>.<field> / voice.wake.nodes.<id>.<field> — the two
    // record-valued wake sub-blocks. One regex serves both so they cannot
    // acquire different id rules, and the id is anchored to the identifier
    // charset exactly like a provider roster name: a key the serializer could
    // not round-trip is dropped here rather than corrupting the file later.
    // Matched BEFORE the scalar `voice.wake.<field>` line below.
    const vwrec = line.match(/^voice\.wake\.(routes|nodes)\.([A-Za-z0-9_-]+)\.(\w+):\s*(.+)$/);
    if (vwrec) {
      const bag = vwrec[1] === 'routes' ? voiceWakeRoutesKv : voiceWakeNodesKv;
      const id = vwrec[2];
      bag[id] ??= {};
      bag[id][vwrec[3]] = parseConfigScalar(vwrec[4]);
      continue;
    }
    // voice.wake.<field> — the scalar satellite knobs. An unknown engine and an
    // out-of-range number are ignored rather than clamped or thrown on, same
    // rule as the mode and tier above.
    const vwk = line.match(/^voice\.wake\.(\w+):\s*(.+)$/);
    if (vwk) {
      const field = vwk[1];
      const value = parseConfigScalar(vwk[2]);
      if (field === 'enabled') {
        if (value === 'true' || value === 'false') voiceWakeKv.enabled = value === 'true';
      } else if (field === 'edgeStt') {
        if (value === 'true' || value === 'false') voiceWakeKv.edgeStt = value === 'true';
      } else if (field === 'engine') {
        if (value === 'fallback' || value === 'sherpa' || value === 'openwakeword') {
          voiceWakeKv.engine = value;
        }
      } else if (field === 'sensitivity') {
        const n = parseBoundedFloat(value, 0, 1);
        if (n !== undefined) voiceWakeKv.sensitivity = n;
      } else if (field === 'confirmationFrames') {
        const n = parseBoundedInt(value, 1, 10);
        if (n !== undefined) voiceWakeKv.confirmationFrames = n;
      } else if (field === 'idleTimeout') {
        const n = parseBoundedInt(value, 5, 600);
        if (n !== undefined) voiceWakeKv.idleTimeout = n;
      }
      continue;
    }
    // teams.<name>.<field>: <value>
    const tcfg = line.match(/^teams\.([^.]+)\.(\S+):\s*(.+)$/);
    if (tcfg) {
      const name = tcfg[1];
      teamsKv[name] ??= {};
      teamsKv[name][tcfg[2]] = parseConfigScalar(tcfg[3]);
      continue;
    }
    // webhooks.<hookId>.<field>: <value>
    const whook = line.match(/^webhooks\.([^.]+)\.(\S+):\s*(.+)$/);
    if (whook) {
      const hookId = whook[1];
      webhooksKv[hookId] ??= {};
      webhooksKv[hookId][whook[2]] = parseConfigScalar(whook[3]);
      continue;
    }
    // providers.<index>.<field>: <value> — parsed after the loop, whole-file,
    // by `parseProviderChain`, the one reader of this namespace.
    if (isProviderChainLine(line)) continue;
    // personalities.<id>.retention.<field>: <value>  (must come before modelRouting)
    const perp = line.match(/^personalities\.([^.]+)\.retention\.(events\.)?(\w+):\s*(.+)$/);
    if (perp) {
      const pid = perp[1];
      const key = `${perp[2] ?? ''}${perp[3]}`;
      personalitiesRetKv[pid] ??= {};
      personalitiesRetKv[pid][key] = parseConfigScalar(perp[4]);
      continue;
    }
    // retention.<field>: <value>  or  retention.events.<subfield>: <value>
    const ret = line.match(/^retention\.(events\.)?(\w+):\s*(.+)$/);
    if (ret) {
      retentionKv[`${ret[1] ?? ''}${ret[2]}`] = parseConfigScalar(ret[3]);
      continue;
    }
    // display.<field>: <value>
    const disp = line.match(/^display\.([a-z_]+):\s*(.+)$/);
    if (disp) {
      displayKv[disp[1]] = parseConfigScalar(disp[2]);
      continue;
    }
    // evolver.<field>: <value>
    const evlv = line.match(/^evolver\.([a-z_]+):\s*(.+)$/);
    if (evlv) {
      evolverKv[evlv[1]] = parseConfigScalar(evlv[2]);
      continue;
    }
    // background.acp.agents.<name>.<field>: <value> — the named ACP-agent
    // roster. Matched BEFORE the single-level `background.<field>` line below,
    // whose `[a-z_]+` cannot swallow a dotted key anyway, but ordering mirrors
    // the voice roster's own "roster before general" discipline.
    const bacp = line.match(/^background\.acp\.agents\.([A-Za-z0-9_-]+)\.(\w+):\s*(.+)$/);
    if (bacp) {
      const name = bacp[1];
      backgroundAcpAgentsKv[name] ??= {};
      backgroundAcpAgentsKv[name][bacp[2]] = parseConfigScalar(bacp[3]);
      continue;
    }
    // background.<field>: <value>
    const bg = line.match(/^background\.([a-z_]+):\s*(.+)$/);
    if (bg) {
      backgroundKv[bg[1]] = parseConfigScalar(bg[2]);
      continue;
    }
    // cron.fireUrl: <url>  — presence is the local/external mode switch.
    const cronFire = line.match(/^cron\.fireUrl:\s*(.+)$/);
    if (cronFire) {
      cronKv.fireUrl = parseConfigScalar(cronFire[1]);
      continue;
    }
    // cron.maxParallelJobs: <n>  (scalar sibling of cron.fireUrl)
    const cronMax = line.match(/^cron\.maxParallelJobs:\s*(.+)$/);
    if (cronMax) {
      cronKv.maxParallelJobs = parseConfigScalar(cronMax[1]);
      continue;
    }
    // notifications.bots.<botKey>.<field>: <value>  (U11 — per-bot override)
    const notifBot = line.match(/^notifications\.bots\.([A-Za-z0-9_-]+)\.(\w+):\s*(.+)$/);
    if (notifBot) {
      notificationBotsKv[notifBot[1]] ??= {};
      const entry = notificationBotsKv[notifBot[1]];
      if (entry) entry[notifBot[2]] = parseConfigScalar(notifBot[3]);
      continue;
    }
    // notifications.<field>: <value>  (U11 — quietHours, timezone)
    const notif = line.match(/^notifications\.(\w+):\s*(.+)$/);
    if (notif) {
      notificationsKv[notif[1]] = parseConfigScalar(notif[2]);
      continue;
    }
    // cron.defaultMaxRunMs: <ms>  (R10 — per-run wall-clock default)
    const cronMaxRun = line.match(/^cron\.defaultMaxRunMs:\s*(.+)$/);
    if (cronMaxRun) {
      cronKv.defaultMaxRunMs = parseConfigScalar(cronMaxRun[1]);
      continue;
    }
    // auxiliary.compression.<field>: <value>
    const auxc = line.match(/^auxiliary\.compression\.(\w+):\s*(.+)$/);
    if (auxc) {
      auxiliaryCompressionKv[auxc[1]] = parseConfigScalar(auxc[2]);
      continue;
    }
    // auxiliary.vision.<field>: <value>
    const auxv = line.match(/^auxiliary\.vision\.(\w+):\s*(.+)$/);
    if (auxv) {
      auxiliaryVisionKv[auxv[1]] = parseConfigScalar(auxv[2]);
      continue;
    }
    // auxiliary.web.<field>: <value>
    const auxw = line.match(/^auxiliary\.web\.(\w+):\s*(.+)$/);
    if (auxw) {
      auxiliaryWebKv[auxw[1]] = parseConfigScalar(auxw[2]);
      continue;
    }
    // auxiliary.asr.<field>: <value>
    const auxAsr = line.match(/^auxiliary\.asr\.(\w+):\s*(.+)$/);
    if (auxAsr) {
      auxiliaryAsrKv[auxAsr[1]] = parseConfigScalar(auxAsr[2]);
      continue;
    }
    // auxiliary.tts.<field>: <value>
    const auxTts = line.match(/^auxiliary\.tts\.(\w+):\s*(.+)$/);
    if (auxTts) {
      auxiliaryTtsKv[auxTts[1]] = parseConfigScalar(auxTts[2]);
      continue;
    }
    // web.searxng.url: <url>  — two levels deep, so the `web.<\w+>` branch
    // below cannot see it. Stored under its dotted sub-path in the same map.
    const searx = line.match(/^web\.searxng\.url:\s*(.+)$/);
    if (searx) {
      webKv['searxng.url'] = parseConfigScalar(searx[1]);
      continue;
    }
    // web.<field>: <value>
    const web = line.match(/^web\.(\w+):\s*(.+)$/);
    if (web) {
      webKv[web[1]] = parseConfigScalar(web[2]);
      continue;
    }
    // logs.rotation.<field>: <value>
    const lr = line.match(/^logs\.rotation\.(\w+):\s*(.+)$/);
    if (lr) {
      logsRotationKv[lr[1]] = parseConfigScalar(lr[2]);
      continue;
    }
    // logs.level: <debug|info|warn|error>
    const ll = line.match(/^logs\.level:\s*(.+)$/);
    if (ll) {
      kv['logs.level'] = parseConfigScalar(ll[1]);
      continue;
    }
    // aws.secrets.<field>: <value>
    const awss = line.match(/^aws\.secrets\.(\w+):\s*(.+)$/);
    if (awss) {
      awsSecretsKv[awss[1]] = parseConfigScalar(awss[2]);
      continue;
    }
    // telemetry.export.langfuse.<field>: <value>
    const tel = line.match(/^telemetry\.export\.langfuse\.(\w+):\s*(.+)$/);
    if (tel) {
      telemetryLangfuseKv[tel[1]] = parseConfigScalar(tel[2]);
      continue;
    }
    // telemetry.export.otlp.headers.<Name>: <value> — matched before the
    // scalar rule below, whose `\w+` would drop a dashed or dotted header
    // name. Header names cannot contain `:` (RFC 9110 token), so matching
    // the name up to the first colon is exact.
    const otlpHeader = line.match(/^telemetry\.export\.otlp\.headers\.([^:\s]+):\s*(.+)$/);
    if (otlpHeader) {
      telemetryOtlpHeadersKv[otlpHeader[1]] = parseConfigScalar(otlpHeader[2]);
      continue;
    }
    // telemetry.export.otlp.<field>: <value>
    const otlpLine = line.match(/^telemetry\.export\.otlp\.(\w+):\s*(.+)$/);
    if (otlpLine) {
      telemetryOtlpKv[otlpLine[1]] = parseConfigScalar(otlpLine[2]);
      continue;
    }
    // modelCatalog.providers.<id>.url: <value>
    const mcp = line.match(/^modelCatalog\.providers\.([^.]+)\.(\S+):\s*(.+)$/);
    if (mcp) {
      const providerId = mcp[1];
      modelCatalogProvidersKv[providerId] ??= {};
      modelCatalogProvidersKv[providerId][mcp[2]] = parseConfigScalar(mcp[3]);
      continue;
    }
    // modelCatalog.<field>: <value>
    const mc = line.match(/^modelCatalog\.(\w+):\s*(.+)$/);
    if (mc) {
      modelCatalogKv[mc[1]] = parseConfigScalar(mc[2]);
      continue;
    }
    // modelRegistry.* (D2) — the grammar lives in `claimModelRegistryLine`.
    if (claimModelRegistryLine(line, modelRegistryLines)) continue;
    // models.<providerId>/<modelId>.<field>: <value>  (§7 per-model profile).
    // The model key is greedy `.+` so ids containing `/` and `.` round-trip;
    // the trailing field is one of a fixed set, anchored so the split is
    // unambiguous.
    const mdl = line.match(
      /^models\.(.+)\.(sampling\.(?:temperature|topP|topK|minP)|toolCallFormat|maxOutputTokens):\s*(.+)$/,
    );
    if (mdl) {
      const modelKey = mdl[1];
      modelsKv[modelKey] ??= {};
      modelsKv[modelKey][mdl[2]] = parseConfigScalar(mdl[3]);
      continue;
    }
    // §5 / Phase 3 — compaction.<field>: <value>  (global gate + turn-end flags).
    const cmp = line.match(
      /^compaction\.(pressure|target|gateDelta|autoCompact|retryOnOverflow|abortOnSummaryFailure|smallWindow|maxContextTokens|minTailUserMessages):\s*(.+)$/,
    );
    if (cmp) {
      compactionKv[cmp[1]] = parseConfigScalar(cmp[2]);
      continue;
    }
    // Call-capture personality binding (decision 3) — callCapture.personalityId: <id>
    const ccap = line.match(/^callCapture\.personalityId:\s*(.+)$/);
    if (ccap) {
      callCaptureKv.personalityId = parseConfigScalar(ccap[1]);
      continue;
    }
    // Phase 3 — memoryConsolidation.<field>: <value>  (silent flush config).
    const mcz = line.match(
      /^memoryConsolidation\.(enabled|flushThreshold|timeboxMs|maxTokens|maxDeltaChars|minMessagesSinceFlush):\s*(.+)$/,
    );
    if (mcz) {
      memoryConsolidationKv[mcz[1]] = parseConfigScalar(mcz[2]);
      continue;
    }
    // modelRouting.<personality>: <model>
    const mr = line.match(/^modelRouting\.(\S+):\s*(.+)$/);
    if (mr) {
      modelRouting[mr[1].trim()] = parseConfigScalar(mr[2]);
      continue;
    }
    // toolSettings.<personality|_default>.web_search.<provider|secret|recency>: <value>
    const tsMatch = line.match(
      /^toolSettings\.([^.]+)\.web_search\.(provider|secret|recency):\s*(.+)$/,
    );
    // The id segment becomes a computed own-key on `toolSettings` too, so it is
    // guarded like the key and field: `toolSettings.__proto__.…` would
    // otherwise write through to Object.prototype. A refused line falls
    // through, as a refused key or field does below.
    if (tsMatch && !RESERVED_TOOL_SETTINGS_KEYS.has(tsMatch[1].trim())) {
      const id = tsMatch[1].trim();
      const field = tsMatch[2];
      const val = parseConfigScalar(tsMatch[3]);
      const slot = ownToolSettingsSlot(toolSettings, id);
      const ws = slot.web_search ?? {};
      slot.web_search = ws;
      if (field === 'provider') {
        if (val === 'exa' || val === 'tavily' || val === 'brave') ws.provider = val;
      } else if (field === 'recency') {
        // Normalized shape guard (see normalizeWebSearchRecency): `30D` is
        // stored as `30d`, and a value that is not a duration at all is DROPPED
        // — the binding itself survives, unlike `secret`, where a wrong value
        // would bind a different credential rather than merely lose a default
        // filter.
        const recency = normalizeWebSearchRecency(val);
        if (recency) ws.recency = recency;
      } else {
        ws.secret = val;
      }
      continue;
    }
    // toolSettings.<personality|_default>.<key>.<field>: <name> — every binding
    // key but `web_search`, which the branch above handles and must therefore
    // stay ahead of this one (its `provider` / `recency` would otherwise be read
    // as secret names). `web_search` keeps its own branch rather than
    // merging into this one: it has three fields, a provider enum and a recency
    // normalizer, and averaging the two would lose all three.
    //
    // One generic branch over the OPEN key space (D8). The three near-identical
    // regexes this replaced were a hand list, and `search_console` was added to
    // the type without being added to them — so it round-tripped through a
    // personality's tools.yaml and died at both config.yaml rungs.
    //
    // The `<field>` segment is what makes this the SAME branch for the legacy
    // `.secret` line and a per-engine `engine_ask.<engineId>` line (plan
    // engine-ask-per-engine-bindings D10): a second regex beside this one
    // would be the hand-list failure above again. The field is guarded like
    // the key — it becomes a computed own-key on the binding object.
    const tsSecret = line.match(
      /^toolSettings\.([^.]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+):\s*(.+)$/,
    );
    const tsKey = tsSecret?.[2];
    const tsField = tsSecret?.[3];
    if (
      tsSecret &&
      tsKey &&
      tsField &&
      tsKey !== 'web_search' &&
      !RESERVED_TOOL_SETTINGS_KEYS.has(tsSecret[1].trim()) &&
      !RESERVED_TOOL_SETTINGS_KEYS.has(tsKey) &&
      !RESERVED_TOOL_SETTINGS_KEYS.has(tsField)
    ) {
      const id = tsSecret[1].trim();
      const slot = ownToolSettingsSlot(toolSettings, id);
      const binding: { [field: string]: string | undefined } = { ...slot[tsKey] };
      binding[tsField] = parseConfigScalar(tsSecret[4]);
      slot[tsKey] = binding;
      continue;
    }
    // activeContext.type / activeContext.name
    const ac = line.match(/^activeContext\.(\S+):\s*(.+)$/);
    if (ac) {
      activeContextKv[ac[1].trim()] = parseConfigScalar(ac[2]);
      continue;
    }
    // channel_filter.<platform>.<field>: <value>
    const cf = line.match(/^channel_filter\.([^.]+)\.(\S+):\s*(.+)$/);
    if (cf) {
      const platform = cf[1];
      channelFilterKv[platform] ??= {};
      (channelFilterKv[platform] as Record<string, string>)[cf[2]] = parseConfigScalar(cf[3]);
      continue;
    }
    // quick_commands.<name>.<field>: <value>
    const qc = line.match(/^quick_commands\.([^.]+)\.(\S+):\s*(.+)$/);
    if (qc) {
      const qname = qc[1];
      qcKv[qname] ??= {};
      (qcKv[qname] as Record<string, string>)[qc[2]] = parseConfigScalar(qc[3]);
      continue;
    }
    // channel_toolsets.<platform>: <comma-separated tool names>
    const ct = line.match(/^channel_toolsets\.([^.:\s]+):\s*(.+)$/);
    if (ct) {
      channelToolsetsKv[ct[1]] = parseConfigScalar(ct[2]);
      continue;
    }
    // storage.<field>: <value>
    const stg = line.match(/^storage\.([\w.]+):\s*(.+)$/);
    if (stg) {
      kv[`storage.${stg[1]}`] = parseConfigScalar(stg[2]);
      continue;
    }
    // plugins.isolation[.<pluginId>] / plugins.host.<field>: <value>
    const piso = line.match(/^plugins\.isolation(?:\.([^:\s]+))?:\s*(.+)$/);
    if (piso) {
      if (piso[1] === undefined)
        pluginIsolationKv['plugins.isolation'] = parseConfigScalar(piso[2]);
      else pluginIsolationOverridesKv[piso[1]] = parseConfigScalar(piso[2]);
      continue;
    }
    const phost = line.match(
      /^plugins\.host\.(sandbox|hook_timeout_ms|idle_stop_minutes|max_heap_mb):\s*(.+)$/,
    );
    if (phost) {
      pluginIsolationKv[`plugins.host.${phost[1]}`] = parseConfigScalar(phost[2]);
      continue;
    }
    // plugins.auto_install: <value>
    const pai = line.match(/^plugins\.auto_install:\s*(.+)$/);
    if (pai) {
      kv['plugins.auto_install'] = parseConfigScalar(pai[1]);
      continue;
    }
    // admin.enabled: <value>
    const adm = line.match(/^admin\.enabled:\s*(.+)$/);
    if (adm) {
      kv['admin.enabled'] = parseConfigScalar(adm[1]);
      continue;
    }
    // a2a.enabled: <value>
    const a2a = line.match(/^a2a\.enabled:\s*(.+)$/);
    if (a2a) {
      kv['a2a.enabled'] = parseConfigScalar(a2a[1]);
      continue;
    }
    // a2a.peering.allowPrivateUrls: <bool>  (operator peering may reach loopback/LAN).
    const a2ap = line.match(/^a2a\.peering\.allowPrivateUrls:\s*(.+)$/);
    if (a2ap) {
      kv['a2a.peering.allowPrivateUrls'] = parseConfigScalar(a2ap[1]);
      continue;
    }
    // goals.allowCheckCommands: <value>
    const gcc = line.match(/^goals\.allowCheckCommands:\s*(.+)$/);
    if (gcc) {
      kv['goals.allowCheckCommands'] = parseConfigScalar(gcc[1]);
      continue;
    }
    // security.trusted_github_orgs: <org,list>
    // `(.*)` — not `(.+)` — on purpose: an empty value is a meaningful
    // configuration ("trust no org"), distinct from the key being absent.
    const sec = line.match(/^security\.trusted_github_orgs:\s*(.*)$/);
    if (sec) {
      kv['security.trusted_github_orgs'] = parseConfigScalar(sec[1]);
      continue;
    }
    // nightlyPass.<field>: <value>
    const np = line.match(/^nightlyPass\.(\w+):\s*(.+)$/);
    if (np) {
      kv[`nightlyPass.${np[1]}`] = parseConfigScalar(np[2]);
      continue;
    }
    // backup.<field>: <value>
    const bk = line.match(/^backup\.(\w+):\s*(.+)$/);
    if (bk) {
      kv[`backup.${bk[1]}`] = parseConfigScalar(bk[2]);
      continue;
    }
    // weeklyDigest.<field>: <value>
    const wd = line.match(/^weeklyDigest\.(\w+):\s*(.+)$/);
    if (wd) {
      kv[`weeklyDigest.${wd[1]}`] = parseConfigScalar(wd[2]);
      continue;
    }
    // channelDigest.<field>: <value>
    const cd = line.match(/^channelDigest\.(\w+):\s*(.+)$/);
    if (cd) {
      kv[`channelDigest.${cd[1]}`] = parseConfigScalar(cd[2]);
      continue;
    }
    // learningReplay.<field>: <value>
    const lrp = line.match(/^learningReplay\.(\w+):\s*(.+)$/);
    if (lrp) {
      kv[`learningReplay.${lrp[1]}`] = parseConfigScalar(lrp[2]);
      continue;
    }
    // toolLoop.<field>: <value>  (hard caps and their soft-warn tiers)
    const tl = line.match(
      /^toolLoop\.(maxToolCallsWarnAt|maxIdenticalToolCallsWarnAt|maxToolCallsPerTurn|maxIdenticalToolCalls):\s*(.+)$/,
    );
    if (tl) {
      toolLoopKv[tl[1]] = parseConfigScalar(tl[2]);
      continue;
    }
    // mcp.<field>: <value>
    const mcpLine = line.match(/^mcp\.(discoveryConcurrency):\s*(.+)$/);
    if (mcpLine) {
      mcpKv[mcpLine[1]] = parseConfigScalar(mcpLine[2]);
      continue;
    }
    // kanban.<field>: <value>  (board WIP caps; distinct from kanbanPoll)
    const kb = line.match(/^kanban\.(maxInProgress|maxInProgressPerProfile):\s*(.+)$/);
    if (kb) {
      kanbanKv[kb[1]] = parseConfigScalar(kb[2]);
      continue;
    }
    // grounding.kanban.<field>: <value>  — matched BEFORE the flat grounding
    // keys below so the deeper key never falls through to the shallower branch.
    const grk = line.match(/^grounding\.kanban\.(checks|allowedCheckCommands):\s*(.+)$/);
    if (grk) {
      groundingKanbanKv[grk[1]] = parseConfigScalar(grk[2]);
      continue;
    }
    // grounding.<field>: <value>  (ground-truth verification policy)
    const gr = line.match(/^grounding\.(enabled|onFinding|showUnsupported|memoryTag):\s*(.+)$/);
    if (gr) {
      groundingKv[gr[1]] = parseConfigScalar(gr[2]);
      continue;
    }
    // kanbanPoll.<field>: <value>
    const kp = line.match(/^kanbanPoll\.(\w+):\s*(.+)$/);
    if (kp) {
      kv[`kanbanPoll.${kp[1]}`] = parseConfigScalar(kp[2]);
      continue;
    }
    // idleWatcher.<field>: <value>  (scale-to-zero watcher; default OFF).
    const iw = line.match(
      /^idleWatcher\.(enabled|idleThresholdMs|startupCooldownMs|checkIntervalMs|wakePathConfirmed):\s*(.+)$/,
    );
    if (iw) {
      idleWatcherKv[iw[1]] = parseConfigScalar(iw[2]);
      continue;
    }
    const nd = line.match(/^nodes\.(enabled):\s*(.+)$/); // nodes.enabled (default OFF)
    if (nd) {
      nodesKv[nd[1]] = parseConfigScalar(nd[2]);
      continue;
    }
    // pauseClockCorrection.<field>: <value>  (resume clock correction; default OFF).
    const pcc = line.match(/^pauseClockCorrection\.(enabled|thresholdMs):\s*(.+)$/);
    if (pcc) {
      pauseClockCorrectionKv[pcc[1]] = parseConfigScalar(pcc[2]);
      continue;
    }
    // pauseLifecycle.http.<field>: <value>  (orchestrator idle notification; default OFF).
    const plh = line.match(/^pauseLifecycle\.http\.(url|token|timeoutMs):\s*(.+)$/);
    if (plh) {
      pauseLifecycleHttpKv[plh[1]] = parseConfigScalar(plh[2]);
      continue;
    }
    // memory.charLimits.<memory|user>: <chars>  (markdown per-key ceilings).
    const mcl = line.match(/^memory\.charLimits\.(memory|user):\s*(.+)$/);
    if (mcl) {
      memoryCharLimitsKv[mcl[1]] = parseConfigScalar(mcl[2]);
      continue;
    }
    // execution.docker.<cpu|diskMb|image>: <value>  (container caps + sandbox image).
    const exd = line.match(/^execution\.docker\.(cpu|diskMb|image):\s*(.+)$/);
    if (exd) {
      executionDockerKv[exd[1]] = parseConfigScalar(exd[2]);
      continue;
    }
    // execution.allowLocalFallback: <bool>  (S6 / D3 host-fallback opt-in).
    const exl = line.match(/^execution\.allowLocalFallback:\s*(.+)$/);
    if (exl) {
      executionFlagsKv.allowLocalFallback = parseConfigScalar(exl[1]);
      continue;
    }
    // execution.containerized: <bool>  (this deployment is itself the boundary).
    const exc = line.match(/^execution\.containerized:\s*(.+)$/);
    if (exc) {
      executionFlagsKv.containerized = parseConfigScalar(exc[1]);
      continue;
    }
    // execution.ssh.<field>: <value>  (the single remote execution target).
    // The field list is an alternation, so an unrecognised `execution.ssh.*`
    // key falls through to the generic `key: value` catch-all below and is
    // then never read — dropped with a notice, not rejected, like every other
    // stray key (`ConfigKeyUse.unclaimed`).
    const exs = line.match(
      /^execution\.ssh\.(host|user|port|identityFile|knownHostsFile|strictHostKeys|remoteWorkdir):\s*(.+)$/,
    );
    if (exs) {
      executionSshKv[exs[1]] = parseConfigScalar(exs[2]);
      continue;
    }
    // browser.<field>: <value>  (Playwright budgets + launch posture). The
    // alternation is an ALLOWLIST: an unlisted `browser.*` key matches nothing
    // here, and the generic `key: value` catch-all at the end of this loop is
    // `\w+` only — so it is dropped with a notice, like every other stray
    // dotted key (`ConfigKeyUse.unclaimed`).
    const brw = line.match(
      /^browser\.(navigationTimeoutMs|commandTimeoutMs|headed|idleTimeoutMs|stealth\.enabled|profiles\.enabled|proxy\.(?:server|username|password)):\s*(.+)$/,
    );
    if (brw) {
      browserKv[brw[1]] = parseConfigScalar(brw[2]);
      continue;
    }
    if (line.startsWith('channels.')) {
      channels.add(line, lineIdx + 1);
      continue;
    }
    // gateway.private_chats.<platform>: <chatId,...>  (trusted rooms, D9).
    const gpc = line.match(/^gateway\.private_chats\.([^.\s:]+):\s*(.+)$/);
    if (gpc) {
      privateChatsKv[gpc[1]] = parseConfigScalar(gpc[2]);
      continue;
    }
    // gateway.<field>: <value>  (gateway-wide, non-credential knobs).
    const gwy = line.match(
      /^gateway\.(maxInboundMediaBytes|inboundSpool\.maxAttempts|inboundSpool\.maxReplayAgeMs):\s*(.+)$/,
    );
    if (gwy) {
      gatewayKv[gwy[1]] = parseConfigScalar(gwy[2]);
      continue;
    }
    // decisions.<field>: <value>  (decision provider). An ALLOWLIST like
    // `browser.*`: an unlisted `decisions.*` key is dropped here with a notice
    // (`ConfigKeyUse.unclaimed`) and kept verbatim by `writeConfig`'s
    // `unexpressibleLines`.
    const dcs = line.match(DECISIONS_LINE_RE);
    if (dcs) {
      decisionsKv[dcs[1]] = parseConfigScalar(dcs[2]);
      continue;
    }
    // teamSupervisor.restartLoopGuard.<field>: <n>  (member auto-restart brake).
    const trg = line.match(
      /^teamSupervisor\.restartLoopGuard\.(maxRestarts|windowSeconds):\s*(.+)$/,
    );
    if (trg) {
      restartLoopGuardKv[trg[1]] = parseConfigScalar(trg[2]);
      continue;
    }
    // discord.missedMessageBackfill.<field>: <value>  (channel-history backfill).
    const dbf = line.match(
      /^discord\.missedMessageBackfill\.(enabled|windowSeconds|limit):\s*(.+)$/,
    );
    if (dbf) {
      discordBackfillKv[dbf[1]] = parseConfigScalar(dbf[2]);
      continue;
    }
    // discord.<field>: <value>  (single segment — the backfill keys above are
    // dotted and have already been taken, and `\w` does not match a dot).
    const dsc = line.match(/^discord\.(\w+):\s*(.+)$/);
    if (dsc) {
      discordKv[dsc[1]] = parseConfigScalar(dsc[2]);
      continue;
    }
    // memoryCapture.<field>: <value>
    const mcap = line.match(/^memoryCapture\.(\w+):\s*(.+)$/);
    if (mcap) {
      kv[`memoryCapture.${mcap[1]}`] = parseConfigScalar(mcap[2]);
      continue;
    }
    // memoryVault.<field>: <value>
    const mvault = line.match(/^memoryVault\.(\w+):\s*(.+)$/);
    if (mvault) {
      kv[`memoryVault.${mvault[1]}`] = parseConfigScalar(mvault[2]);
      continue;
    }
    // memoryApproval.<field>: <value>
    const mappr = line.match(/^memoryApproval\.(\w+):\s*(.+)$/);
    if (mappr) {
      kv[`memoryApproval.${mappr[1]}`] = parseConfigScalar(mappr[2]);
      continue;
    }
    // memoryConsolidation.<field>: <value>
    const mcon = line.match(/^memoryConsolidation\.(\w+):\s*(.+)$/);
    if (mcon) {
      kv[`memoryConsolidation.${mcon[1]}`] = parseConfigScalar(mcon[2]);
      continue;
    }
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (m) {
      const key = m[1].trim();
      kv[key] = parseConfigScalar(m[2]);
      keyUse.caughtAll(lineIdx + 1, key, m[2]);
    } else {
      keyUse.unclaimed(line, lineIdx + 1);
    }
  }

  const activeContextType = activeContextKv.type;
  const activeContextName = activeContextKv.name;
  const activeContext: ActiveContext | undefined =
    (activeContextType === 'personality' || activeContextType === 'team') && activeContextName
      ? { type: activeContextType, name: activeContextName }
      : undefined;

  const providerNotices: string[] = [];
  const providers: ProviderConfig[] = parseProviderChain(src.split('\n'), providerNotices).map(
    (p) => ({
      ...p,
      apiKey: p.apiKey ?? '',
    }),
  );

  // Malformed retention durations are dropped with a warning rather than
  // carried through raw — see `retentionDuration`.
  const retentionWarnings: string[] = [];
  const retention = buildRetentionConfig(retentionKv, 'retention', retentionWarnings);
  const personalitiesConfig = buildPersonalitiesConfig(personalitiesRetKv, retentionWarnings);
  const auxiliaryCompression: AuxiliaryCompressionConfig | undefined = auxiliaryCompressionKv.model
    ? {
        model: auxiliaryCompressionKv.model,
        ...(auxiliaryCompressionKv.provider ? { provider: auxiliaryCompressionKv.provider } : {}),
        ...(auxiliaryCompressionKv.apiKey ? { apiKey: auxiliaryCompressionKv.apiKey } : {}),
        ...(auxiliaryCompressionKv.baseUrl ? { baseUrl: auxiliaryCompressionKv.baseUrl } : {}),
      }
    : undefined;
  const auxiliaryVision: AuxiliaryVisionConfig | undefined = auxiliaryVisionKv.model
    ? {
        model: auxiliaryVisionKv.model,
        ...(auxiliaryVisionKv.provider ? { provider: auxiliaryVisionKv.provider } : {}),
        ...(auxiliaryVisionKv.apiKey ? { apiKey: auxiliaryVisionKv.apiKey } : {}),
        ...(auxiliaryVisionKv.baseUrl ? { baseUrl: auxiliaryVisionKv.baseUrl } : {}),
      }
    : undefined;
  const auxiliaryWeb: AuxiliaryWebConfig | undefined = auxiliaryWebKv.model
    ? {
        model: auxiliaryWebKv.model,
        ...(auxiliaryWebKv.provider ? { provider: auxiliaryWebKv.provider } : {}),
        ...(auxiliaryWebKv.apiKey ? { apiKey: auxiliaryWebKv.apiKey } : {}),
        ...(auxiliaryWebKv.baseUrl ? { baseUrl: auxiliaryWebKv.baseUrl } : {}),
      }
    : undefined;
  // The default entries go through the SAME builder as their rosters, so a
  // field the default supports is a field the roster supports. The timeout
  // shim wraps the two DEFAULT entries here rather than living inside the
  // builder, because the builder also builds roster entries — whose `timeout`
  // was always seconds on every surface and must not be rewritten.
  const auxTimeoutWarnings: string[] = [];
  const auxiliaryAsr = normalizeAuxEntryTimeout(
    buildVoiceProviderEntry<SttProviderEntry>(auxiliaryAsrKv, STT_ENTRY_FIELDS),
    'auxiliary.asr.timeout',
    auxTimeoutWarnings,
  );
  const auxiliaryTts = normalizeAuxEntryTimeout(
    buildVoiceProviderEntry<TtsProviderEntry>(auxiliaryTtsKv, TTS_ENTRY_FIELDS),
    'auxiliary.tts.timeout',
    auxTimeoutWarnings,
  );
  const webPort = webKv.port ? parseBoundedInt(webKv.port, 1, 65535) : undefined;
  const webConfig: WebConfig | undefined =
    webKv.search_backend ||
    webKv.extract_backend ||
    webKv.host ||
    webPort !== undefined ||
    webKv.corsOrigins ||
    webKv['searxng.url']
      ? {
          ...(webKv.search_backend === 'exa' ||
          webKv.search_backend === 'tavily' ||
          webKv.search_backend === 'brave'
            ? { search_backend: webKv.search_backend }
            : {}),
          ...(webKv.extract_backend === 'htmltext'
            ? { extract_backend: webKv.extract_backend }
            : {}),
          ...(webKv.host ? { host: webKv.host } : {}),
          ...(webPort !== undefined ? { port: webPort } : {}),
          ...(webKv.corsOrigins ? { corsOrigins: webKv.corsOrigins } : {}),
          ...(webKv['searxng.url'] ? { searxng: { url: webKv['searxng.url'] } } : {}),
        }
      : undefined;
  const modelCatalogProviders: Record<string, { url: string }> | undefined =
    Object.keys(modelCatalogProvidersKv).length > 0
      ? Object.fromEntries(
          Object.entries(modelCatalogProvidersKv)
            .filter(([, v]) => v.url)
            .map(([id, v]) => [id, { url: v.url }]),
        )
      : undefined;
  const modelCatalogEnabled: boolean | undefined =
    modelCatalogKv.enabled === 'true'
      ? true
      : modelCatalogKv.enabled === 'false'
        ? false
        : undefined;
  const modelCatalog: ModelCatalogConfig | undefined =
    Object.keys(modelCatalogKv).length > 0 || modelCatalogProviders
      ? {
          ...(modelCatalogEnabled !== undefined ? { enabled: modelCatalogEnabled } : {}),
          ...(modelCatalogKv.url ? { url: modelCatalogKv.url } : {}),
          ...(modelCatalogKv.ttlHours ? { ttlHours: Number(modelCatalogKv.ttlHours) } : {}),
          ...(modelCatalogProviders ? { providers: modelCatalogProviders } : {}),
        }
      : undefined;
  const modelRegistry = buildModelRegistryFromLines(modelRegistryLines);
  const models = buildModelProfiles(modelsKv);
  const compaction = buildCompaction(compactionKv);
  const memoryCharLimits = buildMemoryCharLimits(memoryCharLimitsKv);
  const executionResult = buildExecutionConfig(
    executionDockerKv,
    executionSshKv,
    executionFlagsKv.allowLocalFallback,
    executionFlagsKv.containerized,
  );
  const execution = executionResult.execution;
  const restartLoopGuard = buildRestartLoopGuard(restartLoopGuardKv);
  const discordBackfill = buildDiscordBackfill(discordBackfillKv);
  const discordModeResult = buildDiscordDefaultMode(discordKv);
  const discordRoleList = (discordKv.approvalRoleIds ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const discordApprovalRoleIds = discordRoleList.length > 0 ? discordRoleList : undefined;
  const discordReplyPrefix = discordKv.replyPrefix || undefined;
  const discordMentionByName =
    discordKv.mentionByName !== undefined ? discordKv.mentionByName === 'true' : undefined;
  const callCapture = callCaptureKv.personalityId
    ? { personalityId: callCaptureKv.personalityId }
    : undefined;
  const memoryConsolidation = buildMemoryConsolidation(memoryConsolidationKv);
  const idleWatcher = buildIdleWatcher(idleWatcherKv);
  const nodes = buildNodes(nodesKv);
  const pauseClockCorrection = buildPauseClockCorrection(pauseClockCorrectionKv);
  // ETHOS_ORCHESTRATOR_URL / ETHOS_ORCHESTRATOR_TOKEN win over the yaml value,
  // same precedence as ETHOS_PUBLIC_URL over webBaseUrl below.
  const pauseLifecycleHttpBuilt = buildPauseLifecycleHttp(pauseLifecycleHttpKv);
  const pauseLifecycleHttpUrl = process.env.ETHOS_ORCHESTRATOR_URL ?? pauseLifecycleHttpBuilt?.url;
  const pauseLifecycleHttpToken =
    process.env.ETHOS_ORCHESTRATOR_TOKEN ?? pauseLifecycleHttpBuilt?.token;
  const pauseLifecycleHttp =
    pauseLifecycleHttpBuilt ||
    pauseLifecycleHttpUrl !== undefined ||
    pauseLifecycleHttpToken !== undefined
      ? {
          ...pauseLifecycleHttpBuilt,
          ...(pauseLifecycleHttpUrl !== undefined ? { url: pauseLifecycleHttpUrl } : {}),
          ...(pauseLifecycleHttpToken !== undefined ? { token: pauseLifecycleHttpToken } : {}),
        }
      : undefined;
  // ETHOS_CRON_FIRE_URL wins over the yaml value, same precedence as
  // ETHOS_ORCHESTRATOR_URL over the pauseLifecycle url above. Deliberately NOT
  // derived from ETHOS_PUBLIC_URL (N2): a public URL answers "what is this
  // process's address", this answers "should this process stop running its own
  // clock", and plenty of deployments want the first without the second.
  const cronDeprecations: string[] = [];
  const notificationWarnings: string[] = [];
  const gatewayWarnings: string[] = [];
  const notifications = buildNotificationsConfig(
    notificationsKv,
    notificationBotsKv,
    notificationWarnings,
  );
  const cronBuilt = buildCronConfig(cronKv, cronDeprecations);
  const cronFireUrl = process.env.ETHOS_CRON_FIRE_URL ?? cronBuilt?.fireUrl;
  const cron =
    cronBuilt || cronFireUrl !== undefined
      ? {
          ...cronBuilt,
          ...(cronFireUrl !== undefined ? { fireUrl: cronFireUrl } : {}),
        }
      : undefined;
  const parsedMaxBytes = logsRotationKv.maxBytes ? Number(logsRotationKv.maxBytes) : undefined;
  const parsedMaxFiles = logsRotationKv.maxFiles ? Number(logsRotationKv.maxFiles) : undefined;
  const logsRotation =
    Object.keys(logsRotationKv).length > 0
      ? {
          ...(parsedMaxBytes && Number.isFinite(parsedMaxBytes) && parsedMaxBytes > 0
            ? { maxBytes: Math.floor(parsedMaxBytes) }
            : {}),
          ...(parsedMaxFiles && Number.isFinite(parsedMaxFiles) && parsedMaxFiles > 0
            ? { maxFiles: Math.floor(parsedMaxFiles) }
            : {}),
          ...(logsRotationKv.enabled !== undefined
            ? { enabled: logsRotationKv.enabled !== 'false' }
            : {}),
        }
      : undefined;
  // An unrecognised level is dropped rather than defaulted, so a typo never
  // silences output that was printing before.
  const rawLogLevel = kv['logs.level'];
  const logsLevel = LOG_LEVELS.find((l) => l === rawLogLevel);
  const awsSecrets: AwsSecretsConfig | undefined =
    Object.keys(awsSecretsKv).length > 0
      ? {
          ...(awsSecretsKv.enabled === 'true'
            ? { enabled: true }
            : awsSecretsKv.enabled === 'false'
              ? { enabled: false }
              : {}),
          ...(awsSecretsKv.region ? { region: awsSecretsKv.region } : {}),
          ...(awsSecretsKv.prefix ? { prefix: awsSecretsKv.prefix } : {}),
          ...(awsSecretsKv.endpoint ? { endpoint: awsSecretsKv.endpoint } : {}),
        }
      : undefined;
  const awsConfig: AwsConfig | undefined = awsSecrets ? { secrets: awsSecrets } : undefined;
  const telemetryLangfuse: TelemetryLangfuseExportConfig | undefined =
    Object.keys(telemetryLangfuseKv).length > 0
      ? {
          ...(telemetryLangfuseKv.enabled === 'true'
            ? { enabled: true }
            : telemetryLangfuseKv.enabled === 'false'
              ? { enabled: false }
              : {}),
          ...(telemetryLangfuseKv.baseUrl ? { baseUrl: telemetryLangfuseKv.baseUrl } : {}),
          ...(telemetryLangfuseKv.publicKey ? { publicKey: telemetryLangfuseKv.publicKey } : {}),
          ...(telemetryLangfuseKv.secretKey ? { secretKey: telemetryLangfuseKv.secretKey } : {}),
        }
      : undefined;
  const otlpHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(telemetryOtlpHeadersKv)) {
    otlpHeaders[name] = value;
  }
  const telemetryOtlp: TelemetryOtlpExportConfig | undefined =
    Object.keys(telemetryOtlpKv).length > 0 || Object.keys(otlpHeaders).length > 0
      ? {
          ...(telemetryOtlpKv.enabled === 'true'
            ? { enabled: true }
            : telemetryOtlpKv.enabled === 'false'
              ? { enabled: false }
              : {}),
          ...(telemetryOtlpKv.endpoint ? { endpoint: telemetryOtlpKv.endpoint } : {}),
          ...(Object.keys(otlpHeaders).length > 0 ? { headers: otlpHeaders } : {}),
          ...(telemetryOtlpKv.includeContent === 'true'
            ? { includeContent: true }
            : telemetryOtlpKv.includeContent === 'false'
              ? { includeContent: false }
              : {}),
          ...(telemetryOtlpKv.intervalMs !== undefined && /^\d+$/.test(telemetryOtlpKv.intervalMs)
            ? { intervalMs: Number.parseInt(telemetryOtlpKv.intervalMs, 10) }
            : {}),
          ...(telemetryOtlpKv.backlogMaxAgeMs !== undefined &&
          /^\d+$/.test(telemetryOtlpKv.backlogMaxAgeMs)
            ? { backlogMaxAgeMs: Number.parseInt(telemetryOtlpKv.backlogMaxAgeMs, 10) }
            : {}),
        }
      : undefined;
  const telemetryConfig: TelemetryConfig | undefined =
    telemetryLangfuse || telemetryOtlp
      ? {
          export: {
            ...(telemetryLangfuse ? { langfuse: telemetryLangfuse } : {}),
            ...(telemetryOtlp ? { otlp: telemetryOtlp } : {}),
          },
        }
      : undefined;
  const telegramResult = buildTelegramBots(telegramBotsKv);
  const slackResult = buildSlackApps(slackAppsKv);
  const whatsappResult = buildWhatsApps(whatsappKv);
  const voiceResult = buildVoiceBots(voiceBotsKv);
  const voiceLiveKitResult = buildVoiceLiveKit(voiceLiveKitKv);
  const voiceTrunkResult = buildVoiceTrunk(voiceTrunkKv);
  const voiceInboundResult = buildVoiceInbound(voiceInboundKv, voiceInboundOwnerKv);
  const voiceBargeInResult = buildVoiceBargeIn(voiceBargeInKv);
  const voiceFiller = Object.keys(voiceFillerKv).length > 0 ? voiceFillerKv : undefined;
  // Legacy `voice.providers.*` entries merge UNDER the new spelling, per name
  // and per field, so a file mid-migration keeps whichever fields it has
  // already moved and the new key always wins.
  const mergedTtsProvidersKv: Record<string, Record<string, string>> = {};
  for (const [name, fields] of Object.entries(voiceTtsProvidersLegacyKv)) {
    mergedTtsProvidersKv[name] = { ...fields };
  }
  for (const [name, fields] of Object.entries(voiceTtsProvidersKv)) {
    mergedTtsProvidersKv[name] = { ...mergedTtsProvidersKv[name], ...fields };
  }
  const voiceTtsProviders = buildVoiceProviderRoster<TtsProviderEntry>(
    mergedTtsProvidersKv,
    TTS_ENTRY_FIELDS,
  );
  const voiceSttProviders = buildVoiceProviderRoster<SttProviderEntry>(
    voiceSttProvidersKv,
    STT_ENTRY_FIELDS,
  );
  const voiceRealtimeProviders = buildVoiceProviderRoster<RealtimeProviderEntry>(
    voiceRealtimeProvidersKv,
    REALTIME_ENTRY_FIELDS,
  );
  // `default` and `sessionBudgetUsd` stand on their own: a deployment can name a
  // default (or cap a session) before its roster is typed in, and losing the cap
  // because the roster is momentarily empty would be the wrong way round.
  const voiceRealtime =
    voiceRealtimeProviders !== undefined ||
    voiceRealtimeDefault !== undefined ||
    voiceRealtimeSessionBudgetUsd !== undefined
      ? {
          ...(voiceRealtimeProviders ? { providers: voiceRealtimeProviders } : {}),
          ...(voiceRealtimeDefault ? { default: voiceRealtimeDefault } : {}),
          ...(voiceRealtimeSessionBudgetUsd !== undefined
            ? { sessionBudgetUsd: voiceRealtimeSessionBudgetUsd }
            : {}),
        }
      : undefined;
  // Each of the three V2 sub-sections stands on its own: an operator can cap
  // artifact disk before naming an ffmpeg path, and vice versa.
  const voiceChannels = Object.keys(voiceChannelsKv).length > 0 ? voiceChannelsKv : undefined;
  const voiceTranscode = Object.keys(voiceTranscodeKv).length > 0 ? voiceTranscodeKv : undefined;
  const voiceArtifacts = Object.keys(voiceArtifactsKv).length > 0 ? voiceArtifactsKv : undefined;
  // The wake block stands on its own too: an operator can set the engine before
  // typing a single route, and a routes-only config is the common first edit.
  const voiceWakeRoutes = buildWakeRoutes(voiceWakeRoutesKv);
  const voiceWakeNodes = buildWakeNodes(voiceWakeNodesKv);
  const voiceWake =
    Object.keys(voiceWakeKv).length > 0 ||
    voiceWakeRoutes !== undefined ||
    voiceWakeNodes !== undefined
      ? {
          ...voiceWakeKv,
          ...(voiceWakeRoutes ? { routes: voiceWakeRoutes } : {}),
          ...(voiceWakeNodes ? { nodes: voiceWakeNodes } : {}),
        }
      : undefined;
  const voiceSection =
    voiceResult.bots.length > 0 ||
    voiceLiveKitResult.livekit ||
    voiceTrunkResult.trunk ||
    voiceInboundResult.inbound ||
    voiceBargeInResult.bargeIn ||
    voiceFiller !== undefined ||
    voiceTrustedPluginsRaw !== undefined ||
    voiceDefaultMode !== undefined ||
    voiceTier !== undefined ||
    voiceTtsProviders !== undefined ||
    voiceSttProviders !== undefined ||
    voiceRealtime !== undefined ||
    voiceChannels !== undefined ||
    voiceTranscode !== undefined ||
    voiceArtifacts !== undefined ||
    voiceWake !== undefined
      ? {
          bots: voiceResult.bots,
          ...(voiceLiveKitResult.livekit ? { livekit: voiceLiveKitResult.livekit } : {}),
          ...(voiceTrunkResult.trunk ? { trunk: voiceTrunkResult.trunk } : {}),
          ...(voiceInboundResult.inbound ? { inbound: voiceInboundResult.inbound } : {}),
          ...(voiceBargeInResult.bargeIn ? { bargeIn: voiceBargeInResult.bargeIn } : {}),
          ...(voiceFiller ? { filler: voiceFiller } : {}),
          ...(voiceTrustedPluginsRaw !== undefined
            ? { trustedPlugins: splitList(voiceTrustedPluginsRaw) }
            : {}),
          ...(voiceDefaultMode ? { defaultMode: voiceDefaultMode } : {}),
          ...(voiceTier ? { tier: voiceTier } : {}),
          ...(voiceTtsProviders ? { tts: { providers: voiceTtsProviders } } : {}),
          ...(voiceSttProviders ? { stt: { providers: voiceSttProviders } } : {}),
          ...(voiceRealtime ? { realtime: voiceRealtime } : {}),
          ...(voiceChannels ? { channels: voiceChannels } : {}),
          ...(voiceTranscode ? { transcode: voiceTranscode } : {}),
          ...(voiceArtifacts ? { artifacts: voiceArtifacts } : {}),
          ...(voiceWake ? { wake: voiceWake } : {}),
        }
      : undefined;
  const teams = buildTeamsConfig(teamsKv);
  const webhooksResult = buildWebhooks(webhooksKv);
  const quick_commands = buildQuickCommands(qcKv);
  const channelToolsets = buildChannelToolsets(channelToolsetsKv);
  const channelFilterWarnings: string[] = [];
  const channelFilter = buildChannelFilter(channelFilterKv, channelFilterWarnings);
  const groundingResult = buildGrounding(groundingKv, groundingKanbanKv);
  const mcpResult = buildMcpConfig(mcpKv);
  const browserResult = buildBrowser(browserKv);
  const toolLoadingResult = parseToolLoading(kv.tool_loading);
  // Warnings, never errors: a `decisions.*` line must not stop boot (plan R6).
  const decisionsWarnings: string[] = [];
  const decisions = buildDecisionsConfig(decisionsKv, decisionsWarnings);
  const parseErrors = [
    ...toolLoadingResult.errors,
    ...groundingResult.errors,
    ...browserResult.errors,
    ...telegramResult.errors,
    ...slackResult.errors,
    ...whatsappResult.errors,
    ...voiceResult.errors,
    ...voiceLiveKitResult.errors,
    ...voiceTrunkResult.errors,
    ...voiceInboundResult.errors,
    ...voiceBargeInResult.errors,
    ...webhooksResult.errors,
    ...discordModeResult.errors,
    ...executionResult.errors,
  ];

  const pluginsAutoInstall: boolean | undefined =
    kv['plugins.auto_install'] === 'true'
      ? true
      : kv['plugins.auto_install'] === 'false'
        ? false
        : undefined;
  const pluginIsolationResult = buildPluginIsolation(pluginIsolationKv, pluginIsolationOverridesKv);
  const parsedSchemaVersion = kv.schemaVersion ? Number(kv.schemaVersion) : undefined;
  const config: EthosConfig = {
    schemaVersion: Number.isFinite(parsedSchemaVersion) ? parsedSchemaVersion : undefined,
    provider: kv.provider ?? 'anthropic',
    // The catalog's Anthropic default (`getDefaultModel('anthropic')` in
    // packages/wiring/src/model-catalog.ts); this package cannot import it, so
    // packages/wiring/src/__tests__/config-default-model.test.ts pins the two equal.
    model: kv.model ?? 'claude-opus-5-5',
    apiKey: kv.apiKey ?? '',
    personality: kv.personality ?? DEFAULT_PERSONALITY_ID,
    memory:
      kv.memory === 'vector'
        ? 'vector'
        : kv.memory === 'vault'
          ? 'vault'
          : kv.memory === 'markdown'
            ? 'markdown'
            : undefined,
    baseUrl: kv.baseUrl,
    apiVersion: kv.apiVersion,
    region: kv.region,
    awsProfile: kv.awsProfile,
    // Lane 0 (D4) — a window is a positive integer token count; anything else
    // (zero, negative, non-numeric) is dropped so a typo cannot poison the
    // provider's maxContextTokens.
    contextWindow: (() => {
      if (kv.contextWindow === undefined) return undefined;
      const n = Number(kv.contextWindow);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
    })(),
    // Lane 2a — only the two known values are accepted; anything else is
    // dropped so a typo cannot silently change the wire format.
    toolOrder:
      kv.toolOrder === 'insertion' ? 'insertion' : kv.toolOrder === 'stable' ? 'stable' : undefined,
    // Lane 4a(d) — a deadline is a positive integer millisecond count; a retry
    // count is a non-negative integer. Anything else is dropped so a typo
    // cannot silently change the client's request behavior.
    requestTimeoutMs: (() => {
      if (kv.requestTimeoutMs === undefined) return undefined;
      const n = Number(kv.requestTimeoutMs);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
    })(),
    // An approval SLA is a non-negative integer millisecond count. Unlike
    // `requestTimeoutMs`, `0` is MEANINGFUL here ("no timeout, wait forever")
    // rather than a typo — only negatives and non-numbers are dropped.
    approvalTimeoutMs: (() => {
      const raw = kv.approvalTimeoutMs;
      // An empty or blank value (`approvalTimeoutMs: ""`, or a bare key with
      // trailing whitespace) is a typo, not an intentional `0` — and
      // `Number('')` is `0`, which would silently disable the auto-deny
      // backstop. Treat it as absent so the store default applies.
      if (raw === undefined || raw.trim() === '') return undefined;
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
    })(),
    // A safety opt-in: only the literal `true` enables it, so a typo stays off.
    allowUnattendedDangerousTools: kv.allowUnattendedDangerousTools === 'true' ? true : undefined,
    maxRetries: (() => {
      const raw = kv.maxRetries;
      // Same empty-value hazard as `approvalTimeoutMs`: `0` is meaningful
      // ("never retry"), so `Number('') === 0` would silently turn retries off
      // on a typo instead of falling through to the provider default.
      if (raw === undefined || raw.trim() === '') return undefined;
      const n = Number(raw);
      return Number.isInteger(n) && n >= 0 ? n : undefined;
    })(),
    // Lane 3(a) — a payload limit is a positive integer char count; anything
    // else is dropped so a typo cannot disable (or zero) the guard.
    toolPayloadLimitChars: (() => {
      if (kv.toolPayloadLimitChars === undefined) return undefined;
      const n = Number(kv.toolPayloadLimitChars);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
    })(),
    ...(toolLoadingResult.mode ? { toolLoading: toolLoadingResult.mode } : {}),
    modelRouting: Object.keys(modelRouting).length > 0 ? modelRouting : undefined,
    toolSettings: Object.keys(toolSettings).length > 0 ? toolSettings : undefined,
    models,
    compaction,
    memoryCharLimits,
    execution,
    callCapture,
    activeContext,
    providers: providers.length > 0 ? providers : undefined,
    telegramToken: kv.telegramToken,
    discordToken: kv.discordToken,
    slackBotToken: kv.slackBotToken,
    slackAppToken: kv.slackAppToken,
    slackSigningSecret: kv.slackSigningSecret,
    emailImapHost: kv.emailImapHost,
    emailImapPort: kv.emailImapPort ? Number(kv.emailImapPort) : undefined,
    emailUser: kv.emailUser,
    emailPassword: kv.emailPassword,
    emailSmtpHost: kv.emailSmtpHost,
    emailSmtpPort: kv.emailSmtpPort ? Number(kv.emailSmtpPort) : undefined,
    emailTrustedAuthservId: kv.emailTrustedAuthservId,
    verbose: kv.verbose === 'true' ? true : undefined,
    displayVerbosity: parseVerbosity(displayKv.verbosity),
    displayBusyInputMode: parseBusyMode(displayKv.busy_input_mode),
    displayToolPreviewLength: parseToolPreviewLength(displayKv.tool_preview_length),
    displayResumeHint: displayKv.resume_hint === 'false' ? false : undefined,
    displayResumeRecapTurns: (() => {
      if (displayKv.resume_recap_turns === undefined) return undefined;
      const n = parseInt(displayKv.resume_recap_turns, 10);
      return Number.isFinite(n) ? Math.min(10, Math.max(0, n)) : undefined;
    })(),
    skin: kv.skin || undefined,
    retention,
    personalitiesConfig,
    telegram: telegramResult.bots.length > 0 ? { bots: telegramResult.bots } : undefined,
    slack: slackResult.apps.length > 0 ? { apps: slackResult.apps } : undefined,
    whatsapp: whatsappResult.apps.length > 0 ? whatsappResult.apps : undefined,
    voice: voiceSection,
    teams,
    evolverCronEnabled: evolverKv.cron_enabled === 'true' ? true : undefined,
    evolverSchedule: evolverKv.schedule || undefined,
    backgroundMaxConcurrent: backgroundKv.max_concurrent
      ? Number(backgroundKv.max_concurrent)
      : undefined,
    background: buildBackgroundConfig(backgroundKv, backgroundAcpAgentsKv),
    cron,
    ...(notifications ? { notifications } : {}),
    displayBellOnComplete: displayKv.bell_on_complete === 'true' ? true : undefined,
    displaySlowTurnNoticeMs: (() => {
      if (displayKv.slow_turn_notice_ms === undefined) return undefined;
      const n = Number(displayKv.slow_turn_notice_ms);
      // A negative value reads as "never" — clamp to 0 (disabled) rather than
      // dropping it to undefined, which would resurrect the 8000ms default.
      return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : undefined;
    })(),
    displayMemoryNotices:
      displayKv.memory_notices === 'true'
        ? true
        : displayKv.memory_notices === 'false'
          ? false
          : undefined,
    displayDebugPanel: displayKv.debug_panel === 'true' ? true : undefined,
    displayDebugPanelModel: displayKv.debug_panel_model || undefined,
    displayStreamingEdits: parseStreamingEdits(displayKv.streaming_edits),
    displayCallStyle: parseCallStyle(displayKv.call_style),
    displayCallAccent: parseCallAccent(displayKv.call_accent),
    quick_commands,
    channelToolsets,
    channelFilter,
    auxiliary:
      auxiliaryCompression || auxiliaryVision || auxiliaryWeb || auxiliaryAsr || auxiliaryTts
        ? {
            ...(auxiliaryCompression ? { compression: auxiliaryCompression } : {}),
            ...(auxiliaryVision ? { vision: auxiliaryVision } : {}),
            ...(auxiliaryWeb ? { web: auxiliaryWeb } : {}),
            ...(auxiliaryAsr ? { asr: auxiliaryAsr } : {}),
            ...(auxiliaryTts ? { tts: auxiliaryTts } : {}),
          }
        : undefined,
    web: webConfig,
    webhooks: webhooksResult.webhooks,
    modelCatalog,
    modelRegistry,
    logs:
      logsRotation || logsLevel
        ? {
            ...(logsRotation ? { rotation: logsRotation } : {}),
            ...(logsLevel ? { level: logsLevel } : {}),
          }
        : undefined,
    aws: awsConfig,
    telemetry: telemetryConfig,
    webBaseUrl: process.env.ETHOS_PUBLIC_URL ?? kv.webBaseUrl ?? undefined,
    storage: buildStorageConfig(kv),
    pluginsAutoInstall,
    admin:
      kv['admin.enabled'] !== undefined ? { enabled: kv['admin.enabled'] === 'true' } : undefined,
    a2a: buildA2aConfig(kv),
    goals:
      kv['goals.allowCheckCommands'] !== undefined
        ? { allowCheckCommands: kv['goals.allowCheckCommands'] === 'true' }
        : undefined,
    // `!== undefined` — not truthiness: an empty value must survive as `[]`
    // (trust no org) instead of collapsing back to the shipped default.
    security:
      kv['security.trusted_github_orgs'] !== undefined
        ? {
            trustedGitHubOrgs: kv['security.trusted_github_orgs']
              .split(/[,\s]+/)
              .map((o) => o.trim())
              .filter((o) => o.length > 0),
          }
        : undefined,
    backup: buildBackupConfig(kv),
    nightlyPass:
      kv['nightlyPass.enabled'] !== undefined || kv['nightlyPass.cron'] !== undefined
        ? {
            ...(kv['nightlyPass.enabled'] !== undefined
              ? { enabled: kv['nightlyPass.enabled'] === 'true' }
              : {}),
            ...(kv['nightlyPass.cron'] ? { cron: kv['nightlyPass.cron'] } : {}),
          }
        : undefined,
    memoryCapture: buildMemoryCaptureConfig(kv),
    memoryVault: buildMemoryVaultConfig(kv),
    memoryApproval: buildMemoryApprovalConfig(kv),
    memoryConsolidation: (() => {
      // Union of the silent memory-flush turn (context-compaction) and the
      // decay/importance tuning (memory-experience) — disjoint field sets, one key.
      const decay = buildMemoryConsolidationConfig(kv);
      if (!memoryConsolidation && !decay) return undefined;
      return { ...memoryConsolidation, ...decay };
    })(),
    weeklyDigest: buildWeeklyDigest(kv),
    channelDigest: buildChannelDigestConfig(kv),
    learningReplay: buildLearningReplayConfig(kv),
    toolLoop: buildToolLoop(toolLoopKv),
    mcp: mcpResult.mcp,
    kanban: buildKanban(kanbanKv),
    grounding: groundingResult.grounding,
    browser: browserResult.browser,
    gateway: buildGateway(gatewayKv, privateChatsKv, gatewayWarnings),
    channels: buildChannels(channels.lines, channels.warnings),
    decisions,
    teamSupervisor: restartLoopGuard ? { restartLoopGuard } : undefined,
    discord:
      discordBackfill ||
      discordModeResult.mode ||
      discordApprovalRoleIds ||
      discordReplyPrefix ||
      discordMentionByName !== undefined
        ? {
            ...(discordModeResult.mode ? { defaultChannelMode: discordModeResult.mode } : {}),
            ...(discordApprovalRoleIds ? { approvalRoleIds: discordApprovalRoleIds } : {}),
            ...(discordReplyPrefix ? { replyPrefix: discordReplyPrefix } : {}),
            ...(discordMentionByName !== undefined ? { mentionByName: discordMentionByName } : {}),
            ...(discordBackfill ? { missedMessageBackfill: discordBackfill } : {}),
          }
        : undefined,
    // Only the two literals are accepted; anything else is dropped so a typo
    // cannot silently disable (or force) the placeholder.
    discordPostThinkingPlaceholder:
      discordKv.post_thinking_placeholder === 'true'
        ? true
        : discordKv.post_thinking_placeholder === 'false'
          ? false
          : undefined,
    kanbanPoll:
      kv['kanbanPoll.enabled'] !== undefined ||
      kv['kanbanPoll.intervalMs'] !== undefined ||
      kv['kanbanPoll.boardPath'] !== undefined
        ? {
            ...(kv['kanbanPoll.enabled'] !== undefined
              ? { enabled: kv['kanbanPoll.enabled'] === 'true' }
              : {}),
            ...(kv['kanbanPoll.intervalMs']
              ? { intervalMs: Number(kv['kanbanPoll.intervalMs']) }
              : {}),
            ...(kv['kanbanPoll.boardPath'] ? { boardPath: kv['kanbanPoll.boardPath'] } : {}),
          }
        : undefined,
    idleWatcher,
    nodes,
    pauseClockCorrection,
    pauseLifecycle: pauseLifecycleHttp ? { http: pauseLifecycleHttp } : undefined,
    ...(pluginIsolationResult.value ? { pluginIsolation: pluginIsolationResult.value } : {}),
  };
  // UD1/B3 — the `personality:` field above baked in DEFAULT_PERSONALITY_ID;
  // record when the file never set the key so `resolveEffectiveConfig` can
  // report `source: 'default'` instead of claiming `(personality:)`.
  if (kv.personality === undefined) personalityDefaultedByConfig.add(config);
  // Stash parse errors so the strict loader can surface them at boot.
  // readRawConfig (used by CLI commands that don't gateway-boot) ignores them
  // and continues with whatever entries did parse.
  parseErrorsByConfig.set(config, parseErrors);
  // Cron's notices lead the list.
  parseWarningsByConfig.set(config, [
    ...cronDeprecations,
    ...executionResult.warnings,
    ...auxTimeoutWarnings,
    ...retentionWarnings,
    ...providerNotices,
    ...modelRegistryNotices,
    ...decisionsWarnings,
    ...channelFilterWarnings,
    ...mcpResult.warnings,
    ...storageEncryptionRemovedNotice(kv),
    ...notificationWarnings,
    ...gatewayWarnings,
    ...channels.warnings,
    ...pluginIsolationResult.warnings,
    ...keyUse.notices(),
  ]);
  return config;
}
