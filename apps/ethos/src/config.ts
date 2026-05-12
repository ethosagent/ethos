import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RetentionConfig, RetentionEventsConfig, Storage } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Key rotation pool
// ---------------------------------------------------------------------------

export interface KeyProfile {
  apiKey: string;
  priority: number;
  label?: string;
}

export async function readKeys(storage: Storage): Promise<KeyProfile[]> {
  const src = await storage.read(join(ethosDir(), 'keys.json'));
  if (!src) return [];
  try {
    return JSON.parse(src) as KeyProfile[];
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
}

export interface EthosConfig {
  provider: string;
  model: string;
  apiKey: string;
  personality: string;
  /** Memory backend: 'markdown' (default) or 'vector' (semantic retrieval) */
  memory?: 'markdown' | 'vector';
  baseUrl?: string;
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
  /** Global retention settings. Per-category TTLs. */
  retention?: RetentionConfig;
  /**
   * Per-personality overrides. Keyed by personality ID.
   * Only `retention` sub-block is supported here.
   */
  personalitiesConfig?: Record<string, { retention?: RetentionConfig }>;
}

export function ethosDir(): string {
  return join(homedir(), '.ethos');
}

export async function readConfig(storage: Storage): Promise<EthosConfig | null> {
  const src = await storage.read(join(ethosDir(), 'config.yaml'));
  if (!src) return null;
  return parseConfigYaml(src);
}

export async function writeConfig(storage: Storage, config: EthosConfig): Promise<void> {
  await storage.mkdir(ethosDir());
  const lines = [
    `provider: ${config.provider}`,
    `model: ${config.model}`,
    `apiKey: ${config.apiKey}`,
    `personality: ${config.personality}`,
  ];
  if (config.memory) lines.push(`memory: ${config.memory}`);
  if (config.baseUrl) lines.push(`baseUrl: ${config.baseUrl}`);
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
  if (config.verbose) lines.push('verbose: true');
  if (config.displayVerbosity) lines.push(`display.verbosity: ${config.displayVerbosity}`);
  if (config.displayBusyInputMode)
    lines.push(`display.busy_input_mode: ${config.displayBusyInputMode}`);
  if (config.displayToolPreviewLength !== undefined)
    lines.push(`display.tool_preview_length: ${config.displayToolPreviewLength}`);
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
  await storage.write(join(ethosDir(), 'config.yaml'), `${lines.join('\n')}\n`);
}

function parseConfigYaml(src: string): EthosConfig {
  const kv: Record<string, string> = {};
  const modelRouting: Record<string, string> = {};
  const activeContextKv: Record<string, string> = {};
  const providersKv: Record<number, Record<string, string>> = {};
  const retentionKv: Record<string, string> = {};
  const personalitiesRetKv: Record<string, Record<string, string>> = {};
  const displayKv: Record<string, string> = {};
  // Indexed list shapes: telegram.bots.<n>.<field> and slack.apps.<n>.<field>,
  // plus their nested `.bind.<field>` sub-keys. Per-team config keyed by name.
  const telegramBotsKv: Record<number, Record<string, string>> = {};
  const slackAppsKv: Record<number, Record<string, string>> = {};
  const teamsKv: Record<string, Record<string, string>> = {};
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
      };
    })
    .filter((p): p is ProviderConfig => p !== null);

  const retention = buildRetentionConfig(retentionKv);
  const personalitiesConfig = buildPersonalitiesConfig(personalitiesRetKv);
  const telegramResult = buildTelegramBots(telegramBotsKv);
  const slackResult = buildSlackApps(slackAppsKv);
  const teams = buildTeamsConfig(teamsKv);
  const parseErrors = [...telegramResult.errors, ...slackResult.errors];

  const config: EthosConfig = {
    provider: kv.provider ?? 'anthropic',
    model: kv.model ?? 'claude-opus-4-7',
    apiKey: kv.apiKey ?? '',
    personality: kv.personality ?? 'researcher',
    memory: kv.memory === 'vector' ? 'vector' : kv.memory === 'markdown' ? 'markdown' : undefined,
    baseUrl: kv.baseUrl,
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
    displayResumeRecapTurns:
      displayKv.resume_recap_turns !== undefined
        ? Math.min(10, Math.max(0, parseInt(displayKv.resume_recap_turns, 10) || 3))
        : undefined,
    skin: kv.skin || undefined,
    retention,
    personalitiesConfig,
    telegram: telegramResult.bots.length > 0 ? { bots: telegramResult.bots } : undefined,
    slack: slackResult.apps.length > 0 ? { apps: slackResult.apps } : undefined,
    teams,
  };
  // Stash parse errors so the strict loader can surface them at boot.
  // readConfig (used by CLI commands that don't gateway-boot) ignores them
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

export async function loadConfigStrict(storage: Storage): Promise<LoadedConfig | null> {
  const raw = await readConfig(storage);
  if (!raw) return null;
  const parseErrors = parseErrorsByConfig.get(raw) ?? [];
  const { config, deprecations } = applyPlatformShim(raw);
  return { config, parseErrors, deprecations };
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
 * the first 24 hex chars of sha256(token). Stable across boots; safe to log.
 *
 * 24 hex chars (96 bits) is wide enough that birthday collisions are
 * cosmologically unlikely — relevant because the value is used both as a
 * routing/lane key and as the duplicate-detection key in
 * `validateBotBindings`. Operators who want a readable identifier should
 * set an explicit `id:` in the config.
 */
export function deriveBotKey(
  bot: { id?: string } & ({ token: string } | { botToken: string }),
): string {
  if (bot.id) return bot.id;
  const seed = 'token' in bot ? bot.token : bot.botToken;
  return createHash('sha256').update(seed).digest('hex').slice(0, 24);
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
