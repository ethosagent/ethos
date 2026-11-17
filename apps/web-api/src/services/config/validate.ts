import { isVoiceChannelPlatform, VOICE_CHANNEL_PLATFORMS } from '@ethosagent/config';
import { EthosError, RETENTION_NO_PERSONALITY_SCOPE } from '@ethosagent/types';
import {
  LOG_LEVELS,
  RECORD_KEY_RE,
  RETENTION_DURATION_RE,
  RETENTION_SUBKEYS,
  type RetentionSubkey,
  VOICE_BARGE_IN_SURFACES,
  VOICE_INBOUND_PREWARM_MODES,
  VOICE_TRUNK_CODECS,
  VOICE_TRUNK_PROVIDERS,
} from './constants';
import type { ConfigUpdateInput } from './update-input';

// -- update-patch validation -------------------------------------------------
// Mirrors packages/config's parse validation so a direct (non-RPC) caller
// can't persist values the CLI loader would reject or silently drop. The RPC
// layer re-enforces the same bounds via Zod in @ethosagent/web-contracts.

export function invalidValue(field: string, requirement: string): never {
  throw new EthosError({
    code: 'CONFIG_INVALID',
    cause: `${field} ${requirement}`,
    action: 'Correct the value and retry the update.',
  });
}

function checkFraction(field: string, v: number | null | undefined): void {
  if (v === undefined || v === null) return;
  if (!Number.isFinite(v) || v <= 0 || v > 1) invalidValue(field, 'must be a fraction in (0,1]');
}

function checkInt(
  field: string,
  v: number | null | undefined,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): void {
  if (v === undefined || v === null) return;
  if (!Number.isInteger(v) || v < min || v > max) {
    invalidValue(
      field,
      max === Number.MAX_SAFE_INTEGER
        ? `must be an integer >= ${min}`
        : `must be an integer between ${min} and ${max}`,
    );
  }
}

/**
 * A strict boolean. `checkInt`'s sibling for the `browser.*` flags, which
 * `@ethosagent/config`'s `buildBrowser` treats as FATAL at boot when malformed
 * rather than dropping — a direct (non-RPC) caller handing us `'yes'` would
 * write a config.yaml the next `ethos` start refuses to load.
 */
function checkBool(field: string, v: boolean | null | undefined): void {
  if (v === undefined || v === null) return;
  if (typeof v !== 'boolean') invalidValue(field, 'must be true or false');
}

function checkNonNegative(field: string, v: number | null | undefined): void {
  if (v === undefined || v === null) return;
  if (!Number.isFinite(v) || v < 0) invalidValue(field, 'must be a non-negative number');
}

function checkPositive(field: string, v: number | null | undefined): void {
  if (v === undefined || v === null) return;
  if (!Number.isFinite(v) || v <= 0) invalidValue(field, 'must be a positive number');
}

/**
 * Proxy schemes Playwright accepts. Mirrors `BROWSER_PROXY_SCHEMES` /
 * `browserProxyServerProblem` / `BROWSER_PROXY_ENDPOINT_ONLY` in
 * `@ethosagent/config`, which are module-private there — duplicated rather
 * than exported, and the two must change together.
 *
 * A bare `host:port` is refused rather than guessed at: `new URL('p:3128')`
 * parses `p:` as the scheme, so guessing would accept a string that points
 * nowhere and every request would silently go direct.
 *
 * `browser.proxy.server` is an ENDPOINT, never a URL with credentials in it.
 * `http://user:pass@proxy.example:3128` is the form most proxy documentation
 * uses and the one form that must not be accepted: the password would sit in
 * `config.yaml` in plaintext, come back unredacted through `proxyServer` on
 * the read path (which, unlike `proxyPasswordPreview`, is not redacted), and
 * route around the vaulting `proxyPassword` gets. The offending value is never
 * echoed back — it is the credential.
 */
const BROWSER_PROXY_SCHEMES = new Set(['http:', 'https:', 'socks4:', 'socks5:']);

const BROWSER_PROXY_ENDPOINT_ONLY =
  'must be an endpoint only — scheme, host and port, e.g. http://proxy.example.com:3128. ' +
  'A username, password, path, query or fragment in the URL is refused: put credentials in ' +
  'browser.proxy.username and browser.proxy.password, which are vaulted in the secret store ' +
  'instead of written into config.yaml in plaintext.';

function browserProxyServerProblem(value: string): 'scheme' | 'endpoint' | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return 'scheme';
  }
  if (!BROWSER_PROXY_SCHEMES.has(u.protocol) || u.hostname.length === 0) return 'scheme';
  if (u.username !== '' || u.password !== '') return 'endpoint';
  if (u.search !== '' || u.hash !== '') return 'endpoint';
  // `''` for a non-special scheme (socks4/socks5), `'/'` for http(s).
  if (u.pathname !== '' && u.pathname !== '/') return 'endpoint';
  return null;
}

export function checkRecordKey(field: string, key: string): void {
  if (!RECORD_KEY_RE.test(key)) {
    invalidValue(field, 'must be an identifier matching [A-Za-z0-9_-]+');
  }
}

/**
 * `scope: 'personality'` additionally refuses the subkeys
 * `RETENTION_NO_PERSONALITY_SCOPE` (`@ethosagent/types`) lists — today only
 * `channelTranscript`, whose nightly prune reads the global key alone, so a
 * per-personality window would tell an operator that third-party message text
 * is forgotten sooner than it is. Refused HERE and not only in the Settings
 * page because this covers every `config.update` caller, including one that
 * never loads the UI; `ethos retention set --personality` already refuses the
 * same combination against the same roster.
 *
 * Only a DEFINED duration is refused. An undefined value writes nothing
 * (`set()` returns early on `undefined`), so it makes no claim to break — the
 * same reason the grammar check below skips it.
 *
 * CLEARING is not refused: `personalityRetention` is a full replacement of
 * `personalities.*.retention.*`, so a patch that simply omits the subkey
 * deletes a value an earlier build wrote. That is this surface's equivalent of
 * `ethos retention reset <category> --personality <id>`, and it is what keeps
 * an operator from being stuck with a row they cannot remove.
 */
function checkRetentionMap(
  field: string,
  map: Partial<Record<RetentionSubkey, string>>,
  scope: 'global' | 'personality' = 'global',
): void {
  for (const [sub, dur] of Object.entries(map)) {
    if (!(RETENTION_SUBKEYS as readonly string[]).includes(sub)) {
      invalidValue(`${field}.${sub}`, 'is not a retention subkey');
    }
    if (dur !== undefined && !RETENTION_DURATION_RE.test(dur)) {
      invalidValue(`${field}.${sub}`, "must be 'forever' or <n> followed by d|w|m|y");
    }
    const noScope = scope === 'personality' ? RETENTION_NO_PERSONALITY_SCOPE[sub] : undefined;
    if (noScope !== undefined && dur !== undefined) {
      invalidValue(
        `${field}.${sub}`,
        `cannot be set per personality: ${noScope} Set retention.${sub} instead, or remove this entry to clear it.`,
      );
    }
  }
}

export function validateSettingsPatch(patch: ConfigUpdateInput): void {
  checkInt('displayToolPreviewLength', patch.displayToolPreviewLength, 0);
  checkInt('displayResumeRecapTurns', patch.displayResumeRecapTurns, 0, 10);
  if (patch.compaction) {
    checkFraction('compaction.pressure', patch.compaction.pressure);
    checkFraction('compaction.target', patch.compaction.target);
    checkInt('compaction.gateDelta', patch.compaction.gateDelta, 0);
  }
  if (patch.voiceFiller) {
    checkInt('voiceFiller.afterMs', patch.voiceFiller.afterMs, 0, 60_000);
    checkInt('voiceFiller.tickIntervalMs', patch.voiceFiller.tickIntervalMs, 0, 60_000);
  }
  if (patch.memoryApproval) {
    const mode = patch.memoryApproval.mode;
    if (mode !== undefined && mode !== null && !['off', 'automated', 'all'].includes(mode)) {
      invalidValue('memoryApproval.mode', "must be one of 'off', 'automated', 'all'");
    }
    checkInt('memoryApproval.cap', patch.memoryApproval.cap, 1);
    checkInt('memoryApproval.ttlDays', patch.memoryApproval.ttlDays, 1);
  }
  if (patch.memoryConsolidation) {
    const m = patch.memoryConsolidation;
    checkPositive('memoryConsolidation.halfLifeDays', m.halfLifeDays);
    if (m.threshold !== undefined && m.threshold !== null) {
      if (!Number.isFinite(m.threshold) || m.threshold < 0 || m.threshold > 1) {
        invalidValue('memoryConsolidation.threshold', 'must be a number in [0,1]');
      }
    }
    checkFraction('memoryConsolidation.flushThreshold', m.flushThreshold);
    checkInt('memoryConsolidation.timeboxMs', m.timeboxMs, 0);
    checkInt('memoryConsolidation.maxTokens', m.maxTokens, 0);
    checkInt('memoryConsolidation.maxDeltaChars', m.maxDeltaChars, 0);
    checkInt('memoryConsolidation.minMessagesSinceFlush', m.minMessagesSinceFlush, 0);
  }
  if (patch.memoryCapture) {
    checkInt('memoryCapture.maxPerHour', patch.memoryCapture.maxPerHour, 1);
    checkInt('memoryCapture.maxPerDay', patch.memoryCapture.maxPerDay, 1);
  }
  if (patch.background) {
    const b = patch.background;
    checkInt('background.maxConcurrentJobs', b.maxConcurrentJobs, 1);
    checkInt('background.maxJobsPerRoot', b.maxJobsPerRoot, 1);
    checkInt('background.maxJobsPerPersonality', b.maxJobsPerPersonality, 1);
    checkNonNegative('background.defaultMaxCostUsd', b.defaultMaxCostUsd);
    checkNonNegative('background.maxRootBackgroundUsd', b.maxRootBackgroundUsd);
    checkInt('background.queuedTtlMs', b.queuedTtlMs, 0);
    checkInt('background.staleMs', b.staleMs, 0);
    checkInt('background.heartbeatMs', b.heartbeatMs, 0);
    checkInt('background.retentionDays', b.retentionDays, 1);
  }
  if (patch.modelCatalog) checkPositive('modelCatalog.ttlHours', patch.modelCatalog.ttlHours);
  if (patch.logsRotation) {
    checkInt('logsRotation.maxBytes', patch.logsRotation.maxBytes, 1);
    checkInt('logsRotation.maxFiles', patch.logsRotation.maxFiles, 1);
  }
  // MIRROR of `buildBackupConfig` in packages/config — the source of truth for
  // this rule; change both together. Mirrored even though that source already
  // owns it, because it THROWS rather than dropping: a persisted `backup.keep`
  // below 1 makes config.yaml unloadable EVERYWHERE, bricking the CLI, not just
  // this pane. `checkInt`'s integer + `>= 1` + MAX_SAFE_INTEGER ceiling is
  // exactly its `/^\d+$/` whole-string test plus `Number.isSafeInteger(keep)`.
  // The other four `backup.*` fields carry no bound here on purpose — `scope`'s
  // roster lives in `@ethosagent/wiring` (a copy is the D1 drift), and `cron` /
  // `dir` / `enabled` have no bound in packages/config to mirror.
  if (patch.backup) checkInt('backup.keep', patch.backup.keep, 1);
  // Bounds below mirror the `build*` helpers in packages/config, which DROP an
  // out-of-range value rather than clamping it — a silently ignored save is
  // worse at an RPC boundary than a refusal, so these reject instead.
  if (patch.logsLevel !== undefined && patch.logsLevel !== null) {
    if (!(LOG_LEVELS as readonly string[]).includes(patch.logsLevel)) {
      invalidValue('logsLevel', "must be one of 'debug', 'info', 'warn', 'error'");
    }
  }
  checkInt('retentionMinVacuumIntervalDays', patch.retentionMinVacuumIntervalDays, 0);
  checkInt('cronMaxParallelJobs', patch.cronMaxParallelJobs, 1);
  checkInt('gatewayMaxInboundMediaBytes', patch.gatewayMaxInboundMediaBytes, 1024, 134_217_728);
  if (patch.memoryCharLimits) {
    checkInt('memoryCharLimits.memory', patch.memoryCharLimits.memory, 1);
    checkInt('memoryCharLimits.user', patch.memoryCharLimits.user, 1);
  }
  if (patch.executionDocker) {
    // `cpu` is the one cap that may be fractional (`--cpus 1.5`).
    checkPositive('executionDocker.cpu', patch.executionDocker.cpu);
    checkInt('executionDocker.diskMb', patch.executionDocker.diskMb, 1);
  }
  if (patch.executionSsh) {
    // Only the port is a number, and it is the one field a typo turns into a
    // connection that hangs rather than a config error. Everything else is a
    // host, a user or a path — `@ethosagent/config` is the authority on what
    // those may contain, and re-deciding it here is how two validators drift.
    checkInt('executionSsh.port', patch.executionSsh.port, 1, 65535);
  }
  if (patch.kanban) {
    checkInt('kanban.maxInProgress', patch.kanban.maxInProgress, 1);
    checkInt('kanban.maxInProgressPerProfile', patch.kanban.maxInProgressPerProfile, 1);
  }
  if (patch.toolLoop) {
    checkInt('toolLoop.maxToolCallsWarnAt', patch.toolLoop.maxToolCallsWarnAt, 1);
    checkInt('toolLoop.maxIdenticalToolCallsWarnAt', patch.toolLoop.maxIdenticalToolCallsWarnAt, 1);
  }
  if (patch.browser) {
    const b = patch.browser;
    checkInt('browser.navigationTimeoutMs', b.navigationTimeoutMs, 1_000, 600_000);
    checkInt('browser.commandTimeoutMs', b.commandTimeoutMs, 1_000, 600_000);
    // 60000–86400000 mirrors `buildBrowser` in @ethosagent/config — under a
    // minute the sweeper reaps a session between two tool calls of one turn,
    // past a day an open session is a leak. The two MUST agree: a value this
    // layer accepts and that one drops is a setting the pane shows as live and
    // the runtime is not using.
    checkInt('browser.idleTimeoutMs', b.idleTimeoutMs, 60_000, 86_400_000);
    // `headed`, the two flags and `proxy.server` are the fields `buildBrowser`
    // refuses BOOT over rather than dropping, so a value it would refuse must
    // not be written here. `checkInt` cannot express a three-state or an enum;
    // the shape below is the one `voiceTrunkProvider` above already uses.
    if (
      b.headed !== undefined &&
      b.headed !== null &&
      b.headed !== 'auto' &&
      typeof b.headed !== 'boolean'
    ) {
      invalidValue('browser.headed', "must be true, false or 'auto'");
    }
    checkBool('browser.stealth.enabled', b.stealthEnabled);
    checkBool('browser.profiles.enabled', b.profilesEnabled);
    if (b.proxyServer !== undefined && b.proxyServer !== null) {
      const problem = browserProxyServerProblem(b.proxyServer);
      if (problem === 'scheme') {
        invalidValue(
          'browser.proxy.server',
          'must be a URL with an http, https, socks4 or socks5 scheme',
        );
      } else if (problem === 'endpoint') {
        invalidValue('browser.proxy.server', BROWSER_PROXY_ENDPOINT_ONLY);
      }
    }
  }
  if (patch.teamSupervisorRestartLoopGuard) {
    const g = patch.teamSupervisorRestartLoopGuard;
    checkInt('teamSupervisorRestartLoopGuard.maxRestarts', g.maxRestarts, 1, 1000);
    checkInt('teamSupervisorRestartLoopGuard.windowSeconds', g.windowSeconds, 1, 86_400);
  }
  if (patch.discordMissedMessageBackfill) {
    const b = patch.discordMissedMessageBackfill;
    checkInt('discordMissedMessageBackfill.windowSeconds', b.windowSeconds, 1, 604_800);
    // 100 is Discord's own `messages.fetch` ceiling.
    checkInt('discordMissedMessageBackfill.limit', b.limit, 1, 100);
  }
  if (patch.retention) checkRetentionMap('retention', patch.retention);
  if (patch.personalityRetention) {
    for (const [pid, map] of Object.entries(patch.personalityRetention)) {
      checkRecordKey(`personalityRetention.${pid}`, pid);
      if (map) checkRetentionMap(`personalityRetention.${pid}`, map, 'personality');
    }
  }
  if (patch.channelToolsets) {
    for (const platform of Object.keys(patch.channelToolsets)) {
      checkRecordKey(`channelToolsets.${platform}`, platform);
    }
  }
  if (patch.quickCommands) {
    for (const [name, qc] of Object.entries(patch.quickCommands)) {
      checkRecordKey(`quickCommands.${name}`, name);
      if (!qc) continue;
      if (qc.type === 'exec' && !qc.command) {
        invalidValue(`quickCommands.${name}.command`, 'is required for type exec');
      }
      if (qc.type === 'reply' && !qc.reply) {
        invalidValue(`quickCommands.${name}.reply`, 'is required for type reply');
      }
    }
  }
  if (patch.voiceTtsProviders) {
    for (const [name, entry] of Object.entries(patch.voiceTtsProviders)) {
      // The name becomes a `voice.tts.providers.<name>.<field>` line; outside
      // this charset the CLI's parser would not match it and the entry would
      // vanish on the next read.
      checkRecordKey(`voiceTtsProviders.${name}`, name);
      if (!entry?.provider) {
        invalidValue(`voiceTtsProviders.${name}.provider`, 'is required');
      }
      checkInt(`voiceTtsProviders.${name}.timeout`, entry.timeout, 1, 3600);
      checkInt(`voiceTtsProviders.${name}.maxTextLength`, entry.maxTextLength, 100, 100_000);
    }
  }
  if (patch.voiceSttProviders) {
    for (const [name, entry] of Object.entries(patch.voiceSttProviders)) {
      checkRecordKey(`voiceSttProviders.${name}`, name);
      if (!entry?.provider) {
        invalidValue(`voiceSttProviders.${name}.provider`, 'is required');
      }
      checkInt(`voiceSttProviders.${name}.timeout`, entry.timeout, 1, 3600);
    }
  }
  if (patch.voiceRealtimeProviders) {
    for (const [name, entry] of Object.entries(patch.voiceRealtimeProviders)) {
      checkRecordKey(`voiceRealtimeProviders.${name}`, name);
      if (!entry?.provider) {
        invalidValue(`voiceRealtimeProviders.${name}.provider`, 'is required');
      }
      // A rate is money per minute, so fractions are the norm — `checkPositive`,
      // not `checkInt`. The CLI's parser drops a non-positive rate; refusing it
      // here means the operator hears about it instead of it vanishing.
      checkPositive(`voiceRealtimeProviders.${name}.costPerMinuteUsd`, entry.costPerMinuteUsd);
    }
  }
  if (patch.wakeRoutes) {
    for (const [id, route] of Object.entries(patch.wakeRoutes)) {
      // The id becomes a `voice.wake.routes.<id>.<field>` line; outside this
      // charset neither parser would match it and the route would vanish on
      // the next read — a wake phrase that silently stops existing.
      checkRecordKey(`wakeRoutes.${id}`, id);
      if (!route?.phrase?.trim()) invalidValue(`wakeRoutes.${id}.phrase`, 'is required');
      if (!route?.personality?.trim()) {
        invalidValue(`wakeRoutes.${id}.personality`, 'is required');
      }
    }
  }
  checkPositive('voiceRealtimeSessionBudgetUsd', patch.voiceRealtimeSessionBudgetUsd);
  // Telephony. Bounds mirror packages/config, which makes these PARSE ERRORS
  // rather than dropping them — a budget or concurrency cap that silently
  // vanished is real money on a surface strangers can dial.
  if (
    patch.voiceTrunkProvider !== undefined &&
    patch.voiceTrunkProvider !== null &&
    !(VOICE_TRUNK_PROVIDERS as readonly string[]).includes(patch.voiceTrunkProvider)
  ) {
    invalidValue('voiceTrunkProvider', `must be one of ${VOICE_TRUNK_PROVIDERS.join(', ')}`);
  }
  if (
    patch.voiceTrunkCodec !== undefined &&
    patch.voiceTrunkCodec !== null &&
    !(VOICE_TRUNK_CODECS as readonly string[]).includes(patch.voiceTrunkCodec)
  ) {
    invalidValue('voiceTrunkCodec', `must be one of ${VOICE_TRUNK_CODECS.join(', ')}`);
  }
  if (patch.voiceTrunkWebhookPath && !patch.voiceTrunkWebhookPath.startsWith('/')) {
    invalidValue('voiceTrunkWebhookPath', "must start with '/'");
  }
  if (
    patch.voiceInboundPrewarm !== undefined &&
    patch.voiceInboundPrewarm !== null &&
    !(VOICE_INBOUND_PREWARM_MODES as readonly string[]).includes(patch.voiceInboundPrewarm)
  ) {
    invalidValue('voiceInboundPrewarm', `must be one of ${VOICE_INBOUND_PREWARM_MODES.join(', ')}`);
  }
  checkInt('voiceInboundConcurrencyCap', patch.voiceInboundConcurrencyCap, 1);
  checkInt('voiceInboundPerCallerPerHour', patch.voiceInboundPerCallerPerHour, 1);
  checkPositive('voiceInboundDailyBudgetUsd', patch.voiceInboundDailyBudgetUsd);
  if (patch.voiceBargeIn) {
    for (const [surface, tuning] of Object.entries(patch.voiceBargeIn)) {
      // REFUSED, not dropped: a threshold typed against a misspelled surface is
      // not a slightly different setting, it is no tuning at all — and here
      // there is a caller waiting to be told.
      if (!(VOICE_BARGE_IN_SURFACES as readonly string[]).includes(surface)) {
        invalidValue(
          `voiceBargeIn.${surface}`,
          `is not a barge-in surface (${VOICE_BARGE_IN_SURFACES.join(', ')})`,
        );
      }
      if (!tuning) continue;
      const energy = tuning.energyThreshold;
      if (energy !== undefined && (!Number.isFinite(energy) || energy <= 0 || energy > 1)) {
        invalidValue(`voiceBargeIn.${surface}.energyThreshold`, 'must be a number in (0, 1]');
      }
      checkInt(`voiceBargeIn.${surface}.minSpeechMs`, tuning.minSpeechMs, 1);
      checkInt(`voiceBargeIn.${surface}.silenceMs`, tuning.silenceMs, 1);
    }
  }
  if (patch.voiceBots) {
    for (const [index, bot] of patch.voiceBots.entries()) {
      if (!bot?.match?.trim()) invalidValue(`voiceBots.${index}.match`, 'is required');
      // The id becomes part of a `voice.bots.<n>.id` line and is read back as a
      // lane-key component; outside this charset it would not survive the round
      // trip.
      if (bot.id !== undefined) checkRecordKey(`voiceBots.${index}.id`, bot.id);
      if (bot.bind?.type !== 'personality' && bot.bind?.type !== 'team') {
        invalidValue(`voiceBots.${index}.bind.type`, "must be 'personality' or 'team'");
      }
      if (!bot.bind?.name?.trim()) invalidValue(`voiceBots.${index}.bind.name`, 'is required');
    }
  }
  if (patch.voiceChannelTtsOut) {
    for (const platform of Object.keys(patch.voiceChannelTtsOut)) {
      // REFUSED, not dropped — the opposite of what the yaml parser does with
      // the same typo. There a bad hand-edit must not make the config
      // unloadable, so an unknown platform is ignored; here there is a caller
      // waiting on a response, and silently discarding their toggle would leave
      // the Settings page showing a switch that never took.
      if (!isVoiceChannelPlatform(platform)) {
        invalidValue(
          `voiceChannelTtsOut.${platform}`,
          `is not a voice channel platform (${VOICE_CHANNEL_PLATFORMS.join(', ')})`,
        );
      }
    }
  }
  // Bounds mirror the `parseBoundedInt` ranges in packages/config, which DROPS
  // an out-of-range value; a direct (non-RPC) caller hears about it instead.
  checkInt('voiceTranscodeBitrateKbps', patch.voiceTranscodeBitrateKbps, 8, 320);
  checkInt('voiceTranscodeTimeoutSec', patch.voiceTranscodeTimeoutSec, 1, 600);
  checkInt('voiceArtifactAbandonAfterDays', patch.voiceArtifactAbandonAfterDays, 1, 365);
  checkInt('voiceArtifactMaxTotalMb', patch.voiceArtifactMaxTotalMb, 1, 102_400);
  if (patch.webhooks) {
    for (const [hookId, hook] of Object.entries(patch.webhooks)) {
      checkRecordKey(`webhooks.${hookId}`, hookId);
      if (!hook) continue;
      if (!hook.personalityId) {
        invalidValue(`webhooks.${hookId}.personalityId`, 'is required');
      }
      if (hook.mode !== undefined && hook.mode !== 'sync' && hook.mode !== 'ack') {
        invalidValue(`webhooks.${hookId}.mode`, "must be 'sync' or 'ack'");
      }
      if (hook.prefilterTimeoutSeconds !== undefined) {
        if (!hook.prefilter) {
          invalidValue(`webhooks.${hookId}.prefilterTimeoutSeconds`, "requires 'prefilter'");
        }
        checkInt(
          `webhooks.${hookId}.prefilterTimeoutSeconds`,
          hook.prefilterTimeoutSeconds,
          1,
          600,
        );
      }
    }
  }
}
