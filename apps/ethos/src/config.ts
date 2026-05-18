import { homedir } from 'node:os';
import { join } from 'node:path';
import { deriveBotKey as deriveBotKeyFromSeed } from '@ethosagent/core';
import type { ChannelFilterConfig, ChannelPlatformConfig } from '@ethosagent/safety-channel';
import { detectSecrets } from '@ethosagent/safety-redact';
import { REF_TO_ENV } from '@ethosagent/storage-fs';
import type {
  RetentionConfig,
  RetentionEventsConfig,
  SecretsResolver,
  Storage,
} from '@ethosagent/types';

// ---------------------------------------------------------------------------
// ${secrets:ref} substitution
// ---------------------------------------------------------------------------

const SECRETS_REF_RE = /\$\{secrets:([^}]+)\}/g;

async function resolveSecretValue(value: string, secrets: SecretsResolver): Promise<string> {
  const matches = [...value.matchAll(SECRETS_REF_RE)];
  if (matches.length === 0) return value;
  let resolved = value;
  for (const m of matches) {
    const ref = m[1];
    if (!ref) continue;
    const secret = await secrets.get(ref);
    if (secret === null) {
      const envKey = REF_TO_ENV.get(ref);
      if (envKey) {
        throw new Error(
          `Secret not found: ${ref}\n\n` +
            `This secret can be provided by ANY of (highest precedence first):\n` +
            `  1. ~/.ethos/.env file with ${envKey}=<value>\n` +
            `  2. environment variable ${envKey}  (e.g. set by systemd EnvironmentFile, docker -e, or your shell)\n` +
            `  3. ~/.ethos/secrets/${ref}  (file mode 0600 — lowest-precedence fallback)\n\n` +
            `Run \`ethos secrets set ${ref} <value>\` to store it as the on-disk fallback.`,
        );
      }
      throw new Error(
        `Secret not found: ${ref}. Run 'ethos secrets set ${ref} <value>' to store it.`,
      );
    }
    resolved = resolved.replace(m[0], () => secret);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Key rotation pool
// ---------------------------------------------------------------------------

export interface KeyProfile {
  apiKey: string;
  priority: number;
  label?: string;
}

export async function readKeys(storage: Storage, secrets?: SecretsResolver): Promise<KeyProfile[]> {
  const src = await storage.read(join(ethosDir(), 'keys.json'));
  if (!src) return [];
  try {
    const keys = JSON.parse(src) as KeyProfile[];
    if (secrets) {
      for (const k of keys) {
        k.apiKey = await resolveSecretValue(k.apiKey, secrets);
      }
    }
    return keys;
  } catch {
    return [];
  }
}

export async function writeKeys(storage: Storage, keys: KeyProfile[]): Promise<void> {
  await storage.mkdir(ethosDir());
  // 0o600 — keys file contains rotation API keys; restrict to owner.
  await storage.write(join(ethosDir(), 'keys.json'), `${JSON.stringify(keys, null, 2)}\n`, {
    mode: 0o600,
  });
}

export interface ActiveContext {
  /** 'personality' = single agent; 'team' = coordinator against a named mesh */
  type: 'personality' | 'team';
  name: string;
}

/**
 * Per-bot routing binding. The bot's external identity (@handle, OAuth app)
 * is fixed to one destination — either a single personality or a team's
 * coordinator. `/personality` switching inside the bot's chats is disabled
 * by default; flip `allowSlashSwitch` only for the rare flexible bot.
 */
export interface BotBinding {
  type: 'personality' | 'team';
  name: string;
  allowSlashSwitch?: boolean;
}

export interface TelegramBotConfig {
  /** Stable identifier used in lane keys + logs. Defaults to a short
   *  sha256 of `token` when omitted. */
  id?: string;
  token: string;
  bind: BotBinding;
}

export interface SlackAppConfig {
  id?: string;
  botToken: string;
  appToken: string;
  signingSecret: string;
  bind: BotBinding;
}

/**
 * Per-team runtime knobs that the gateway honors when a bot binds to
 * `bind.type === 'team'`. Keyed by team manifest name.
 */
export interface TeamRuntimeConfig {
  /** Stop the team supervisor when the gateway shuts down. Default false:
   *  supervisors are long-lived and outlive the gateway. */
  autoStop?: boolean;
}

export interface ProviderConfig {
  provider: string;
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Azure-only: REST API version (e.g. `2024-10-21`). Required when
   *  `provider === 'azure'`; ignored otherwise. */
  apiVersion?: string;
}

export interface QuickCommandConfig {
  type: 'exec';
  command: string;
}

/**
 * Auxiliary model wiring for non-primary work. Today the only consumer is
 * context compression: `semantic_summary` runs its summarizer on this
 * (typically cheap) model so a compacting turn costs ~one Haiku-tier call
 * instead of a full main-model re-prompt. `provider` / `apiKey` / `baseUrl`
 * default to the primary provider's values when unset.
 */
export interface AuxiliaryCompressionConfig {
  model: string;
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * tools-vision P2 — auxiliary vision model wiring. `vision_analyze` uses this
 * (typically vision-capable) model when the active personality's primary
 * model can't handle images / PDFs, or when the user wants to route vision
 * traffic to a cheaper model. `provider` / `apiKey` / `baseUrl` default to
 * the primary provider's values when unset, same as compression.
 */
export interface AuxiliaryVisionConfig {
  model: string;
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Remote model catalog configuration. Controls how Ethos fetches and caches
 * the centralized model metadata catalog (capabilities, context windows, pricing).
 */
export interface ModelCatalogConfig {
  /** Whether remote catalog fetching is enabled. Default true. */
  enabled?: boolean;
  /** URL of the catalog JSON endpoint. Default: https://ethos-agent.ai/api/model-catalog.json */
  url?: string;
  /** Cache TTL in hours. Default: 24. */
  ttlHours?: number;
  /** Per-provider URL overrides for catalog endpoints. */
  providers?: Record<string, { url: string }>;
}

export interface AwsSecretsConfig {
  enabled?: boolean;
  region?: string;
  prefix?: string;
  endpoint?: string;
}

export interface AwsConfig {
  secrets?: AwsSecretsConfig;
}

/**
 * On-disk schema version for `~/.ethos/config.yaml`. Bump on a breaking
 * field rename, type change, or required-field addition; do NOT bump on
 * additive optional fields. The loader uses this to drive migrations in
 * future releases without guessing whether an unknown field is an
 * operator typo or an older shape.
 *
 * Current shape lives at version 1. Pre-versioned configs (created before
 * this field shipped) load with a one-line deprecation warning and are
 * treated as `1`; the writer always emits the current value going
 * forward.
 */
export const CURRENT_ETHOS_CONFIG_SCHEMA_VERSION = 1;

export interface EthosConfig {
  /**
   * On-disk schema version. Optional for backward compatibility — pre-
   * versioned configs are accepted as `1` with a deprecation warning.
   * Always written by `writeConfig` going forward.
   */
  schemaVersion?: number;
  provider: string;
  model: string;
  apiKey: string;
  personality: string;
  /** Memory backend: 'markdown' (default) or 'vector' (semantic retrieval) */
  memory?: 'markdown' | 'vector';
  baseUrl?: string;
  /** Azure-only: REST API version (e.g. `2024-10-21`). Required when
   *  `provider === 'azure'`; ignored otherwise. */
  apiVersion?: string;
  // Per-personality model overrides: maps personality ID → model ID string
  modelRouting?: Record<string, string>;
  /**
   * Fallback provider chain. When 2+ entries are present, `createLLM` wraps
   * them in a `ChainedProvider` with automatic cooldown-based failover.
   * The primary `provider`/`apiKey`/`model` fields are used when absent or
   * when only one entry is present. Config format:
   *   providers.0.provider: anthropic
   *   providers.0.apiKey: sk-ant-...
   *   providers.0.model: claude-opus-4-7
   *   providers.1.provider: openrouter
   *   providers.1.apiKey: sk-or-...
   */
  providers?: ProviderConfig[];
  /**
   * Active chat target. Managed by `ethos set` — do not hand-edit.
   * Takes precedence over `personality` for `ethos chat` and `ethos serve`.
   * @internal
   */
  activeContext?: ActiveContext;
  // Platform tokens — legacy scalar shape (single bot / single app). When
  // `telegram.bots` / `slack.apps` is present the list-shape wins and these
  // are ignored. Existing configs continue to boot unchanged via the
  // deprecation shim in `applyPlatformShim`.
  telegramToken?: string;
  discordToken?: string;
  slackBotToken?: string;
  slackAppToken?: string;
  slackSigningSecret?: string;
  /**
   * Multi-bot routing: one bot entry per @handle. Serialized as dotted
   * indexed keys, matching `providers.<n>.<field>`. Identifiers (id,
   * bind.name) are restricted to `[A-Za-z0-9_-]+` so they round-trip
   * through the line-based config format unambiguously. Example:
   *   telegram.bots.0.token: 123:ABC
   *   telegram.bots.0.bind.type: personality
   *   telegram.bots.0.bind.name: researcher
   */
  telegram?: { bots: TelegramBotConfig[] };
  /**
   * Multi-app routing: one entry per Slack app. Same indexed-key shape
   * as `telegram.bots`. Identifier rules apply. Example:
   *   slack.apps.0.botToken: xoxb-…
   *   slack.apps.0.appToken: xapp-…
   *   slack.apps.0.signingSecret: …
   *   slack.apps.0.bind.type: personality
   *   slack.apps.0.bind.name: coder
   */
  slack?: { apps: SlackAppConfig[] };
  /** Per-team runtime knobs. Keyed by team manifest name (same identifier rules). */
  teams?: Record<string, TeamRuntimeConfig>;
  // Email platform
  emailImapHost?: string;
  emailImapPort?: number;
  emailUser?: string;
  emailPassword?: string;
  emailSmtpHost?: string;
  emailSmtpPort?: number;
  /** Show per-turn timing summary after every response. */
  verbose?: boolean;
  /**
   * FW-10 — chat-surface verbosity. Cycles via `/verbose`.
   *   `quiet`    final assistant text only — pipe-clean output
   *   `default`  text + tool chips + spinner + usage line
   *   `verbose`  also surfaces internal tool_progress events
   *   `debug`    also dumps raw event JSON
   */
  displayVerbosity?: 'quiet' | 'default' | 'verbose' | 'debug';
  /**
   * FW-9 — what Enter does mid-turn.
   *   `interrupt` (default) — abort in-flight run, start a new turn
   *   `queue`     FIFO-queue the input, run it after the current turn ends
   *   `steer`     inject as `[USER STEER]` on the next iteration's user message
   */
  displayBusyInputMode?: 'interrupt' | 'queue' | 'steer';
  /**
   * FW-11 — tool feed arg truncation. 0 = no truncation (default).
   */
  displayToolPreviewLength?: number;
  /**
   * FW-5 — show resume hint on chat exit. Defaults to true.
   * Set to false via `display.resume_hint: false` in config.yaml.
   */
  displayResumeHint?: boolean;
  /**
   * FW-6 — how many turn pairs to show in the recap panel on resume.
   * 0 disables the panel. Default 3. Range 0–10.
   */
  displayResumeRecapTurns?: number;
  /**
   * Named skin override (see `@ethosagent/design-tokens` built-in skins:
   * `default`, `mono`, `paper`). When set, the resolved tokens are wired
   * into both the TUI SkinContext and the Web ConfigProvider so the
   * visible palette matches the user's choice on every surface.
   */
  skin?: string;
  /**
   * FW-8 — CLI toolset override. Set by `--toolsets <list>` for this
   * invocation only. Never written to config.yaml.
   * @internal
   */
  cliToolsets?: string[];
  /**
   * FW-8 — CLI skill preload. Set by `-s <list>` for this invocation only.
   * Never written to config.yaml.
   * @internal
   */
  cliSkills?: string[];
  /**
   * FW-8 — Pre-loaded content for cliSkills. Populated by applyCliOverrides
   * so the hook in wiring.ts avoids a second readFileSync path.
   * @internal
   */
  cliSkillContents?: string[];
  /**
   * FW-16 — user-defined shell shortcuts, registered as `[quick]` slash commands.
   * Config format:
   *   quick_commands.status.type: exec
   *   quick_commands.status.command: git status
   */
  quick_commands?: Record<string, QuickCommandConfig>;
  /** Global retention settings. Per-category TTLs. */
  retention?: RetentionConfig;
  /**
   * Per-personality overrides. Keyed by personality ID.
   * Only `retention` sub-block is supported here.
   */
  personalitiesConfig?: Record<string, { retention?: RetentionConfig }>;
  /**
   * Chapter 1 safety: per-platform sender allowlist + pairing config.
   * Parsed from `channel_filter.<platform>.<field>: <value>` keys in config.yaml.
   * When absent, the gateway allows all inbound messages (backward compat).
   * When present, the gateway enforces sender allowlists, DM pairing codes,
   * mention gating, and context-visibility stripping per platform.
   */
  channelFilter?: ChannelFilterConfig;
  /**
   * FW-29 — skill evolver cron registration.
   *   `evolverCronEnabled` — when true, registers an in-process cron job that
   *     runs `ethos evolve run --quiet` on the configured schedule.
   *   `evolverSchedule`   — 5-field cron expression (default: "0 3 * * *").
   */
  evolverCronEnabled?: boolean;
  evolverSchedule?: string;
  /**
   * FW-13 — background sessions.
   *   `backgroundMaxConcurrent` — max simultaneous background agent tasks (default 4).
   *     Config key: background.max_concurrent
   *   `displayBellOnComplete` — ring the terminal bell when a background task finishes.
   *     Config key: display.bell_on_complete
   */
  backgroundMaxConcurrent?: number;
  displayBellOnComplete?: boolean;
  /**
   * context_compression F1 — auxiliary model wiring. `auxiliary.compression`
   * configures the cheap summarizer that `semantic_summary` uses to condense
   * long histories. Config keys:
   *   auxiliary.compression.model: claude-haiku-4-5-20251001
   *   auxiliary.compression.provider: anthropic   (optional — defaults to `provider`)
   *   auxiliary.compression.apiKey: sk-ant-...     (optional — defaults to `apiKey`)
   *   auxiliary.compression.baseUrl: https://...   (optional — defaults to `baseUrl`)
   *
   * tools-vision P2 — `auxiliary.vision` configures the vision-capable model
   * `vision_analyze` routes to when the personality's primary model can't
   * process images / PDFs. Same shape as `compression`.
   */
  auxiliary?: {
    compression?: AuxiliaryCompressionConfig;
    vision?: AuxiliaryVisionConfig;
  };
  /**
   * Remote model catalog configuration. Controls how Ethos fetches and caches
   * the centralized model metadata catalog (capabilities, context windows, pricing).
   * Config keys:
   *   modelCatalog.enabled: false
   *   modelCatalog.url: https://custom.example.com/catalog.json
   *   modelCatalog.ttlHours: 12
   *   modelCatalog.providers.<id>.url: https://internal.example.com/anthropic.json
   */
  modelCatalog?: ModelCatalogConfig;
  /**
   * Log rotation settings. Controls when `~/.ethos/logs/errors.jsonl` is
   * rotated. Config keys:
   *   logs.rotation.maxBytes: 10485760
   *   logs.rotation.maxFiles: 5
   *   logs.rotation.enabled: false
   */
  logs?: {
    rotation?: {
      maxBytes?: number;
      maxFiles?: number;
      enabled?: boolean;
    };
  };
  /**
   * AWS integration configuration. Currently supports Secrets Manager
   * as a secrets backend. Config keys:
   *   aws.secrets.enabled: true
   *   aws.secrets.region: us-east-1
   *   aws.secrets.prefix: ethos/engineer
   *   aws.secrets.endpoint: http://localhost:4566
   */
  aws?: AwsConfig;
}

export function ethosDir(): string {
  return join(homedir(), '.ethos');
}

/**
 * Set to true once per process after emitting the pre-versioned-config
 * deprecation warning so we don't spam stderr across repeated reads.
 */
let preVersionedConfigWarned = false;

export async function readRawConfig(storage: Storage): Promise<EthosConfig | null> {
  const src = await storage.read(join(ethosDir(), 'config.yaml'));
  if (!src) return null;
  const parsed = parseConfigYaml(src);
  if (parsed.schemaVersion === undefined && !preVersionedConfigWarned) {
    preVersionedConfigWarned = true;
    console.warn(
      `\n[ethos] ~/.ethos/config.yaml is missing 'schemaVersion'. ` +
        `Treating as schemaVersion: ${CURRENT_ETHOS_CONFIG_SCHEMA_VERSION}. ` +
        `Re-running 'ethos setup' (or adding 'schemaVersion: ${CURRENT_ETHOS_CONFIG_SCHEMA_VERSION}' to the top of the file) ` +
        `will silence this warning and let future migrations key off the version.\n`,
    );
  }
  return parsed;
}

export async function readConfig(
  storage: Storage,
  secrets: SecretsResolver,
): Promise<EthosConfig | null> {
  const raw = await readRawConfig(storage);
  if (!raw) return null;
  return resolveConfigSecrets(raw, secrets);
}

export async function writeConfig(storage: Storage, config: EthosConfig): Promise<void> {
  await storage.mkdir(ethosDir());
  const lines = [
    `schemaVersion: ${config.schemaVersion ?? CURRENT_ETHOS_CONFIG_SCHEMA_VERSION}`,
    `provider: ${config.provider}`,
    `model: ${config.model}`,
    `apiKey: ${config.apiKey}`,
    `personality: ${config.personality}`,
  ];
  if (config.memory) lines.push(`memory: ${config.memory}`);
  if (config.baseUrl) lines.push(`baseUrl: ${config.baseUrl}`);
  if (config.apiVersion) lines.push(`apiVersion: ${config.apiVersion}`);
  if (config.modelRouting) {
    for (const [id, model] of Object.entries(config.modelRouting)) {
      lines.push(`modelRouting.${id}: ${model}`);
    }
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
  if (config.telegram?.bots.length) {
    for (const [i, bot] of config.telegram.bots.entries()) {
      if (bot.id) lines.push(`telegram.bots.${i}.id: ${bot.id}`);
      lines.push(`telegram.bots.${i}.token: ${bot.token}`);
      lines.push(`telegram.bots.${i}.bind.type: ${bot.bind.type}`);
      lines.push(`telegram.bots.${i}.bind.name: ${bot.bind.name}`);
      if (bot.bind.allowSlashSwitch) {
        lines.push(`telegram.bots.${i}.bind.allowSlashSwitch: true`);
      }
    }
  }
  if (config.slack?.apps.length) {
    for (const [i, app] of config.slack.apps.entries()) {
      if (app.id) lines.push(`slack.apps.${i}.id: ${app.id}`);
      lines.push(`slack.apps.${i}.botToken: ${app.botToken}`);
      lines.push(`slack.apps.${i}.appToken: ${app.appToken}`);
      lines.push(`slack.apps.${i}.signingSecret: ${app.signingSecret}`);
      lines.push(`slack.apps.${i}.bind.type: ${app.bind.type}`);
      lines.push(`slack.apps.${i}.bind.name: ${app.bind.name}`);
      if (app.bind.allowSlashSwitch) {
        lines.push(`slack.apps.${i}.bind.allowSlashSwitch: true`);
      }
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
      lines.push(`quick_commands.${name}.command: ${qc.command}`);
    }
  }
  if (config.channelFilter) {
    for (const [platform, cfg] of Object.entries(config.channelFilter)) {
      if (cfg.ownerUserId) lines.push(`channel_filter.${platform}.ownerUserId: ${cfg.ownerUserId}`);
      if (cfg.recipientAllowlist && cfg.recipientAllowlist.length > 0) {
        lines.push(
          `channel_filter.${platform}.recipientAllowlist: ${cfg.recipientAllowlist.join(',')}`,
        );
      }
      if (cfg.dmPolicy) lines.push(`channel_filter.${platform}.dmPolicy: ${cfg.dmPolicy}`);
      if (cfg.contextVisibility)
        lines.push(`channel_filter.${platform}.contextVisibility: ${cfg.contextVisibility}`);
    }
  }
  if (config.providers && config.providers.length > 0) {
    for (const [i, p] of config.providers.entries()) {
      lines.push(`providers.${i}.provider: ${p.provider}`);
      lines.push(`providers.${i}.apiKey: ${p.apiKey}`);
      if (p.model) lines.push(`providers.${i}.model: ${p.model}`);
      if (p.baseUrl) lines.push(`providers.${i}.baseUrl: ${p.baseUrl}`);
      if (p.apiVersion) lines.push(`providers.${i}.apiVersion: ${p.apiVersion}`);
    }
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
  if (config.logs?.rotation) {
    const r = config.logs.rotation;
    if (r.maxBytes !== undefined) lines.push(`logs.rotation.maxBytes: ${r.maxBytes}`);
    if (r.maxFiles !== undefined) lines.push(`logs.rotation.maxFiles: ${r.maxFiles}`);
    if (r.enabled === false) lines.push('logs.rotation.enabled: false');
  }
  if (config.aws?.secrets) {
    const s = config.aws.secrets;
    if (s.enabled !== undefined) lines.push(`aws.secrets.enabled: ${s.enabled}`);
    if (s.region) lines.push(`aws.secrets.region: ${s.region}`);
    if (s.prefix) lines.push(`aws.secrets.prefix: ${s.prefix}`);
    if (s.endpoint) lines.push(`aws.secrets.endpoint: ${s.endpoint}`);
  }
  await storage.write(join(ethosDir(), 'config.yaml'), `${lines.join('\n')}\n`);
}

export async function resolveConfigSecrets(
  config: EthosConfig,
  secrets: SecretsResolver,
): Promise<EthosConfig> {
  const r = { ...config };
  r.apiKey = await resolveSecretValue(r.apiKey, secrets);
  if (r.baseUrl) r.baseUrl = await resolveSecretValue(r.baseUrl, secrets);
  if (r.telegramToken) r.telegramToken = await resolveSecretValue(r.telegramToken, secrets);
  if (r.discordToken) r.discordToken = await resolveSecretValue(r.discordToken, secrets);
  if (r.slackBotToken) r.slackBotToken = await resolveSecretValue(r.slackBotToken, secrets);
  if (r.slackAppToken) r.slackAppToken = await resolveSecretValue(r.slackAppToken, secrets);
  if (r.slackSigningSecret)
    r.slackSigningSecret = await resolveSecretValue(r.slackSigningSecret, secrets);
  if (r.emailPassword) r.emailPassword = await resolveSecretValue(r.emailPassword, secrets);
  if (r.providers) {
    r.providers = await Promise.all(
      r.providers.map(async (p) => ({
        ...p,
        apiKey: await resolveSecretValue(p.apiKey, secrets),
      })),
    );
  }
  if (r.telegram?.bots) {
    r.telegram = {
      ...r.telegram,
      bots: await Promise.all(
        r.telegram.bots.map(async (bot) => ({
          ...bot,
          token: await resolveSecretValue(bot.token, secrets),
        })),
      ),
    };
  }
  if (r.slack?.apps) {
    r.slack = {
      ...r.slack,
      apps: await Promise.all(
        r.slack.apps.map(async (app) => ({
          ...app,
          botToken: await resolveSecretValue(app.botToken, secrets),
          appToken: await resolveSecretValue(app.appToken, secrets),
          signingSecret: await resolveSecretValue(app.signingSecret, secrets),
        })),
      ),
    };
  }
  if (r.auxiliary?.compression?.apiKey) {
    r.auxiliary = {
      ...r.auxiliary,
      compression: {
        ...r.auxiliary.compression,
        apiKey: await resolveSecretValue(r.auxiliary.compression.apiKey, secrets),
      },
    };
  }
  if (r.auxiliary?.vision?.apiKey) {
    r.auxiliary = {
      ...r.auxiliary,
      vision: {
        ...r.auxiliary.vision,
        apiKey: await resolveSecretValue(r.auxiliary.vision.apiKey, secrets),
      },
    };
  }
  return r;
}

function parseConfigYaml(src: string): EthosConfig {
  const kv: Record<string, string> = {};
  const modelRouting: Record<string, string> = {};
  const activeContextKv: Record<string, string> = {};
  const providersKv: Record<number, Record<string, string>> = {};
  const retentionKv: Record<string, string> = {};
  const personalitiesRetKv: Record<string, Record<string, string>> = {};
  const displayKv: Record<string, string> = {};
  const evolverKv: Record<string, string> = {};
  const backgroundKv: Record<string, string> = {};
  const auxiliaryCompressionKv: Record<string, string> = {};
  const auxiliaryVisionKv: Record<string, string> = {};
  const modelCatalogKv: Record<string, string> = {};
  const modelCatalogProvidersKv: Record<string, Record<string, string>> = {};
  const logsRotationKv: Record<string, string> = {};
  const awsSecretsKv: Record<string, string> = {};
  // Indexed list shapes: telegram.bots.<n>.<field> and slack.apps.<n>.<field>,
  // plus their nested `.bind.<field>` sub-keys. Per-team config keyed by name.
  const telegramBotsKv: Record<number, Record<string, string>> = {};
  const slackAppsKv: Record<number, Record<string, string>> = {};
  const teamsKv: Record<string, Record<string, string>> = {};
  // FW-16 — quick_commands.<name>.<field>: <value>
  const qcKv: Record<string, Record<string, string>> = {};
  // Chapter 1 safety: channel_filter.<platform>.<field>: <value>
  const channelFilterKv: Record<string, Record<string, string>> = {};
  for (const line of src.split('\n')) {
    // telegram.bots.<index>.bind.<field>: <value>
    const tbind = line.match(/^telegram\.bots\.(\d+)\.bind\.(\S+):\s*(.+)$/);
    if (tbind) {
      const idx = Number(tbind[1]);
      telegramBotsKv[idx] ??= {};
      telegramBotsKv[idx][`bind.${tbind[2]}`] = tbind[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // telegram.bots.<index>.<field>: <value>
    const tbot = line.match(/^telegram\.bots\.(\d+)\.(\S+):\s*(.+)$/);
    if (tbot) {
      const idx = Number(tbot[1]);
      telegramBotsKv[idx] ??= {};
      telegramBotsKv[idx][tbot[2]] = tbot[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // slack.apps.<index>.bind.<field>: <value>
    const sbind = line.match(/^slack\.apps\.(\d+)\.bind\.(\S+):\s*(.+)$/);
    if (sbind) {
      const idx = Number(sbind[1]);
      slackAppsKv[idx] ??= {};
      slackAppsKv[idx][`bind.${sbind[2]}`] = sbind[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // slack.apps.<index>.<field>: <value>
    const sapp = line.match(/^slack\.apps\.(\d+)\.(\S+):\s*(.+)$/);
    if (sapp) {
      const idx = Number(sapp[1]);
      slackAppsKv[idx] ??= {};
      slackAppsKv[idx][sapp[2]] = sapp[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // teams.<name>.<field>: <value>
    const tcfg = line.match(/^teams\.([^.]+)\.(\S+):\s*(.+)$/);
    if (tcfg) {
      const name = tcfg[1];
      teamsKv[name] ??= {};
      teamsKv[name][tcfg[2]] = tcfg[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // providers.<index>.<field>: <value>
    const prov = line.match(/^providers\.(\d+)\.(\S+):\s*(.+)$/);
    if (prov) {
      const idx = Number(prov[1]);
      providersKv[idx] ??= {};
      const field = prov[2]?.trim() ?? '';
      if (field) providersKv[idx][field] = prov[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // personalities.<id>.retention.<field>: <value>  (must come before modelRouting)
    const perp = line.match(/^personalities\.([^.]+)\.retention\.(events\.)?(\w+):\s*(.+)$/);
    if (perp) {
      const pid = perp[1];
      const key = `${perp[2] ?? ''}${perp[3]}`;
      personalitiesRetKv[pid] ??= {};
      personalitiesRetKv[pid][key] = perp[4].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // retention.<field>: <value>  or  retention.events.<subfield>: <value>
    const ret = line.match(/^retention\.(events\.)?(\w+):\s*(.+)$/);
    if (ret) {
      retentionKv[`${ret[1] ?? ''}${ret[2]}`] = ret[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // display.<field>: <value>
    const disp = line.match(/^display\.([a-z_]+):\s*(.+)$/);
    if (disp) {
      displayKv[disp[1]] = disp[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // evolver.<field>: <value>
    const evlv = line.match(/^evolver\.([a-z_]+):\s*(.+)$/);
    if (evlv) {
      evolverKv[evlv[1]] = evlv[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // background.<field>: <value>
    const bg = line.match(/^background\.([a-z_]+):\s*(.+)$/);
    if (bg) {
      backgroundKv[bg[1]] = bg[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // auxiliary.compression.<field>: <value>
    const auxc = line.match(/^auxiliary\.compression\.(\w+):\s*(.+)$/);
    if (auxc) {
      auxiliaryCompressionKv[auxc[1]] = auxc[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // auxiliary.vision.<field>: <value>
    const auxv = line.match(/^auxiliary\.vision\.(\w+):\s*(.+)$/);
    if (auxv) {
      auxiliaryVisionKv[auxv[1]] = auxv[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // logs.rotation.<field>: <value>
    const lr = line.match(/^logs\.rotation\.(\w+):\s*(.+)$/);
    if (lr) {
      logsRotationKv[lr[1]] = lr[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // aws.secrets.<field>: <value>
    const awss = line.match(/^aws\.secrets\.(\w+):\s*(.+)$/);
    if (awss) {
      awsSecretsKv[awss[1]] = awss[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // modelCatalog.providers.<id>.url: <value>
    const mcp = line.match(/^modelCatalog\.providers\.([^.]+)\.(\S+):\s*(.+)$/);
    if (mcp) {
      const providerId = mcp[1];
      modelCatalogProvidersKv[providerId] ??= {};
      modelCatalogProvidersKv[providerId][mcp[2]] = mcp[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // modelCatalog.<field>: <value>
    const mc = line.match(/^modelCatalog\.(\w+):\s*(.+)$/);
    if (mc) {
      modelCatalogKv[mc[1]] = mc[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // modelRouting.<personality>: <model>
    const mr = line.match(/^modelRouting\.(\S+):\s*(.+)$/);
    if (mr) {
      modelRouting[mr[1].trim()] = mr[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // activeContext.type / activeContext.name
    const ac = line.match(/^activeContext\.(\S+):\s*(.+)$/);
    if (ac) {
      activeContextKv[ac[1].trim()] = ac[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    // channel_filter.<platform>.<field>: <value>
    const cf = line.match(/^channel_filter\.([^.]+)\.(\S+):\s*(.+)$/);
    if (cf) {
      const platform = cf[1];
      channelFilterKv[platform] ??= {};
      (channelFilterKv[platform] as Record<string, string>)[cf[2]] = cf[3]
        .trim()
        .replace(/^["']|["']$/g, '');
      continue;
    }
    // quick_commands.<name>.<field>: <value>
    const qc = line.match(/^quick_commands\.([^.]+)\.(\S+):\s*(.+)$/);
    if (qc) {
      const qname = qc[1];
      qcKv[qname] ??= {};
      (qcKv[qname] as Record<string, string>)[qc[2]] = qc[3].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (m) kv[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  }

  const activeContextType = activeContextKv.type;
  const activeContextName = activeContextKv.name;
  const activeContext: ActiveContext | undefined =
    (activeContextType === 'personality' || activeContextType === 'team') && activeContextName
      ? { type: activeContextType, name: activeContextName }
      : undefined;

  const sortedProviderIdxs = Object.keys(providersKv)
    .map(Number)
    .sort((a, b) => a - b);
  const providers: ProviderConfig[] = sortedProviderIdxs
    .map((i): ProviderConfig | null => {
      const p = providersKv[i];
      if (!p?.provider) return null;
      return {
        provider: p.provider,
        apiKey: p.apiKey ?? '',
        model: p.model,
        baseUrl: p.baseUrl,
        apiVersion: p.apiVersion,
      };
    })
    .filter((p): p is ProviderConfig => p !== null);

  const retention = buildRetentionConfig(retentionKv);
  const personalitiesConfig = buildPersonalitiesConfig(personalitiesRetKv);
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
  const telegramResult = buildTelegramBots(telegramBotsKv);
  const slackResult = buildSlackApps(slackAppsKv);
  const teams = buildTeamsConfig(teamsKv);
  const quick_commands = buildQuickCommands(qcKv);
  const channelFilter = buildChannelFilter(channelFilterKv);
  const parseErrors = [...telegramResult.errors, ...slackResult.errors];

  const parsedSchemaVersion = kv.schemaVersion ? Number(kv.schemaVersion) : undefined;
  const config: EthosConfig = {
    schemaVersion: Number.isFinite(parsedSchemaVersion) ? parsedSchemaVersion : undefined,
    provider: kv.provider ?? 'anthropic',
    model: kv.model ?? 'claude-opus-4-7',
    apiKey: kv.apiKey ?? '',
    personality: kv.personality ?? 'researcher',
    memory: kv.memory === 'vector' ? 'vector' : kv.memory === 'markdown' ? 'markdown' : undefined,
    baseUrl: kv.baseUrl,
    apiVersion: kv.apiVersion,
    modelRouting: Object.keys(modelRouting).length > 0 ? modelRouting : undefined,
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
    teams,
    evolverCronEnabled: evolverKv.cron_enabled === 'true' ? true : undefined,
    evolverSchedule: evolverKv.schedule || undefined,
    backgroundMaxConcurrent: backgroundKv.max_concurrent
      ? Number(backgroundKv.max_concurrent)
      : undefined,
    displayBellOnComplete: displayKv.bell_on_complete === 'true' ? true : undefined,
    quick_commands,
    channelFilter,
    auxiliary:
      auxiliaryCompression || auxiliaryVision
        ? {
            ...(auxiliaryCompression ? { compression: auxiliaryCompression } : {}),
            ...(auxiliaryVision ? { vision: auxiliaryVision } : {}),
          }
        : undefined,
    modelCatalog,
    logs: logsRotation ? { rotation: logsRotation } : undefined,
    aws: awsConfig,
  };
  // Stash parse errors so the strict loader can surface them at boot.
  // readRawConfig (used by CLI commands that don't gateway-boot) ignores them
  // and continues with whatever entries did parse.
  parseErrorsByConfig.set(config, parseErrors);
  return config;
}

// Side-table keyed by the EthosConfig object identity. Avoids polluting
// the public type with an `@internal` field that downstream code would
// have to remember to ignore.
const parseErrorsByConfig = new WeakMap<EthosConfig, string[]>();

/**
 * Strict loader used by the gateway boot path. Returns the parsed config
 * along with any deprecation messages from the legacy → list-shape shim
 * AND any parse-time errors for malformed bot entries. Boot prints both
 * and exits non-zero on errors so a typo never silently boots zero bots.
 */
export interface LoadedConfig {
  config: EthosConfig;
  parseErrors: string[];
  deprecations: string[];
}

export async function loadConfigStrict(
  storage: Storage,
  secrets?: SecretsResolver,
): Promise<LoadedConfig | null> {
  const parsed = await readRawConfig(storage);
  if (!parsed) return null;
  if (secrets) validateNoPlaintextSecrets(parsed);
  const parseErrors = parseErrorsByConfig.get(parsed) ?? [];
  const resolved = secrets ? await resolveConfigSecrets(parsed, secrets) : parsed;
  const { config, deprecations } = applyPlatformShim(resolved);
  return { config, parseErrors, deprecations };
}

// ---------------------------------------------------------------------------
// Plaintext secret detection
// ---------------------------------------------------------------------------

/**
 * Walk every string value in `config` (including nested objects and arrays)
 * and throw if any value looks like a plaintext secret. Called from
 * `loadConfigStrict` *before* secrets resolution, so legitimate
 * `${secrets:ref}` references are still present and are explicitly skipped.
 *
 * Skips validation entirely when no SecretsResolver is configured (local dev
 * without secrets infrastructure).
 */
export function validateNoPlaintextSecrets(config: EthosConfig): void {
  const violations: Array<{ field: string; label: string }> = [];
  walkStringValues(config, '', (field, value) => {
    const stripped = value.replace(SECRETS_REF_RE, '');
    if (stripped.length === 0) return;
    const detections = detectSecrets(stripped);
    if (detections.length > 0) {
      violations.push({ field, label: detections[0].label });
    }
  });
  if (violations.length > 0) {
    const details = violations
      .map(
        (v) =>
          `  - field '${v.field}' appears to contain a plaintext ${v.label}. ` +
          `Use \${secrets:<ref>} substitution instead.`,
      )
      .join('\n');
    throw new Error(`Config validation failed: plaintext secret(s) detected.\n${details}`);
  }
}

function walkStringValues(
  obj: unknown,
  prefix: string,
  cb: (field: string, value: string) => void,
): void {
  if (typeof obj === 'string') {
    cb(prefix, obj);
    return;
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      walkStringValues(obj[i], `${prefix}[${i}]`, cb);
    }
    return;
  }
  if (obj !== null && typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj)) {
      walkStringValues(value, prefix ? `${prefix}.${key}` : key, cb);
    }
  }
}

function parseVerbosity(v: string | undefined): EthosConfig['displayVerbosity'] {
  return v === 'quiet' || v === 'default' || v === 'verbose' || v === 'debug' ? v : undefined;
}

function parseBusyMode(v: string | undefined): EthosConfig['displayBusyInputMode'] {
  return v === 'interrupt' || v === 'queue' || v === 'steer' ? v : undefined;
}

function parseToolPreviewLength(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return undefined;
  return n;
}

function buildRetentionConfig(kv: Record<string, string>): RetentionConfig | undefined {
  if (Object.keys(kv).length === 0) return undefined;
  const cfg: RetentionConfig = {};
  if (kv.messages) cfg.messages = kv.messages;
  if (kv.traces) cfg.traces = kv.traces;
  if (kv.spans) cfg.spans = kv.spans;
  if (kv.blobs) cfg.blobs = kv.blobs;
  if (kv.archive) cfg.archive = kv.archive;
  const ev: RetentionEventsConfig = {};
  if (kv['events.error']) ev.error = kv['events.error'];
  if (kv['events.audit']) ev.audit = kv['events.audit'];
  if (kv['events.channel']) ev.channel = kv['events.channel'];
  if (kv['events.install']) ev.install = kv['events.install'];
  if (Object.keys(ev).length > 0) cfg.events = ev;
  return cfg;
}

function buildBotBinding(
  kv: Record<string, string>,
  label: string,
): { bind: BotBinding | null; errors: string[] } {
  const type = kv['bind.type'];
  const name = kv['bind.name'];
  const errors: string[] = [];
  if (type !== 'personality' && type !== 'team') {
    errors.push(
      `${label}: missing or invalid 'bind.type' ` +
        `(got ${type === undefined ? 'nothing' : `'${type}'`}; ` +
        `must be 'personality' or 'team').`,
    );
  }
  if (!name) {
    errors.push(`${label}: missing required field 'bind.name'.`);
  }
  if (errors.length > 0) return { bind: null, errors };
  const allow = kv['bind.allowSlashSwitch'];
  const binding: BotBinding = { type: type as 'personality' | 'team', name: name as string };
  if (allow === 'true') binding.allowSlashSwitch = true;
  return { bind: binding, errors };
}

function sortedIndexes(kv: Record<number, Record<string, string>>): number[] {
  // Numeric sort — `Object.keys(...)` returns strings even on numeric-keyed
  // records, and the default lexicographic order would put index 10 before 2.
  return Object.keys(kv)
    .map(Number)
    .sort((a, b) => a - b);
}

function buildTelegramBots(kv: Record<number, Record<string, string>>): {
  bots: TelegramBotConfig[];
  errors: string[];
} {
  const bots: TelegramBotConfig[] = [];
  const errors: string[] = [];
  for (const idx of sortedIndexes(kv)) {
    const entry = kv[idx];
    if (!entry) continue;
    const label = `telegram.bots[${idx}]`;
    if (!entry.token) {
      errors.push(`${label}: missing required field 'token'.`);
      continue;
    }
    const result = buildBotBinding(entry, label);
    if (result.errors.length > 0) {
      errors.push(...result.errors);
      continue;
    }
    if (!result.bind) continue;
    bots.push({ token: entry.token, bind: result.bind, ...(entry.id ? { id: entry.id } : {}) });
  }
  return { bots, errors };
}

function buildSlackApps(kv: Record<number, Record<string, string>>): {
  apps: SlackAppConfig[];
  errors: string[];
} {
  const apps: SlackAppConfig[] = [];
  const errors: string[] = [];
  for (const idx of sortedIndexes(kv)) {
    const entry = kv[idx];
    if (!entry) continue;
    const label = `slack.apps[${idx}]`;
    const missing = (['botToken', 'appToken', 'signingSecret'] as const).filter((k) => !entry[k]);
    if (missing.length > 0) {
      errors.push(`${label}: missing required field(s) ${missing.join(', ')}.`);
      continue;
    }
    const result = buildBotBinding(entry, label);
    if (result.errors.length > 0) {
      errors.push(...result.errors);
      continue;
    }
    if (!result.bind) continue;
    apps.push({
      botToken: entry.botToken,
      appToken: entry.appToken,
      signingSecret: entry.signingSecret,
      bind: result.bind,
      ...(entry.id ? { id: entry.id } : {}),
    });
  }
  return { apps, errors };
}

function buildTeamsConfig(
  kv: Record<string, Record<string, string>>,
): Record<string, TeamRuntimeConfig> | undefined {
  const names = Object.keys(kv);
  if (names.length === 0) return undefined;
  const out: Record<string, TeamRuntimeConfig> = {};
  for (const name of names) {
    const entry = kv[name];
    if (!entry) continue;
    const cfg: TeamRuntimeConfig = {};
    if (entry.autoStop === 'true') cfg.autoStop = true;
    out[name] = cfg;
  }
  return out;
}

/**
 * Derive a stable `botKey` for a bot config. Explicit `id` wins; otherwise
 * delegates to `deriveBotKey` from `@ethosagent/core` with the token as
 * seed. Stable across boots; safe to log.
 *
 * Operators who want a readable identifier should set an explicit `id:`
 * in the config.
 */
export function deriveBotKey(
  bot: { id?: string } & ({ token: string } | { botToken: string }),
): string {
  if (bot.id) return bot.id;
  const seed = 'token' in bot ? bot.token : bot.botToken;
  return deriveBotKeyFromSeed(seed);
}

/**
 * Apply the legacy → list-shape shim. Configs written before multi-bot
 * routing kept a scalar `telegramToken`/`slack*` triple; synthesize a
 * one-entry `telegram.bots` / `slack.apps` so downstream code sees one
 * shape. Returns the deprecation messages the caller should surface.
 *
 * Legacy bots always bind to `config.personality` — never to
 * `config.activeContext`. `activeContext` is internal, mutable CLI/session
 * state (managed by `ethos set`); routing platform traffic by it would
 * mean a `/personality` switch in the CLI silently redirects Telegram or
 * Slack traffic after the next restart. Operators who want a team-bound
 * legacy bot must migrate to the explicit list shape.
 */
export function applyPlatformShim(config: EthosConfig): {
  config: EthosConfig;
  deprecations: string[];
} {
  const deprecations: string[] = [];
  let out = config;

  if (config.telegramToken && (config.telegram?.bots?.length ?? 0) === 0) {
    const bind: BotBinding = { type: 'personality', name: config.personality };
    out = { ...out, telegram: { bots: [{ token: config.telegramToken, bind }] } };
    deprecations.push(
      "Config field 'telegramToken' is deprecated. Use the list form: " +
        "'telegram.bots.0.token: <token>' + 'telegram.bots.0.bind.type: personality' + " +
        "'telegram.bots.0.bind.name: <id>'.",
    );
  }

  if (
    config.slackBotToken &&
    config.slackAppToken &&
    config.slackSigningSecret &&
    (config.slack?.apps?.length ?? 0) === 0
  ) {
    const bind: BotBinding = { type: 'personality', name: config.personality };
    out = {
      ...out,
      slack: {
        apps: [
          {
            botToken: config.slackBotToken,
            appToken: config.slackAppToken,
            signingSecret: config.slackSigningSecret,
            bind,
          },
        ],
      },
    };
    deprecations.push(
      "Config fields 'slackBotToken'/'slackAppToken'/'slackSigningSecret' are deprecated. " +
        "Use the list form: 'slack.apps.0.botToken: <token>' + " +
        "'slack.apps.0.appToken: <token>' + 'slack.apps.0.signingSecret: <secret>' + " +
        "'slack.apps.0.bind.type: personality' + 'slack.apps.0.bind.name: <id>'.",
    );
  }

  return { config: out, deprecations };
}

// Identifiers (bot id, bind.name, team key) are interpolated into the
// dotted line-based config format. Anything outside `[A-Za-z0-9_-]` either
// can't round-trip (dot = field separator) or quietly corrupts the file
// (`#` starts a comment, quotes change quoting semantics, whitespace
// truncates parsing). Reject up front so writeConfig never emits data it
// can't parse back unambiguously.
const SAFE_IDENT = /^[A-Za-z0-9_-]+$/;

function rejectUnsafeIdent(label: string, value: string, errors: string[]): void {
  if (!SAFE_IDENT.test(value)) {
    errors.push(
      `${label}: '${value}' must match /^[A-Za-z0-9_-]+$/ — dots, whitespace, '#', and quotes are reserved by the config format.`,
    );
  }
}

/**
 * Validate that every bot binding points at a personality or team that
 * actually exists. Returns the list of human-readable error messages;
 * an empty list means the config is consistent. Boot code prints these
 * and exits non-zero rather than starting bots that will silently route
 * to nowhere.
 */
export function validateBotBindings(
  config: EthosConfig,
  deps: { personalityIds: ReadonlySet<string>; teamNames: ReadonlySet<string> },
): string[] {
  const errors: string[] = [];

  // Single namespace across telegram + slack: even though lane keys are
  // platform-scoped, an explicit `id: 'prod'` shared across platforms is a
  // foot-gun for future maintainers writing per-bot lookups. Reject up
  // front instead of waiting for someone to log just the `botKey` and
  // wonder why two bots collide.
  const seenIds = new Set<string>();

  const checkBind = (
    label: string,
    botId: string | undefined,
    bind: BotBinding,
    botKey: string,
  ): void => {
    if (botId !== undefined) rejectUnsafeIdent(`${label}.id`, botId, errors);
    rejectUnsafeIdent(`${label}.bind.name`, bind.name, errors);
    if (seenIds.has(botKey)) {
      errors.push(`${label}: duplicate botKey '${botKey}'. Set an explicit 'id:' to disambiguate.`);
    }
    seenIds.add(botKey);
    if (bind.type === 'personality' && !deps.personalityIds.has(bind.name)) {
      errors.push(
        `${label}: bind.name='${bind.name}' is not a known personality. ` +
          'Add the personality under ~/.ethos/personalities/, or fix the binding.',
      );
    }
    if (bind.type === 'team' && !deps.teamNames.has(bind.name)) {
      errors.push(
        `${label}: bind.name='${bind.name}' is not a known team. ` +
          `Add a team manifest at ~/.ethos/teams/${bind.name}.yaml, or fix the binding.`,
      );
    }
  };

  for (const [i, bot] of (config.telegram?.bots ?? []).entries()) {
    checkBind(`telegram.bots[${i}]`, bot.id, bot.bind, deriveBotKey(bot));
  }
  for (const [i, app] of (config.slack?.apps ?? []).entries()) {
    checkBind(`slack.apps[${i}]`, app.id, app.bind, deriveBotKey(app));
  }
  for (const name of Object.keys(config.teams ?? {})) {
    rejectUnsafeIdent(`teams.<key>`, name, errors);
  }
  return errors;
}

function buildQuickCommands(
  kv: Record<string, Record<string, string>>,
): Record<string, QuickCommandConfig> | undefined {
  const result: Record<string, QuickCommandConfig> = {};
  for (const [name, fields] of Object.entries(kv)) {
    if (fields.type === 'exec' && fields.command) {
      result[name] = { type: 'exec', command: fields.command };
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function buildChannelFilter(
  kv: Record<string, Record<string, string>>,
): ChannelFilterConfig | undefined {
  const platforms = Object.keys(kv);
  if (platforms.length === 0) return undefined;
  const out: ChannelFilterConfig = {};
  for (const platform of platforms) {
    const entry = kv[platform];
    if (!entry) continue;
    const cfg: ChannelPlatformConfig = {};
    if (entry.ownerUserId) cfg.ownerUserId = entry.ownerUserId;
    if (entry.recipientAllowlist) {
      cfg.recipientAllowlist = entry.recipientAllowlist
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (
      entry.dmPolicy === 'pairing' ||
      entry.dmPolicy === 'allowlist' ||
      entry.dmPolicy === 'queue' ||
      entry.dmPolicy === 'reject' ||
      entry.dmPolicy === 'silent-drop'
    ) {
      cfg.dmPolicy = entry.dmPolicy;
    }
    if (
      entry.contextVisibility === 'all' ||
      entry.contextVisibility === 'allowlist' ||
      entry.contextVisibility === 'allowlist_quote'
    ) {
      cfg.contextVisibility = entry.contextVisibility;
    }
    out[platform] = cfg;
  }
  return out;
}

function buildPersonalitiesConfig(
  kv: Record<string, Record<string, string>>,
): Record<string, { retention?: RetentionConfig }> | undefined {
  if (Object.keys(kv).length === 0) return undefined;
  const out: Record<string, { retention?: RetentionConfig }> = {};
  for (const [pid, retKv] of Object.entries(kv)) {
    const retention = buildRetentionConfig(retKv);
    if (retention) out[pid] = { retention };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Serialize a RetentionConfig to dotted key-value pairs. */
function retentionToLines(cfg: RetentionConfig): Array<[string, string]> {
  const lines: Array<[string, string]> = [];
  if (cfg.messages) lines.push(['messages', cfg.messages]);
  if (cfg.traces) lines.push(['traces', cfg.traces]);
  if (cfg.spans) lines.push(['spans', cfg.spans]);
  if (cfg.blobs) lines.push(['blobs', cfg.blobs]);
  if (cfg.archive) lines.push(['archive', cfg.archive]);
  if (cfg.events) {
    if (cfg.events.error) lines.push(['events.error', cfg.events.error]);
    if (cfg.events.audit) lines.push(['events.audit', cfg.events.audit]);
    if (cfg.events.channel) lines.push(['events.channel', cfg.events.channel]);
    if (cfg.events.install) lines.push(['events.install', cfg.events.install]);
  }
  return lines;
}
