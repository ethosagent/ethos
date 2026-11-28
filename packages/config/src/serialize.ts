import { SECRET_NAME_RE } from '@ethosagent/types';
import { channelsToLines } from './builders/channels';
import { backgroundToLines } from './builders/cron-background';
import type { BotBudgetConfig } from './builders/platforms';
import { retentionToLines } from './builders/retention';
import type { EthosConfig } from './config-types';
import { serializeDecisionsLines } from './decisions';
import { RESERVED_TOOL_SETTINGS_KEYS } from './keys';
import { renderModelRegistry } from './model-registry-config';
import { renderProviderChain } from './provider-chain';
import { renderConfigLine } from './scalar';
import { CURRENT_ETHOS_CONFIG_SCHEMA_VERSION } from './section-types';
import { idleWatcherLines, shareLinksLines, worldLines } from './serialize-sections';
import {
  REALTIME_ENTRY_FIELDS,
  STT_ENTRY_FIELDS,
  TTS_ENTRY_FIELDS,
  voiceProviderEntryLines,
} from './voice';

/** Pure `EthosConfig` → `config.yaml` lines. No I/O, no secret externalization. */
/** `<prefix>.budget.*` lines for one bot entry (`telegram.bots.<n>`, `slack.apps.<n>`,
 *  `whatsapp.<n>`); `backgroundBlocksReplies` only when set. Read by {@link buildBotBudget}. */
function budgetLines(prefix: string, budget: BotBudgetConfig | undefined): string[] {
  if (!budget) return [];
  const lines = [`${prefix}.budget.dailyUsd: ${budget.dailyUsd}`];
  if (budget.backgroundBlocksReplies !== undefined) {
    lines.push(`${prefix}.budget.backgroundBlocksReplies: ${budget.backgroundBlocksReplies}`);
  }
  return lines;
}

export function serializeConfigLines(config: EthosConfig): string[] {
  const lines = [
    `schemaVersion: ${config.schemaVersion ?? CURRENT_ETHOS_CONFIG_SCHEMA_VERSION}`,
    `provider: ${config.provider}`,
    `model: ${config.model}`,
  ];
  // `apiKey` is typed required but is absent from real files (the vault holds
  // it), and an unguarded template literal wrote the string `undefined` back.
  if (config.apiKey) lines.push(`apiKey: ${config.apiKey}`);
  lines.push(`personality: ${config.personality}`);
  if (config.memory) lines.push(`memory: ${config.memory}`);
  if (config.memoryCharLimits) {
    if (config.memoryCharLimits.memory !== undefined) {
      lines.push(`memory.charLimits.memory: ${config.memoryCharLimits.memory}`);
    }
    if (config.memoryCharLimits.user !== undefined) {
      lines.push(`memory.charLimits.user: ${config.memoryCharLimits.user}`);
    }
  }
  if (config.execution?.allowLocalFallback === true) {
    lines.push('execution.allowLocalFallback: true');
  }
  if (config.execution?.containerized === true) {
    lines.push('execution.containerized: true');
  }
  if (config.execution?.docker) {
    if (config.execution.docker.cpu !== undefined) {
      lines.push(`execution.docker.cpu: ${config.execution.docker.cpu}`);
    }
    if (config.execution.docker.diskMb !== undefined) {
      lines.push(`execution.docker.diskMb: ${config.execution.docker.diskMb}`);
    }
    if (config.execution.docker.image) {
      lines.push(`execution.docker.image: ${config.execution.docker.image}`);
    }
  }
  if (config.execution?.ssh) {
    const ssh = config.execution.ssh;
    lines.push(`execution.ssh.host: ${ssh.host}`);
    if (ssh.user) lines.push(`execution.ssh.user: ${ssh.user}`);
    if (ssh.port !== undefined) lines.push(`execution.ssh.port: ${ssh.port}`);
    if (ssh.identityFile) lines.push(`execution.ssh.identityFile: ${ssh.identityFile}`);
    if (ssh.knownHostsFile) lines.push(`execution.ssh.knownHostsFile: ${ssh.knownHostsFile}`);
    if (ssh.strictHostKeys) lines.push(`execution.ssh.strictHostKeys: ${ssh.strictHostKeys}`);
    if (ssh.remoteWorkdir) lines.push(`execution.ssh.remoteWorkdir: ${ssh.remoteWorkdir}`);
  }
  if (config.baseUrl) lines.push(`baseUrl: ${config.baseUrl}`);
  if (config.apiVersion) lines.push(`apiVersion: ${config.apiVersion}`);
  if (config.region) lines.push(`region: ${config.region}`);
  if (config.awsProfile) lines.push(`awsProfile: ${config.awsProfile}`);
  if (config.contextWindow !== undefined) lines.push(`contextWindow: ${config.contextWindow}`);
  if (config.toolOrder !== undefined) lines.push(`toolOrder: ${config.toolOrder}`);
  if (config.requestTimeoutMs !== undefined)
    lines.push(`requestTimeoutMs: ${config.requestTimeoutMs}`);
  if (config.approvalTimeoutMs !== undefined)
    lines.push(`approvalTimeoutMs: ${config.approvalTimeoutMs}`);
  if (config.allowUnattendedDangerousTools) lines.push('allowUnattendedDangerousTools: true');
  if (config.maxRetries !== undefined) lines.push(`maxRetries: ${config.maxRetries}`);
  if (config.toolPayloadLimitChars !== undefined)
    lines.push(`toolPayloadLimitChars: ${config.toolPayloadLimitChars}`);
  if (config.toolLoading !== undefined) lines.push(`tool_loading: ${config.toolLoading}`);
  if (config.modelRouting) {
    for (const [id, model] of Object.entries(config.modelRouting)) {
      lines.push(`modelRouting.${id}: ${model}`);
    }
  }
  if (config.toolSettings) {
    for (const [id, settings] of Object.entries(config.toolSettings)) {
      if (RESERVED_TOOL_SETTINGS_KEYS.has(id)) continue;
      const ws = settings.web_search;
      if (ws?.provider) lines.push(`toolSettings.${id}.web_search.provider: ${ws.provider}`);
      if (ws?.secret) lines.push(`toolSettings.${id}.web_search.secret: ${ws.secret}`);
      if (ws?.recency) lines.push(`toolSettings.${id}.web_search.recency: ${ws.recency}`);
      // Every other binding key is a field map of secret NAMES — `{ secret }`
      // for a one-provider tool, `{ chatgpt, perplexity }` for `engine_ask` —
      // so one loop over the open key space replaces one hand-written line per
      // key, and one line is written per field. Keys and fields are sorted, so
      // the file is byte-stable across writes. Both are shape-tested before
      // they reach a line: they come from a parsed config or a caller's
      // object, and neither is trusted to be yaml-safe.
      for (const key of Object.keys(settings).sort()) {
        if (key === 'web_search' || RESERVED_TOOL_SETTINGS_KEYS.has(key)) continue;
        if (!SECRET_NAME_RE.test(key)) continue;
        const fields = Object.entries(settings[key] ?? {}).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        );
        for (const [field, value] of fields) {
          if (typeof value !== 'string' || !value) continue;
          if (!SECRET_NAME_RE.test(field) || RESERVED_TOOL_SETTINGS_KEYS.has(field)) continue;
          lines.push(`toolSettings.${id}.${key}.${field}: ${value}`);
        }
      }
    }
  }
  if (config.models) {
    for (const [modelKey, profile] of Object.entries(config.models)) {
      if (profile.sampling) {
        for (const key of ['temperature', 'topP', 'topK', 'minP'] as const) {
          const v = profile.sampling[key];
          if (v !== undefined) lines.push(`models.${modelKey}.sampling.${key}: ${v}`);
        }
      }
      if (profile.toolCallFormat !== undefined) {
        lines.push(`models.${modelKey}.toolCallFormat: ${profile.toolCallFormat}`);
      }
      if (profile.maxOutputTokens !== undefined) {
        lines.push(`models.${modelKey}.maxOutputTokens: ${profile.maxOutputTokens}`);
      }
    }
  }
  if (config.compaction) {
    if (config.compaction.pressure !== undefined) {
      lines.push(`compaction.pressure: ${config.compaction.pressure}`);
    }
    if (config.compaction.target !== undefined) {
      lines.push(`compaction.target: ${config.compaction.target}`);
    }
    if (config.compaction.gateDelta !== undefined) {
      lines.push(`compaction.gateDelta: ${config.compaction.gateDelta}`);
    }
    if (config.compaction.autoCompact !== undefined) {
      lines.push(`compaction.autoCompact: ${config.compaction.autoCompact}`);
    }
    if (config.compaction.retryOnOverflow !== undefined) {
      lines.push(`compaction.retryOnOverflow: ${config.compaction.retryOnOverflow}`);
    }
    if (config.compaction.abortOnSummaryFailure !== undefined) {
      lines.push(`compaction.abortOnSummaryFailure: ${config.compaction.abortOnSummaryFailure}`);
    }
    if (config.compaction.smallWindow !== undefined) {
      lines.push(`compaction.smallWindow: ${config.compaction.smallWindow}`);
    }
    if (config.compaction.maxContextTokens !== undefined) {
      lines.push(`compaction.maxContextTokens: ${config.compaction.maxContextTokens}`);
    }
    if (config.compaction.minTailUserMessages !== undefined) {
      lines.push(`compaction.minTailUserMessages: ${config.compaction.minTailUserMessages}`);
    }
  }
  if (config.callCapture?.personalityId) {
    lines.push(`callCapture.personalityId: ${config.callCapture.personalityId}`);
  }
  if (config.memoryConsolidation) {
    const m = config.memoryConsolidation;
    if (m.enabled !== undefined) lines.push(`memoryConsolidation.enabled: ${m.enabled}`);
    if (m.flushThreshold !== undefined)
      lines.push(`memoryConsolidation.flushThreshold: ${m.flushThreshold}`);
    if (m.timeboxMs !== undefined) lines.push(`memoryConsolidation.timeboxMs: ${m.timeboxMs}`);
    if (m.maxTokens !== undefined) lines.push(`memoryConsolidation.maxTokens: ${m.maxTokens}`);
    if (m.maxDeltaChars !== undefined)
      lines.push(`memoryConsolidation.maxDeltaChars: ${m.maxDeltaChars}`);
    if (m.minMessagesSinceFlush !== undefined)
      lines.push(`memoryConsolidation.minMessagesSinceFlush: ${m.minMessagesSinceFlush}`);
  }
  if (config.activeContext) {
    lines.push(`activeContext.type: ${config.activeContext.type}`);
    lines.push(`activeContext.name: ${config.activeContext.name}`);
  }
  if (config.telegramToken) lines.push(`telegramToken: ${config.telegramToken}`);
  if (config.discordToken) lines.push(`discordToken: ${config.discordToken}`);
  if (config.slackBotToken) lines.push(`slackBotToken: ${config.slackBotToken}`);
  if (config.slackAppToken) lines.push(`slackAppToken: ${config.slackAppToken}`);
  if (config.slackSigningSecret) lines.push(`slackSigningSecret: ${config.slackSigningSecret}`);
  if (config.emailImapHost) lines.push(`emailImapHost: ${config.emailImapHost}`);
  if (config.emailImapPort) lines.push(`emailImapPort: ${config.emailImapPort}`);
  if (config.emailUser) lines.push(`emailUser: ${config.emailUser}`);
  if (config.emailPassword) lines.push(`emailPassword: ${config.emailPassword}`);
  if (config.emailSmtpHost) lines.push(`emailSmtpHost: ${config.emailSmtpHost}`);
  if (config.emailSmtpPort) lines.push(`emailSmtpPort: ${config.emailSmtpPort}`);
  if (config.emailTrustedAuthservId)
    lines.push(`emailTrustedAuthservId: ${config.emailTrustedAuthservId}`);
  if (config.verbose) lines.push('verbose: true');
  if (config.displayVerbosity) lines.push(`display.verbosity: ${config.displayVerbosity}`);
  if (config.displayBusyInputMode)
    lines.push(`display.busy_input_mode: ${config.displayBusyInputMode}`);
  if (config.displayToolPreviewLength !== undefined)
    lines.push(`display.tool_preview_length: ${config.displayToolPreviewLength}`);
  if (config.displayResumeHint === false) lines.push('display.resume_hint: false');
  if (config.displayResumeRecapTurns !== undefined)
    lines.push(`display.resume_recap_turns: ${config.displayResumeRecapTurns}`);
  if (config.displayBellOnComplete) lines.push('display.bell_on_complete: true');
  // `!== undefined`, not truthy: 0 is a meaningful value (notice disabled).
  if (config.displaySlowTurnNoticeMs !== undefined)
    lines.push(`display.slow_turn_notice_ms: ${config.displaySlowTurnNoticeMs}`);
  if (config.displayMemoryNotices !== undefined)
    lines.push(`display.memory_notices: ${config.displayMemoryNotices}`);
  if (config.displayStreamingEdits)
    lines.push(`display.streaming_edits: ${config.displayStreamingEdits}`);
  if (config.displayCallStyle) lines.push(`display.call_style: ${config.displayCallStyle}`);
  if (config.displayCallAccent) lines.push(`display.call_accent: ${config.displayCallAccent}`);
  if (config.displayDebugPanel) lines.push('display.debug_panel: true');
  if (config.displayDebugPanelModel)
    lines.push(`display.debug_panel_model: ${config.displayDebugPanelModel}`);
  if (config.skin) lines.push(`skin: ${config.skin}`);
  if (config.retention) {
    for (const [key, val] of retentionToLines(config.retention)) {
      lines.push(`retention.${key}: ${val}`);
    }
  }
  if (config.personalitiesConfig) {
    for (const [pid, pcfg] of Object.entries(config.personalitiesConfig)) {
      if (pcfg.retention) {
        for (const [key, val] of retentionToLines(pcfg.retention)) {
          lines.push(`personalities.${pid}.retention.${key}: ${val}`);
        }
      }
    }
  }
  if (config.evolverCronEnabled) lines.push('evolver.cron_enabled: true');
  if (config.evolverSchedule) lines.push(`evolver.schedule: ${config.evolverSchedule}`);
  if (config.backgroundMaxConcurrent !== undefined)
    lines.push(`background.max_concurrent: ${config.backgroundMaxConcurrent}`);
  if (config.background) {
    for (const [key, val] of backgroundToLines(config.background)) {
      lines.push(`background.${key}: ${val}`);
    }
  }
  if (config.telegram?.bots.length) {
    for (const [i, bot] of config.telegram.bots.entries()) {
      if (bot.id) lines.push(`telegram.bots.${i}.id: ${bot.id}`);
      lines.push(`telegram.bots.${i}.token: ${bot.token}`);
      lines.push(`telegram.bots.${i}.bind.type: ${bot.bind.type}`);
      lines.push(`telegram.bots.${i}.bind.name: ${bot.bind.name}`);
      if (bot.bind.allowSlashSwitch) {
        lines.push(`telegram.bots.${i}.bind.allowSlashSwitch: true`);
      }
      if (bot.useWebhook !== undefined) {
        lines.push(`telegram.bots.${i}.useWebhook: ${bot.useWebhook}`);
      }
      if (bot.webhookUrl) lines.push(`telegram.bots.${i}.webhookUrl: ${bot.webhookUrl}`);
      if (bot.webhookSecretToken) {
        lines.push(`telegram.bots.${i}.webhookSecretToken: ${bot.webhookSecretToken}`);
      }
      if (bot.dropPendingUpdates !== undefined) {
        lines.push(`telegram.bots.${i}.dropPendingUpdates: ${bot.dropPendingUpdates}`);
      }
      if (bot.defaultChannelMode) {
        lines.push(`telegram.bots.${i}.defaultChannelMode: ${bot.defaultChannelMode}`);
      }
      lines.push(...budgetLines(`telegram.bots.${i}`, bot.budget));
      if (bot.replyPrefix) lines.push(`telegram.bots.${i}.replyPrefix: ${bot.replyPrefix}`);
      if (bot.mentionByName !== undefined) {
        lines.push(`telegram.bots.${i}.mentionByName: ${bot.mentionByName}`);
      }
    }
  }
  if (config.slack?.apps.length) {
    for (const [i, app] of config.slack.apps.entries()) {
      if (app.id) lines.push(`slack.apps.${i}.id: ${app.id}`);
      lines.push(`slack.apps.${i}.botToken: ${app.botToken}`);
      if (app.appToken) lines.push(`slack.apps.${i}.appToken: ${app.appToken}`);
      lines.push(`slack.apps.${i}.signingSecret: ${app.signingSecret}`);
      lines.push(`slack.apps.${i}.bind.type: ${app.bind.type}`);
      lines.push(`slack.apps.${i}.bind.name: ${app.bind.name}`);
      if (app.bind.allowSlashSwitch) {
        lines.push(`slack.apps.${i}.bind.allowSlashSwitch: true`);
      }
      if (app.defaultChannelMode) {
        lines.push(`slack.apps.${i}.defaultChannelMode: ${app.defaultChannelMode}`);
      }
      if (app.receiptReaction) {
        lines.push(`slack.apps.${i}.receiptReaction: ${app.receiptReaction}`);
      }
      if (app.allowedSlashUsers?.length) {
        lines.push(`slack.apps.${i}.allowedSlashUsers: ${app.allowedSlashUsers.join(',')}`);
      }
      if (app.allowedBotIds?.length) {
        lines.push(`slack.apps.${i}.allowedBotIds: ${app.allowedBotIds.join(',')}`);
      }
      if (app.longReplyThresholdChars !== undefined) {
        lines.push(`slack.apps.${i}.longReplyThresholdChars: ${app.longReplyThresholdChars}`);
      }
      if (app.mode?.socket !== undefined) {
        lines.push(`slack.apps.${i}.mode.socket: ${app.mode.socket}`);
      }
      if (app.mode?.http !== undefined) {
        lines.push(`slack.apps.${i}.mode.http: ${app.mode.http}`);
      }
      if (app.webhookPath) lines.push(`slack.apps.${i}.webhookPath: ${app.webhookPath}`);
      lines.push(...budgetLines(`slack.apps.${i}`, app.budget));
      if (app.replyPrefix) lines.push(`slack.apps.${i}.replyPrefix: ${app.replyPrefix}`);
      if (app.mentionByName !== undefined) {
        lines.push(`slack.apps.${i}.mentionByName: ${app.mentionByName}`);
      }
    }
  }
  if (config.whatsapp?.length) {
    for (const [i, wa] of config.whatsapp.entries()) {
      if (wa.id) lines.push(`whatsapp.${i}.id: ${wa.id}`);
      if (wa.default_mode) lines.push(`whatsapp.${i}.default_mode: ${wa.default_mode}`);
      if (wa.session_dir) lines.push(`whatsapp.${i}.session_dir: ${wa.session_dir}`);
      if (wa.phone_number) lines.push(`whatsapp.${i}.phone_number: ${wa.phone_number}`);
      if (wa.allowed_numbers && wa.allowed_numbers.length > 0) {
        lines.push(`whatsapp.${i}.allowed_numbers: ${wa.allowed_numbers.join(',')}`);
      }
      if (wa.bind) {
        lines.push(`whatsapp.${i}.bind.type: ${wa.bind.type}`);
        lines.push(`whatsapp.${i}.bind.name: ${wa.bind.name}`);
        if (wa.bind.allowSlashSwitch) {
          lines.push(`whatsapp.${i}.bind.allowSlashSwitch: true`);
        }
      }
      lines.push(...budgetLines(`whatsapp.${i}`, wa.budget));
    }
  }
  if (config.voice) {
    for (const [i, bot] of config.voice.bots.entries()) {
      if (bot.id) lines.push(`voice.bots.${i}.id: ${bot.id}`);
      lines.push(`voice.bots.${i}.match: ${bot.match}`);
      lines.push(`voice.bots.${i}.bind.type: ${bot.bind.type}`);
      lines.push(`voice.bots.${i}.bind.name: ${bot.bind.name}`);
      if (bot.bind.allowSlashSwitch) {
        lines.push(`voice.bots.${i}.bind.allowSlashSwitch: true`);
      }
    }
    if (config.voice.livekit) {
      lines.push(`voice.livekit.url: ${config.voice.livekit.url}`);
      lines.push(`voice.livekit.apiKey: ${config.voice.livekit.apiKey}`);
      lines.push(`voice.livekit.apiSecret: ${config.voice.livekit.apiSecret}`);
    }
    if (config.voice.trunk) {
      const t = config.voice.trunk;
      lines.push(`voice.trunk.provider: ${t.provider}`);
      lines.push(`voice.trunk.trunkId: ${t.trunkId}`);
      if (t.fromNumber) lines.push(`voice.trunk.fromNumber: ${t.fromNumber}`);
      if (t.username) lines.push(`voice.trunk.username: ${t.username}`);
      if (t.password) lines.push(`voice.trunk.password: ${t.password}`);
      if (t.webhookSecret) lines.push(`voice.trunk.webhookSecret: ${t.webhookSecret}`);
      if (t.webhookPath) lines.push(`voice.trunk.webhookPath: ${t.webhookPath}`);
      if (t.codec) lines.push(`voice.trunk.codec: ${t.codec}`);
    }
    if (config.voice.inbound) {
      const ib = config.voice.inbound;
      if (ib.allowlist?.length) lines.push(`voice.inbound.allowlist: ${ib.allowlist.join(', ')}`);
      if (ib.receptionist) lines.push(`voice.inbound.receptionist: ${ib.receptionist}`);
      if (ib.concurrencyCap !== undefined) {
        lines.push(`voice.inbound.concurrencyCap: ${ib.concurrencyCap}`);
      }
      if (ib.perCallerPerHour !== undefined) {
        lines.push(`voice.inbound.perCallerPerHour: ${ib.perCallerPerHour}`);
      }
      if (ib.dailyBudgetUsd !== undefined) {
        lines.push(`voice.inbound.dailyBudgetUsd: ${ib.dailyBudgetUsd}`);
      }
      if (ib.prewarm) lines.push(`voice.inbound.prewarm: ${ib.prewarm}`);
      // `platform` and `chatId` are unconditional — an owner is only ever built
      // with both, and a half-written destination would round-trip to nothing.
      if (ib.owner) {
        lines.push(`voice.inbound.owner.platform: ${ib.owner.platform}`);
        lines.push(`voice.inbound.owner.chatId: ${ib.owner.chatId}`);
        if (ib.owner.botKey) lines.push(`voice.inbound.owner.botKey: ${ib.owner.botKey}`);
      }
    }
    for (const [surface, tuning] of Object.entries(config.voice.bargeIn ?? {})) {
      if (tuning.energyThreshold !== undefined) {
        lines.push(`voice.bargeIn.${surface}.energyThreshold: ${tuning.energyThreshold}`);
      }
      if (tuning.minSpeechMs !== undefined) {
        lines.push(`voice.bargeIn.${surface}.minSpeechMs: ${tuning.minSpeechMs}`);
      }
      if (tuning.silenceMs !== undefined) {
        lines.push(`voice.bargeIn.${surface}.silenceMs: ${tuning.silenceMs}`);
      }
    }
    if (config.voice.filler) {
      const fl = config.voice.filler;
      if (fl.enabled !== undefined) lines.push(`voice.filler.enabled: ${fl.enabled}`);
      if (fl.afterMs !== undefined) lines.push(`voice.filler.afterMs: ${fl.afterMs}`);
      if (fl.text) lines.push(`voice.filler.text: ${fl.text}`);
      if (fl.tickIntervalMs !== undefined) {
        lines.push(`voice.filler.tickIntervalMs: ${fl.tickIntervalMs}`);
      }
    }
    // Serialized whenever present, INCLUDING the empty list — an empty
    // allowlist is "trust nothing non-local", not "no opinion".
    if (config.voice.trustedPlugins !== undefined) {
      lines.push(`voice.trustedPlugins: ${config.voice.trustedPlugins.join(', ')}`);
    }
    if (config.voice.defaultMode) {
      lines.push(`voice.defaultMode: ${config.voice.defaultMode}`);
    }
    if (config.voice.tier) {
      lines.push(`voice.tier: ${config.voice.tier}`);
    }
    for (const [platform, entry] of Object.entries(config.voice.channels ?? {})) {
      if (entry.ttsOut !== undefined) {
        lines.push(`voice.channels.${platform}.ttsOut: ${entry.ttsOut}`);
      }
    }
    if (config.voice.transcode) {
      const tc = config.voice.transcode;
      if (tc.ffmpegPath) lines.push(`voice.transcode.ffmpegPath: ${tc.ffmpegPath}`);
      if (tc.bitrateKbps !== undefined)
        lines.push(`voice.transcode.bitrateKbps: ${tc.bitrateKbps}`);
      if (tc.timeout !== undefined) lines.push(`voice.transcode.timeout: ${tc.timeout}`);
    }
    if (config.voice.artifacts) {
      const ar = config.voice.artifacts;
      if (ar.abandonAfterDays !== undefined) {
        lines.push(`voice.artifacts.abandonAfterDays: ${ar.abandonAfterDays}`);
      }
      if (ar.maxTotalMb !== undefined) lines.push(`voice.artifacts.maxTotalMb: ${ar.maxTotalMb}`);
    }
    if (config.voice.wake) {
      const wk = config.voice.wake;
      if (wk.enabled !== undefined) lines.push(`voice.wake.enabled: ${wk.enabled}`);
      if (wk.engine) lines.push(`voice.wake.engine: ${wk.engine}`);
      if (wk.sensitivity !== undefined) lines.push(`voice.wake.sensitivity: ${wk.sensitivity}`);
      if (wk.confirmationFrames !== undefined) {
        lines.push(`voice.wake.confirmationFrames: ${wk.confirmationFrames}`);
      }
      if (wk.edgeStt !== undefined) lines.push(`voice.wake.edgeStt: ${wk.edgeStt}`);
      if (wk.idleTimeout !== undefined) lines.push(`voice.wake.idleTimeout: ${wk.idleTimeout}`);
      // `phrase` and `personality` are unconditional — a route is only ever
      // built with both, and a half-written route would round-trip to nothing.
      for (const [id, route] of Object.entries(wk.routes ?? {})) {
        lines.push(`voice.wake.routes.${id}.phrase: ${route.phrase}`);
        lines.push(`voice.wake.routes.${id}.personality: ${route.personality}`);
        if (route.privileged !== undefined) {
          lines.push(`voice.wake.routes.${id}.privileged: ${route.privileged}`);
        }
        if (route.enabled !== undefined) {
          lines.push(`voice.wake.routes.${id}.enabled: ${route.enabled}`);
        }
      }
      for (const [id, node] of Object.entries(wk.nodes ?? {})) {
        if (node.inputDevice) {
          lines.push(`voice.wake.nodes.${id}.inputDevice: ${node.inputDevice}`);
        }
        if (node.enabled !== undefined) {
          lines.push(`voice.wake.nodes.${id}.enabled: ${node.enabled}`);
        }
      }
    }
    // Always the NEW spelling, whichever one was read. A config parsed from
    // `voice.providers.*` re-serializes as `voice.tts.providers.*` and never
    // carries both.
    for (const [name, entry] of Object.entries(config.voice.tts?.providers ?? {})) {
      lines.push(
        ...voiceProviderEntryLines(`voice.tts.providers.${name}`, entry, TTS_ENTRY_FIELDS),
      );
    }
    for (const [name, entry] of Object.entries(config.voice.stt?.providers ?? {})) {
      lines.push(
        ...voiceProviderEntryLines(`voice.stt.providers.${name}`, entry, STT_ENTRY_FIELDS),
      );
    }
    for (const [name, entry] of Object.entries(config.voice.realtime?.providers ?? {})) {
      lines.push(
        ...voiceProviderEntryLines(
          `voice.realtime.providers.${name}`,
          entry,
          REALTIME_ENTRY_FIELDS,
        ),
      );
    }
    if (config.voice.realtime?.default) {
      lines.push(`voice.realtime.default: ${config.voice.realtime.default}`);
    }
    if (config.voice.realtime?.sessionBudgetUsd !== undefined) {
      lines.push(`voice.realtime.sessionBudgetUsd: ${config.voice.realtime.sessionBudgetUsd}`);
    }
  }
  if (config.teams) {
    for (const [name, tcfg] of Object.entries(config.teams)) {
      if (tcfg.autoStop) lines.push(`teams.${name}.autoStop: true`);
    }
  }
  if (config.quick_commands) {
    for (const [name, qc] of Object.entries(config.quick_commands)) {
      lines.push(`quick_commands.${name}.type: ${qc.type}`);
      if (qc.type === 'exec') {
        lines.push(`quick_commands.${name}.command: ${qc.command}`);
      } else {
        lines.push(`quick_commands.${name}.reply: ${qc.reply}`);
      }
      if (qc.gateway) lines.push(`quick_commands.${name}.gateway: true`);
      if (qc.channels && qc.channels.length > 0) {
        lines.push(`quick_commands.${name}.channels: ${qc.channels.join(',')}`);
      }
    }
  }
  if (config.channelToolsets) {
    for (const [platform, tools] of Object.entries(config.channelToolsets)) {
      lines.push(`channel_toolsets.${platform}: ${tools.join(',')}`);
    }
  }
  if (config.channelFilter) {
    for (const [platform, cfg] of Object.entries(config.channelFilter)) {
      if (cfg.enabled === false) lines.push(`channel_filter.${platform}.enable: false`);
      if (cfg.ownerUserId) lines.push(`channel_filter.${platform}.ownerUserId: ${cfg.ownerUserId}`);
      if (cfg.recipientAllowlist && cfg.recipientAllowlist.length > 0) {
        lines.push(
          `channel_filter.${platform}.recipientAllowlist: ${cfg.recipientAllowlist.join(',')}`,
        );
      }
      if (cfg.dmPolicy) lines.push(`channel_filter.${platform}.dmPolicy: ${cfg.dmPolicy}`);
      if (cfg.contextVisibility)
        lines.push(`channel_filter.${platform}.contextVisibility: ${cfg.contextVisibility}`);
      // Raw here: `renderConfigLine` (the end of this function) runs every line
      // through `renderConfigScalar`, the single owner of `quoteConfigScalar`
      // spelling; quoting here too would double-quote it.
      if (cfg.declineMessage)
        lines.push(`channel_filter.${platform}.declineMessage: ${cfg.declineMessage}`);
    }
  }
  for (const [key, value] of renderProviderChain(config.providers ?? [])) {
    lines.push(`${key}: ${value}`);
  }
  if (config.auxiliary?.compression) {
    const c = config.auxiliary.compression;
    lines.push(`auxiliary.compression.model: ${c.model}`);
    if (c.provider) lines.push(`auxiliary.compression.provider: ${c.provider}`);
    if (c.apiKey) lines.push(`auxiliary.compression.apiKey: ${c.apiKey}`);
    if (c.baseUrl) lines.push(`auxiliary.compression.baseUrl: ${c.baseUrl}`);
  }
  if (config.auxiliary?.vision) {
    const v = config.auxiliary.vision;
    lines.push(`auxiliary.vision.model: ${v.model}`);
    if (v.provider) lines.push(`auxiliary.vision.provider: ${v.provider}`);
    if (v.apiKey) lines.push(`auxiliary.vision.apiKey: ${v.apiKey}`);
    if (v.baseUrl) lines.push(`auxiliary.vision.baseUrl: ${v.baseUrl}`);
  }
  if (config.auxiliary?.web) {
    const w = config.auxiliary.web;
    lines.push(`auxiliary.web.model: ${w.model}`);
    if (w.provider) lines.push(`auxiliary.web.provider: ${w.provider}`);
    if (w.apiKey) lines.push(`auxiliary.web.apiKey: ${w.apiKey}`);
    if (w.baseUrl) lines.push(`auxiliary.web.baseUrl: ${w.baseUrl}`);
  }
  if (config.auxiliary?.asr) {
    lines.push(...voiceProviderEntryLines('auxiliary.asr', config.auxiliary.asr, STT_ENTRY_FIELDS));
  }
  if (config.auxiliary?.tts) {
    lines.push(...voiceProviderEntryLines('auxiliary.tts', config.auxiliary.tts, TTS_ENTRY_FIELDS));
  }
  if (config.web?.search_backend) lines.push(`web.search_backend: ${config.web.search_backend}`);
  if (config.web?.extract_backend) lines.push(`web.extract_backend: ${config.web.extract_backend}`);
  if (config.web?.host) lines.push(`web.host: ${config.web.host}`);
  if (config.web?.port !== undefined) lines.push(`web.port: ${config.web.port}`);
  if (config.web?.corsOrigins) lines.push(`web.corsOrigins: ${config.web.corsOrigins}`);
  if (config.web?.searxng?.url) lines.push(`web.searxng.url: ${config.web.searxng.url}`);
  if (config.webhooks) {
    for (const [hookId, hook] of Object.entries(config.webhooks)) {
      lines.push(`webhooks.${hookId}.personalityId: ${hook.personalityId}`);
      lines.push(`webhooks.${hookId}.secret: ${hook.secret}`);
      if (hook.sessionKey) lines.push(`webhooks.${hookId}.sessionKey: ${hook.sessionKey}`);
      if (hook.prefilter) lines.push(`webhooks.${hookId}.prefilter: ${hook.prefilter}`);
      if (hook.prefilterTimeoutSeconds !== undefined)
        lines.push(`webhooks.${hookId}.prefilterTimeoutSeconds: ${hook.prefilterTimeoutSeconds}`);
      if (hook.mode) lines.push(`webhooks.${hookId}.mode: ${hook.mode}`);
      if (hook.events?.length) lines.push(`webhooks.${hookId}.events: ${hook.events.join(', ')}`);
      if (hook.eventHeader) lines.push(`webhooks.${hookId}.eventHeader: ${hook.eventHeader}`);
      if (hook.eventField) lines.push(`webhooks.${hookId}.eventField: ${hook.eventField}`);
      // Only `true` is emitted: an explicit `false` and an absent key mean the
      // same thing, and the parser rejects any other spelling on the way back.
      if (hook.deliverOnly === true) lines.push(`webhooks.${hookId}.deliverOnly: true`);
      if (hook.private === true) lines.push(`webhooks.${hookId}.private: true`);
      for (const [i, target] of (hook.deliver ?? []).entries()) {
        const key = `webhooks.${hookId}.deliver.${i}`;
        lines.push(`${key}.type: ${target.type}`);
        if (target.type === 'platform') {
          lines.push(`${key}.adapterId: ${target.adapterId}`);
          lines.push(`${key}.chatId: ${target.chatId}`);
          if (target.threadId) lines.push(`${key}.threadId: ${target.threadId}`);
        }
      }
      if (hook.hmac) {
        lines.push(`webhooks.${hookId}.hmac.secret: ${hook.hmac.secret}`);
        if (hook.hmac.header) lines.push(`webhooks.${hookId}.hmac.header: ${hook.hmac.header}`);
        if (hook.hmac.algorithm)
          lines.push(`webhooks.${hookId}.hmac.algorithm: ${hook.hmac.algorithm}`);
        if (hook.hmac.previousSecret)
          lines.push(`webhooks.${hookId}.hmac.previousSecret: ${hook.hmac.previousSecret}`);
      }
      if (hook.rateLimit) {
        if (hook.rateLimit.maxPerMinute !== undefined)
          lines.push(`webhooks.${hookId}.rateLimit.maxPerMinute: ${hook.rateLimit.maxPerMinute}`);
        if (hook.rateLimit.lockoutSeconds !== undefined)
          lines.push(
            `webhooks.${hookId}.rateLimit.lockoutSeconds: ${hook.rateLimit.lockoutSeconds}`,
          );
      }
    }
  }
  if (config.modelCatalog) {
    if (config.modelCatalog.enabled === false) lines.push('modelCatalog.enabled: false');
    if (config.modelCatalog.url) lines.push(`modelCatalog.url: ${config.modelCatalog.url}`);
    if (config.modelCatalog.ttlHours !== undefined)
      lines.push(`modelCatalog.ttlHours: ${config.modelCatalog.ttlHours}`);
    if (config.modelCatalog.providers) {
      for (const [id, p] of Object.entries(config.modelCatalog.providers)) {
        lines.push(`modelCatalog.providers.${id}.url: ${p.url}`);
      }
    }
  }
  if (config.modelRegistry) lines.push(...renderModelRegistry(config.modelRegistry));
  if (config.logs?.rotation) {
    const r = config.logs.rotation;
    if (r.maxBytes !== undefined) lines.push(`logs.rotation.maxBytes: ${r.maxBytes}`);
    if (r.maxFiles !== undefined) lines.push(`logs.rotation.maxFiles: ${r.maxFiles}`);
    if (r.enabled === false) lines.push('logs.rotation.enabled: false');
  }
  if (config.logs?.level !== undefined) lines.push(`logs.level: ${config.logs.level}`);
  if (config.aws?.secrets) {
    const s = config.aws.secrets;
    if (s.enabled !== undefined) lines.push(`aws.secrets.enabled: ${s.enabled}`);
    if (s.region) lines.push(`aws.secrets.region: ${s.region}`);
    if (s.prefix) lines.push(`aws.secrets.prefix: ${s.prefix}`);
    if (s.endpoint) lines.push(`aws.secrets.endpoint: ${s.endpoint}`);
  }
  if (config.webBaseUrl) lines.push(`webBaseUrl: ${config.webBaseUrl}`);
  if (config.pluginsAutoInstall !== undefined)
    lines.push(`plugins.auto_install: ${config.pluginsAutoInstall}`);
  if (config.pluginIsolation) {
    const pi = config.pluginIsolation;
    lines.push(`plugins.isolation: ${pi.default}`);
    for (const id of Object.keys(pi.overrides).sort()) {
      lines.push(`plugins.isolation.${id}: ${pi.overrides[id]}`);
    }
    lines.push(`plugins.host.sandbox: ${pi.sandbox}`);
    lines.push(`plugins.host.hook_timeout_ms: ${pi.hookTimeoutMs}`);
    lines.push(`plugins.host.idle_stop_minutes: ${pi.idleStopMinutes}`);
    lines.push(`plugins.host.max_heap_mb: ${pi.maxHeapMb}`);
  }
  if (config.admin?.enabled !== undefined) lines.push(`admin.enabled: ${config.admin.enabled}`);
  if (config.a2a?.enabled !== undefined) lines.push(`a2a.enabled: ${config.a2a.enabled}`);
  if (config.a2a?.peering?.allowPrivateUrls !== undefined)
    lines.push(`a2a.peering.allowPrivateUrls: ${config.a2a.peering.allowPrivateUrls}`);
  if (config.goals?.allowCheckCommands !== undefined)
    lines.push(`goals.allowCheckCommands: ${config.goals.allowCheckCommands}`);
  // Written even when the list is empty — `""` is how "trust no org" survives
  // a round-trip, and dropping the line would silently restore the default.
  if (config.security?.trustedGitHubOrgs !== undefined)
    lines.push(
      `security.trusted_github_orgs: ${
        config.security.trustedGitHubOrgs.length > 0
          ? config.security.trustedGitHubOrgs.join(',')
          : '""'
      }`,
    );
  if (config.nightlyPass) {
    if (config.nightlyPass.enabled !== undefined)
      lines.push(`nightlyPass.enabled: ${config.nightlyPass.enabled}`);
    if (config.nightlyPass.cron) lines.push(`nightlyPass.cron: ${config.nightlyPass.cron}`);
  }
  if (config.backup) {
    const bk = config.backup;
    if (bk.enabled !== undefined) lines.push(`backup.enabled: ${bk.enabled}`);
    if (bk.cron) lines.push(`backup.cron: ${bk.cron}`);
    if (bk.scope && bk.scope.length > 0) lines.push(`backup.scope: ${bk.scope.join(',')}`);
    if (bk.keep !== undefined) lines.push(`backup.keep: ${bk.keep}`);
    if (bk.dir) lines.push(`backup.dir: ${bk.dir}`);
  }
  if (config.memoryCapture) {
    const mc = config.memoryCapture;
    if (mc.enabled !== undefined) lines.push(`memoryCapture.enabled: ${mc.enabled}`);
    if (mc.model) lines.push(`memoryCapture.model: ${mc.model}`);
    if (mc.provider) lines.push(`memoryCapture.provider: ${mc.provider}`);
    if (mc.apiKey) lines.push(`memoryCapture.apiKey: ${mc.apiKey}`);
    if (mc.baseUrl) lines.push(`memoryCapture.baseUrl: ${mc.baseUrl}`);
    if (mc.maxPerHour !== undefined) lines.push(`memoryCapture.maxPerHour: ${mc.maxPerHour}`);
    if (mc.maxPerDay !== undefined) lines.push(`memoryCapture.maxPerDay: ${mc.maxPerDay}`);
    if (mc.evidenceSessions !== undefined)
      lines.push(`memoryCapture.evidenceSessions: ${mc.evidenceSessions}`);
  }
  if (config.memoryVault) {
    const mv = config.memoryVault;
    if (mv.path) lines.push(`memoryVault.path: ${mv.path}`);
    if (mv.agentDir) lines.push(`memoryVault.agentDir: ${mv.agentDir}`);
    if (mv.prefetch && mv.prefetch.length > 0)
      lines.push(`memoryVault.prefetch: ${mv.prefetch.join(', ')}`);
    if (mv.exclude && mv.exclude.length > 0)
      lines.push(`memoryVault.exclude: ${mv.exclude.join(', ')}`);
  }
  if (config.memoryApproval) {
    const ma = config.memoryApproval;
    if (ma.mode !== undefined) lines.push(`memoryApproval.mode: ${ma.mode}`);
    if (ma.cap !== undefined) lines.push(`memoryApproval.cap: ${ma.cap}`);
    if (ma.ttlDays !== undefined) lines.push(`memoryApproval.ttlDays: ${ma.ttlDays}`);
  }
  if (config.memoryConsolidation) {
    const mco = config.memoryConsolidation;
    if (mco.halfLifeDays !== undefined)
      lines.push(`memoryConsolidation.halfLifeDays: ${mco.halfLifeDays}`);
    if (mco.threshold !== undefined) lines.push(`memoryConsolidation.threshold: ${mco.threshold}`);
    if (mco.exemptUser !== undefined)
      lines.push(`memoryConsolidation.exemptUser: ${mco.exemptUser}`);
  }
  if (config.weeklyDigest) {
    if (config.weeklyDigest.enabled !== undefined)
      lines.push(`weeklyDigest.enabled: ${config.weeklyDigest.enabled}`);
    if (config.weeklyDigest.cron) lines.push(`weeklyDigest.cron: ${config.weeklyDigest.cron}`);
    if (config.weeklyDigest.recipients && config.weeklyDigest.recipients.length > 0)
      lines.push(`weeklyDigest.recipients: ${config.weeklyDigest.recipients.join(',')}`);
  }
  if (config.channelDigest) {
    const cd = config.channelDigest;
    if (cd.enabled !== undefined) lines.push(`channelDigest.enabled: ${cd.enabled}`);
    if (cd.cron) lines.push(`channelDigest.cron: ${cd.cron}`);
    if (cd.deliverTo) lines.push(`channelDigest.deliverTo: ${cd.deliverTo}`);
    if (cd.maxMessagesPerLane !== undefined)
      lines.push(`channelDigest.maxMessagesPerLane: ${cd.maxMessagesPerLane}`);
    if (cd.maxLanesPerRun !== undefined)
      lines.push(`channelDigest.maxLanesPerRun: ${cd.maxLanesPerRun}`);
    if (cd.costWarnUsdPerLane !== undefined)
      lines.push(`channelDigest.costWarnUsdPerLane: ${cd.costWarnUsdPerLane}`);
  }
  if (config.learningReplay) {
    const lr = config.learningReplay;
    if (lr.enabled !== undefined) lines.push(`learningReplay.enabled: ${lr.enabled}`);
    if (lr.maxCases !== undefined) lines.push(`learningReplay.maxCases: ${lr.maxCases}`);
    if (lr.maxCostUsd !== undefined) lines.push(`learningReplay.maxCostUsd: ${lr.maxCostUsd}`);
    if (lr.maxCandidatesPerRun !== undefined)
      lines.push(`learningReplay.maxCandidatesPerRun: ${lr.maxCandidatesPerRun}`);
  }
  if (config.toolLoop) {
    if (config.toolLoop.maxToolCallsWarnAt !== undefined)
      lines.push(`toolLoop.maxToolCallsWarnAt: ${config.toolLoop.maxToolCallsWarnAt}`);
    if (config.toolLoop.maxIdenticalToolCallsWarnAt !== undefined)
      lines.push(
        `toolLoop.maxIdenticalToolCallsWarnAt: ${config.toolLoop.maxIdenticalToolCallsWarnAt}`,
      );
    if (config.toolLoop.maxToolCallsPerTurn !== undefined)
      lines.push(`toolLoop.maxToolCallsPerTurn: ${config.toolLoop.maxToolCallsPerTurn}`);
    if (config.toolLoop.maxIdenticalToolCalls !== undefined)
      lines.push(`toolLoop.maxIdenticalToolCalls: ${config.toolLoop.maxIdenticalToolCalls}`);
  }
  if (config.mcp?.discoveryConcurrency !== undefined)
    lines.push(`mcp.discoveryConcurrency: ${config.mcp.discoveryConcurrency}`);
  if (config.cron) {
    // KNOWN HAZARD, mirrored not fixed: `cron.fireUrl` may have arrived from
    // ETHOS_CRON_FIRE_URL rather than the yaml (the parse folds the env
    // override into the config), so a writeConfig on a process started with
    // that variable bakes the env value into config.yaml. `pauseLifecycle.
    // http.url` behaves identically with ETHOS_ORCHESTRATOR_URL; we follow the
    // precedent rather than diverge from it. Fixing both at once is an
    // out-of-scope follow-up (plan/phases/cron-fire-url-collapse.md, N3).
    if (config.cron.fireUrl !== undefined) {
      lines.push(`cron.fireUrl: ${config.cron.fireUrl}`);
    }
    if (config.cron.maxParallelJobs !== undefined) {
      lines.push(`cron.maxParallelJobs: ${config.cron.maxParallelJobs}`);
    }
    if (config.cron.defaultMaxRunMs !== undefined) {
      lines.push(`cron.defaultMaxRunMs: ${config.cron.defaultMaxRunMs}`);
    }
  }
  if (config.notifications) {
    const n = config.notifications;
    if (n.quietHours !== undefined) lines.push(`notifications.quietHours: ${n.quietHours}`);
    if (n.timezone !== undefined) lines.push(`notifications.timezone: ${n.timezone}`);
    for (const [botKey, entry] of Object.entries(n.bots ?? {})) {
      lines.push(`notifications.bots.${botKey}.quietHours: ${entry.quietHours}`);
    }
  }
  if (config.kanban) {
    if (config.kanban.maxInProgress !== undefined)
      lines.push(`kanban.maxInProgress: ${config.kanban.maxInProgress}`);
    if (config.kanban.maxInProgressPerProfile !== undefined)
      lines.push(`kanban.maxInProgressPerProfile: ${config.kanban.maxInProgressPerProfile}`);
  }
  if (config.grounding) {
    const gr = config.grounding;
    if (gr.enabled !== undefined) lines.push(`grounding.enabled: ${gr.enabled}`);
    if (gr.onFinding !== undefined) lines.push(`grounding.onFinding: ${gr.onFinding}`);
    if (gr.showUnsupported !== undefined)
      lines.push(`grounding.showUnsupported: ${gr.showUnsupported}`);
    if (gr.memoryTag !== undefined) lines.push(`grounding.memoryTag: ${gr.memoryTag}`);
    if (gr.kanban?.checks !== undefined) lines.push(`grounding.kanban.checks: ${gr.kanban.checks}`);
    // Comma-joined, not space-joined: a check command is itself several words
    // (`pnpm test`), so the separator has to be something a command cannot
    // contain.
    if (gr.kanban?.allowedCheckCommands !== undefined)
      lines.push(
        `grounding.kanban.allowedCheckCommands: ${gr.kanban.allowedCheckCommands.join(', ')}`,
      );
  }
  if (config.browser) {
    const brw = config.browser;
    if (brw.navigationTimeoutMs !== undefined)
      lines.push(`browser.navigationTimeoutMs: ${brw.navigationTimeoutMs}`);
    if (brw.commandTimeoutMs !== undefined)
      lines.push(`browser.commandTimeoutMs: ${brw.commandTimeoutMs}`);
    if (brw.headed !== undefined) lines.push(`browser.headed: ${brw.headed}`);
    if (brw.idleTimeoutMs !== undefined) lines.push(`browser.idleTimeoutMs: ${brw.idleTimeoutMs}`);
    if (brw.stealth?.enabled !== undefined)
      lines.push(`browser.stealth.enabled: ${brw.stealth.enabled}`);
    if (brw.profiles?.enabled !== undefined)
      lines.push(`browser.profiles.enabled: ${brw.profiles.enabled}`);
    if (brw.proxy) {
      // `server` is required by the type — a proxy block without one never
      // survives the parse, so there is nothing to guard here.
      lines.push(`browser.proxy.server: ${brw.proxy.server}`);
      if (brw.proxy.username) lines.push(`browser.proxy.username: ${brw.proxy.username}`);
      // Already a `${secrets:…}` reference by this point: writeConfig
      // externalizes before serializing, so no credential value is written.
      if (brw.proxy.password) lines.push(`browser.proxy.password: ${brw.proxy.password}`);
    }
  }
  if (config.gateway?.maxInboundMediaBytes !== undefined) {
    lines.push(`gateway.maxInboundMediaBytes: ${config.gateway.maxInboundMediaBytes}`);
  }
  if (config.gateway?.inboundSpool?.maxAttempts !== undefined) {
    lines.push(`gateway.inboundSpool.maxAttempts: ${config.gateway.inboundSpool.maxAttempts}`);
  }
  if (config.gateway?.inboundSpool?.maxReplayAgeMs !== undefined) {
    lines.push(
      `gateway.inboundSpool.maxReplayAgeMs: ${config.gateway.inboundSpool.maxReplayAgeMs}`,
    );
  }
  for (const [platform, ids] of Object.entries(config.gateway?.privateChats ?? {})) {
    if (ids.length > 0) lines.push(`gateway.private_chats.${platform}: ${ids.join(',')}`);
  }
  if (config.channels) lines.push(...channelsToLines(config.channels));
  if (config.decisions) lines.push(...serializeDecisionsLines(config.decisions));
  if (config.teamSupervisor?.restartLoopGuard) {
    const rg = config.teamSupervisor.restartLoopGuard;
    if (rg.maxRestarts !== undefined)
      lines.push(`teamSupervisor.restartLoopGuard.maxRestarts: ${rg.maxRestarts}`);
    if (rg.windowSeconds !== undefined)
      lines.push(`teamSupervisor.restartLoopGuard.windowSeconds: ${rg.windowSeconds}`);
  }
  if (config.discord?.defaultChannelMode) {
    lines.push(`discord.defaultChannelMode: ${config.discord.defaultChannelMode}`);
  }
  if (config.discord?.approvalRoleIds && config.discord.approvalRoleIds.length > 0) {
    lines.push(`discord.approvalRoleIds: ${config.discord.approvalRoleIds.join(',')}`);
  }
  if (config.discord?.replyPrefix) {
    lines.push(`discord.replyPrefix: ${config.discord.replyPrefix}`);
  }
  if (config.discord?.mentionByName !== undefined) {
    lines.push(`discord.mentionByName: ${config.discord.mentionByName}`);
  }
  if (config.discord?.missedMessageBackfill) {
    const bf = config.discord.missedMessageBackfill;
    if (bf.enabled !== undefined)
      lines.push(`discord.missedMessageBackfill.enabled: ${bf.enabled}`);
    if (bf.windowSeconds !== undefined)
      lines.push(`discord.missedMessageBackfill.windowSeconds: ${bf.windowSeconds}`);
    if (bf.limit !== undefined) lines.push(`discord.missedMessageBackfill.limit: ${bf.limit}`);
  }
  if (config.discordPostThinkingPlaceholder !== undefined) {
    lines.push(`discord.post_thinking_placeholder: ${config.discordPostThinkingPlaceholder}`);
  }
  if (config.kanbanPoll) {
    if (config.kanbanPoll.enabled !== undefined)
      lines.push(`kanbanPoll.enabled: ${config.kanbanPoll.enabled}`);
    if (config.kanbanPoll.intervalMs !== undefined)
      lines.push(`kanbanPoll.intervalMs: ${config.kanbanPoll.intervalMs}`);
    if (config.kanbanPoll.boardPath !== undefined)
      lines.push(`kanbanPoll.boardPath: ${config.kanbanPoll.boardPath}`);
  }
  lines.push(...idleWatcherLines(config.idleWatcher));
  lines.push(...shareLinksLines(config.shareLinks));
  lines.push(...worldLines(config.world));
  if (config.nodes?.enabled !== undefined) lines.push(`nodes.enabled: ${config.nodes.enabled}`);
  if (config.pauseClockCorrection) {
    const pcc = config.pauseClockCorrection;
    if (pcc.enabled !== undefined) lines.push(`pauseClockCorrection.enabled: ${pcc.enabled}`);
    if (pcc.thresholdMs !== undefined)
      lines.push(`pauseClockCorrection.thresholdMs: ${pcc.thresholdMs}`);
  }
  if (config.pauseLifecycle?.http) {
    const plh = config.pauseLifecycle.http;
    if (plh.url) lines.push(`pauseLifecycle.http.url: ${plh.url}`);
    if (plh.token) lines.push(`pauseLifecycle.http.token: ${plh.token}`);
    if (plh.timeoutMs !== undefined) lines.push(`pauseLifecycle.http.timeoutMs: ${plh.timeoutMs}`);
  }
  if (config.telemetry?.export?.langfuse) {
    const lf = config.telemetry.export.langfuse;
    if (lf.enabled !== undefined) lines.push(`telemetry.export.langfuse.enabled: ${lf.enabled}`);
    if (lf.baseUrl) lines.push(`telemetry.export.langfuse.baseUrl: ${lf.baseUrl}`);
    if (lf.publicKey) lines.push(`telemetry.export.langfuse.publicKey: ${lf.publicKey}`);
    if (lf.secretKey) lines.push(`telemetry.export.langfuse.secretKey: ${lf.secretKey}`);
  }
  if (config.telemetry?.export?.otlp) {
    const otlp = config.telemetry.export.otlp;
    if (otlp.enabled !== undefined) lines.push(`telemetry.export.otlp.enabled: ${otlp.enabled}`);
    if (otlp.endpoint) lines.push(`telemetry.export.otlp.endpoint: ${otlp.endpoint}`);
    for (const [name, value] of Object.entries(otlp.headers ?? {})) {
      // Values reaching here are `${secrets:…}` refs — `writeConfig`
      // externalized them (D7) before serialization.
      lines.push(`telemetry.export.otlp.headers.${name}: ${value}`);
    }
    if (otlp.includeContent !== undefined)
      lines.push(`telemetry.export.otlp.includeContent: ${otlp.includeContent}`);
    if (otlp.intervalMs !== undefined)
      lines.push(`telemetry.export.otlp.intervalMs: ${otlp.intervalMs}`);
    if (otlp.backlogMaxAgeMs !== undefined)
      lines.push(`telemetry.export.otlp.backlogMaxAgeMs: ${otlp.backlogMaxAgeMs}`);
  }
  // Every value in the one spelling `parseConfigScalar` reads back unchanged.
  return lines.map(renderConfigLine);
}
