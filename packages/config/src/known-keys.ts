import { nearestKey } from './nearest-key';
import { configLineKey, parseConfigScalar } from './scalar';

/**
 * Keys another reader of `~/.ethos/config.yaml` consumes that `parseConfigYaml`
 * never reads, so {@link ConfigKeyUse} must not report them. `<n>` is an index.
 * A key belongs here only when its reader is named beside it; the web-api
 * writer's keys are pinned against this list by
 * `apps/web-api/src/__tests__/repositories/config-unknown-keys.test.ts`.
 */
export const EXTERNALLY_READ_CONFIG_KEYS: readonly string[] = [
  // apps/web-api `ConfigRepository.read`'s `known` set (written by `ConfigRepository.write`).
  'approvalMode',
  'verbosity',
  'debugMode',
  'contextLayering',
  // apps/web-api `ConfigService.get` / `readVoiceTuning` — browser voice tuning.
  'display.voice_chime',
  'display.voice_endpoint_silence_ms',
  'display.voice_barge_threshold',
  'display.voice_barge_sustain_ms',
  'display.voice_speech_threshold',
  'display.voice_speech_min_ms',
  // apps/web-api `PlatformsRepository.listTelegramBots`.
  'telegram.bots.<n>.username',
];

const EXTERNALLY_READ_CONFIG_KEY_RES = EXTERNALLY_READ_CONFIG_KEYS.map(
  (k) => new RegExp(`^${k.replace(/\./g, '\\.').replace(/<n>/g, '\\d+')}$`),
);

/**
 * The exact TOP-LEVEL (undotted) `config.yaml` keys this module models — the
 * keys `parseConfigYaml`'s builders read from the top-level map, hand-maintained
 * (plan ux-feedback-and-config-clarity B2, §6.1). Suggestion candidates for the
 * line-numbered unknown-key warning, and exported for the CLI (`ethos status`,
 * `ethos doctor`). Drift gate: `__tests__/config-unknown-keys.test.ts` asserts
 * every top-level key `writeConfig` emits is in this list, so a new serializer
 * key without a list entry fails the test.
 */
export const KNOWN_CONFIG_KEYS: readonly string[] = [
  'schemaVersion',
  'provider',
  'model',
  'apiKey',
  'personality',
  'memory',
  'baseUrl',
  'apiVersion',
  'region',
  'awsProfile',
  'contextWindow',
  'toolOrder',
  'requestTimeoutMs',
  'approvalTimeoutMs',
  'maxRetries',
  'toolPayloadLimitChars',
  'tool_loading',
  'verbose',
  'webBaseUrl',
  'skin',
  'allowUnattendedDangerousTools',
  'telegramToken',
  'discordToken',
  'slackBotToken',
  'slackAppToken',
  'slackSigningSecret',
  'emailImapHost',
  'emailImapPort',
  'emailUser',
  'emailPassword',
  'emailSmtpHost',
  'emailSmtpPort',
  'emailTrustedAuthservId',
];

/**
 * The dotted key FAMILIES the parser has branches for (plan
 * ux-feedback-and-config-clarity B2, §6.1) — derived from the branch regexes in
 * `parseConfigYaml`'s line loop plus `parseProviderChain` and
 * `claimModelRegistryLine`. The false-positive rule (§9): a line under one of
 * these prefixes NEVER gets the line-numbered `unknown key` warning, even when
 * no branch consumed it — `unexpressibleLines` deliberately preserves keys the
 * parser does not model, and warning about a preserved key would teach
 * operators to delete lines the system is keeping on purpose. Unread keys
 * under a family still get the softer `has no effect` notice from
 * {@link ConfigKeyUse}.
 */
export const KNOWN_KEY_PREFIXES: readonly string[] = [
  'a2a.',
  'activeContext.',
  'admin.',
  'arming.',
  'auxiliary.',
  'aws.',
  'background.',
  'backup.',
  'browser.',
  'callCapture.',
  'channelDigest.',
  'channel_filter.',
  'channel_toolsets.',
  'channels.',
  'compaction.',
  'cron.',
  'decisions.',
  'discord.',
  'display.',
  'evolver.',
  'execution.',
  'gateway.',
  'grounding.',
  'idleWatcher.',
  'kanban.',
  'kanbanPoll.',
  'learningReplay.',
  'logs.',
  'mcp.',
  'memory.',
  'memoryApproval.',
  'memoryCapture.',
  'memoryConsolidation.',
  'memoryVault.',
  'modelCatalog.',
  'modelRegistry.',
  'modelRouting.',
  'models.',
  'nightlyPass.',
  'nodes.',
  'notifications.',
  'pauseClockCorrection.',
  'pauseLifecycle.',
  'personalities.',
  'plugins.',
  'providers.',
  'quick_commands.',
  'retention.',
  'security.',
  'shareLinks.',
  'storage.',
  'slack.apps.',
  'teamSupervisor.',
  'teams.',
  'telegram.bots.',
  'telemetry.',
  'toolLoop.',
  'toolSettings.',
  'voice.',
  'web.',
  'webhooks.',
  'world.',
  'weeklyDigest.',
  'whatsapp.',
];

/** The candidate closest to `key`, when it is close enough to be a typo of it:
 *  at most 1 edit for a key under 5 characters, 2 up to 11, 3 beyond. */
export function nearestConfigKey(key: string, candidates: Iterable<string>): string | undefined {
  const limit = key.length < 5 ? 1 : key.length < 12 ? 2 : 3;
  return nearestKey(key, candidates, limit);
}

/**
 * Which `config.yaml` keys `parseConfigYaml` actually reads (plan
 * openclaw-2026.9.6-gaps U4). The parser's own maps are wrapped by
 * {@link ConfigKeyUse.track}, so a key counts as read only when the builder
 * really looked its value up — there is no second list of known keys to drift
 * from the parser. A key the file sets that nothing looked up, or a line no
 * branch of the parser claims, becomes a notice naming the nearest key that WAS
 * looked up. Enumerating a map (`Object.keys(m).length`) does not count as
 * reading its keys; `Object.entries` and spreads do, so a builder that copies a
 * whole map never has its keys reported.
 *
 * Notices only, never errors (plan D2): a stale key must not stop boot.
 * Coverage limits, both silent rather than wrong: a map the parser keeps
 * untracked (the named rosters, `teams.*`, `webhooks.*`, `quick_commands.*`,
 * `channel_filter.*`, `models.*`) and a branch that drops an unknown field
 * inline (`voice.filler.*`, `voice.wake.*`, `voice.realtime.*`) report nothing.
 * `providers.<n>.*` is reported by `parseProviderChain` against
 * `PROVIDER_CHAIN_FIELDS`. Pinned by `__tests__/unknown-keys.test.ts`.
 */
export class ConfigKeyUse {
  private readonly present = new Set<string>();
  private readonly read = new Set<string>();

  /** Wrap one of the parser's `field → raw value` maps whose keys, behind
   *  `prefix`, are the config.yaml keys themselves. */
  track<T extends object>(prefix: string, target: T): T {
    return new Proxy(target, {
      get: (t, prop, receiver) => {
        if (typeof prop === 'string') this.read.add(prefix + prop);
        return Reflect.get(t, prop, receiver);
      },
      has: (t, prop) => {
        if (typeof prop === 'string') this.read.add(prefix + prop);
        return Reflect.has(t, prop);
      },
      set: (t, prop, value, receiver) => {
        if (typeof prop === 'string') this.present.add(prefix + prop);
        return Reflect.set(t, prop, value, receiver);
      },
    });
  }

  /** Wrap an `index → (field → raw value)` map (`telegram.bots.<n>.<field>`):
   *  each entry is tracked under `prefix<n>.`; the index itself is not a key. */
  trackIndexed<T extends Record<number, Record<string, string>>>(prefix: string, target: T): T {
    return new Proxy(target, {
      set: (t, prop, value, receiver) => {
        const entry =
          typeof prop === 'string' && typeof value === 'object' && value !== null
            ? this.track(`${prefix}${prop}.`, value)
            : value;
        return Reflect.set(t, prop, entry, receiver);
      },
    });
  }

  /**
   * B2 — lines eligible for the line-numbered `unknown key` warning: the ones
   * no branch consumed, plus the ones only the last-resort `<word>: <value>`
   * catch-all stored. Whether each one WARNS is decided in {@link notices},
   * after the builders have run and the read set is complete.
   */
  private readonly unknownLines: { lineNo: number; key: string }[] = [];

  /** A line no branch of the parser claimed. Blank values are skipped: an
   *  empty line loses nothing, and several keys give empty a meaning. */
  unclaimed(line: string, lineNo: number): void {
    const key = configLineKey(line);
    if (key === null) return;
    if (parseConfigScalar(line.slice(key.length + 1)).trim() === '') return;
    this.present.add(key);
    this.unknownLines.push({ lineNo, key });
  }

  /** A top-level line only the last-resort `<word>: <value>` catch-all stored —
   *  a real key when a builder reads it or `KNOWN_CONFIG_KEYS` names it, a
   *  line-numbered warning otherwise. Blank values skipped, as in `unclaimed`. */
  caughtAll(lineNo: number, key: string, rawValue: string): void {
    if (parseConfigScalar(rawValue).trim() === '') return;
    this.unknownLines.push({ lineNo, key });
  }

  notices(): string[] {
    const out: string[] = [];
    // B2 (plan ux-feedback-and-config-clarity §6.1) — the line-numbered
    // warning, only when the line matched no parser branch AND no known prefix
    // family (§9 false-positive rule: `unexpressibleLines` passthrough keys
    // under a family the parser models must not warn) AND no builder read it.
    const warned = new Set<string>();
    for (const { lineNo, key } of this.unknownLines) {
      if (warned.has(key)) continue;
      if (this.read.has(key)) continue;
      if (EXTERNALLY_READ_CONFIG_KEY_RES.some((re) => re.test(key))) continue;
      if (KNOWN_CONFIG_KEYS.includes(key)) continue;
      if (KNOWN_KEY_PREFIXES.some((p) => key.startsWith(p))) continue;
      const near = nearestKey(key, [...KNOWN_CONFIG_KEYS, ...this.read]);
      out.push(
        `config.yaml:${lineNo} unknown key '${key}'${near ? ` — did you mean '${near}'?` : ''}`,
      );
      warned.add(key);
    }
    // U4 — the softer notice for keys a branch DID consume (or a family keeps)
    // that no builder read. A key already warned about above is skipped: one
    // line per mistake, and the line-numbered form is the more actionable one.
    for (const key of this.present) {
      if (warned.has(key)) continue;
      if (this.read.has(key)) continue;
      if (EXTERNALLY_READ_CONFIG_KEY_RES.some((re) => re.test(key))) continue;
      const near = nearestConfigKey(key, this.read);
      out.push(
        `config.yaml: '${key}' has no effect — the config parser did not read it` +
          (near
            ? `; did you mean '${near}'?`
            : ' (a misspelled key, or one that applies only alongside another key).'),
      );
    }
    return out;
  }
}
