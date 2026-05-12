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
  // Platform tokens
  telegramToken?: string;
  discordToken?: string;
  slackBotToken?: string;
  slackAppToken?: string;
  slackSigningSecret?: string;
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
  /**
   * FW-29 — skill evolver cron registration.
   *   `evolverCronEnabled` — when true, registers an in-process cron job that
   *     runs `ethos evolve run --quiet` on the configured schedule.
   *   `evolverSchedule`   — 5-field cron expression (default: "0 3 * * *").
   */
  evolverCronEnabled?: boolean;
  evolverSchedule?: string;
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
  const evolverKv: Record<string, string> = {};
  for (const line of src.split('\n')) {
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

  return {
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
    skin: kv.skin || undefined,
    retention,
    personalitiesConfig,
    evolverCronEnabled: evolverKv.cron_enabled === 'true' ? true : undefined,
    evolverSchedule: evolverKv.schedule || undefined,
  };
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
