// `ethos doctor` — runtime health check.
//
// Verifies that:
//   1. Each optional channel SDK is actually loadable (grammy, discord.js,
//      @slack/bolt, imapflow, mailparser, nodemailer). With package channel
//      SDKs in optionalDependencies, npm install can silently skip one — this
//      command surfaces that gap before the user discovers it at runtime.
//   2. The required core SDKs (@anthropic-ai/sdk, openai) are present.
//   3. ~/.ethos/config.yaml exists and names a provider/model.
//   4. The personality data directory is reachable.
//   5. External CLIs declared by bundled skills (gh, git, claude, …) are on PATH.
//
// Configured-but-missing channels exit non-zero so this command can be used
// in CI / health checks. Everything else is informational (skill-prereq gaps
// are warn-only — the user opted into the skill, not the doctor).

// Raw `node:fs` `existsSync` for the inbound-spool.db path (a raw path handed to
// SQLite — the store carve-out documented in doctor-storage.ts).
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  configParseNotices,
  type EthosConfig,
  ethosDir,
  readConfig,
  readRawConfig,
  secretRefForConfigKey,
} from '@ethosagent/config';
import { resolveSttProvider, resolveTtsProvider } from '@ethosagent/core';
import {
  CodexTokenStore,
  discoverModels,
  type ModelDiscovery,
  unsupportedModelMessage,
} from '@ethosagent/llm-codex';
import { callCaptureHealthPath } from '@ethosagent/platform-callcapture';
import { bundledSkillsSource, UniversalScanner } from '@ethosagent/skills';
import { REF_TO_ENV } from '@ethosagent/storage-fs';
import type { PersonalityConfig, SecretsResolver } from '@ethosagent/types';
import { buildVersionInfo } from '../version-info';
import { getSecretsResolver, getStorage } from '../wiring';
import {
  checkDecisionLayer,
  checkDockerSandbox,
  decisionLayerLines,
  dockerSandboxLines,
} from './doctor-decisions';
import {
  runDoctorFix,
  runFunnelReport,
  runProviderProbe,
  runRecentErrorsReport,
} from './doctor-reports';
import { CHANNEL_SDKS, CORE_SDKS, checkSdk, printRow, type RowResult } from './doctor-sdks';
import type { CodexModelCheck, SecretCheckResult } from './doctor-secrets';
import { isSet, SECRET_REF_RE } from './doctor-secrets';
import { c, type Storage } from './doctor-shared';
import {
  configuredGatewayBotKeys,
  describeInboundSpool,
  type InboundSpoolReport,
} from './doctor-spool';
import {
  checkDatabaseIntegrity,
  checkSecretsDirMode,
  checkSessionsDb,
  checkSkillsDir,
  checkStateDirFilesystem,
  checkTeamsDir,
  describeSecretsDirMode,
  integrityAdvice,
  sessionsFtsOf,
} from './doctor-storage';
import type {
  CallCaptureCheckResult,
  CallCaptureDaemonHealthResult,
  CheckCallCaptureOptions,
} from './doctor-voice';
import { telephonyReport } from './doctor-voice';

export type {
  CallCaptureCheckResult,
  CallCaptureDaemonHealthResult,
  CheckCallCaptureOptions,
} from './doctor-voice';

import { isOnPath, readExternalCliRequirements, type SkillPrereqIssue } from './doctor-skills';
import { formatResolvedLines, resolveEffective } from './status';

export {
  checkDecisionLayer,
  checkDockerSandbox,
  type DecisionLayerReport,
  type DecisionPersonalityReport,
  type DockerSandboxReport,
  decisionLayerLines,
  dockerSandboxLines,
} from './doctor-decisions';
export {
  formatFunnelDuration,
  type ProviderProbeResult,
  runFunnelReport,
  suggestProvider,
} from './doctor-reports';
export type { CodexModelCheck, SecretCheckResult } from './doctor-secrets';
export {
  configuredGatewayBotKeys,
  describeInboundSpool,
  type InboundSpoolReport,
} from './doctor-spool';
export {
  checkDatabaseIntegrity,
  checkSecretsDirMode,
  checkSessionsDb,
  checkSkillsDir,
  checkStateDirFilesystem,
  checkTeamsDir,
  type DbCheckResult,
  type DirSanityIssue,
  describeSecretsDirMode,
  type IntegrityResult,
  integrityAdvice,
  type SessionsFtsDrift,
  type StateDirFilesystemResult,
  sessionsFtsOf,
  type VaultModeResult,
} from './doctor-storage';
export { telephonyReport } from './doctor-voice';

declare const __ETHOS_VERSION__: string;
const ETHOS_VERSION =
  typeof __ETHOS_VERSION__ === 'string' ? __ETHOS_VERSION__ : (process.env.ETHOS_VERSION ?? 'dev');

/**
 * A credential the config names. Checked WHERE THE CONFIG POINTS: the
 * `${secrets:<ref>}` reference(s) in the raw config value, which is what
 * `resolveConfigSecrets` (packages/config) resolves at runtime. With no value
 * at all, the ref `secretRefForConfigKey` assigns — the single owner of ref
 * naming, the same one setup/setup-from-env write through
 * (`providers/<provider>/apiKey` for the provider key).
 *
 * The rows used to carry hard-coded refs (`anthropic-api-key`,
 * `telegram-bot-token`, …) that nothing writes, so a correctly set up install
 * was reported "missing".
 */
interface SecretCheckRow {
  configKey: 'apiKey' | 'telegramToken' | 'slackBotToken' | 'discordToken';
  /** Display/JSON name when the ref has no env-var alias. */
  label: (cfg: EthosConfig) => string;
  configuredWhen: (cfg: EthosConfig) => boolean;
}

const SECRET_CHECKS: SecretCheckRow[] = [
  {
    configKey: 'apiKey',
    label: (cfg) => `${cfg.provider ?? 'provider'} API key`,
    // Applies when the config names a key, or when the provider is one that
    // has a known API-key env var (ENV_TO_REF in packages/storage-fs) — i.e.
    // cannot run keyless. Keyless providers (ollama, a local openai-compat
    // server) and codex (OAuth — see checkCodexModel) are not flagged.
    configuredWhen: (cfg) => {
      if (!cfg.provider) return false;
      if ((cfg.apiKey ?? '').trim().length > 0) return true;
      const ref = secretRefForConfigKey('apiKey', { provider: cfg.provider });
      return ref !== null && REF_TO_ENV.has(ref);
    },
  },
  {
    configKey: 'telegramToken',
    label: () => 'TELEGRAM_BOT_TOKEN',
    configuredWhen: (cfg) => Boolean(cfg.telegramToken),
  },
  {
    configKey: 'slackBotToken',
    label: () => 'SLACK_BOT_TOKEN',
    configuredWhen: (cfg) => Boolean(cfg.slackBotToken),
  },
  {
    configKey: 'discordToken',
    label: () => 'DISCORD_BOT_TOKEN',
    configuredWhen: (cfg) => Boolean(cfg.discordToken),
  },
];

/** Exported for tests; `secrets` is injectable so they never touch a real vault. */
export async function checkSecrets(
  config: EthosConfig | null,
  secrets?: SecretsResolver,
): Promise<SecretCheckResult[]> {
  if (!config) return [];
  const resolver = secrets ?? (await getSecretsResolver());
  const results: SecretCheckResult[] = [];
  for (const row of SECRET_CHECKS) {
    if (!row.configuredWhen(config)) continue;
    const raw = (config[row.configKey] ?? '').trim();
    const named = [...raw.matchAll(SECRET_REF_RE)].flatMap((m) => (m[1] ? [m[1]] : []));
    // No reference in the config: the ref this key would be written to.
    const defaultRef = secretRefForConfigKey(row.configKey, { provider: config.provider });
    const refs = named.length > 0 ? named : defaultRef ? [defaultRef] : [];
    // A plaintext value still in config.yaml (pre-externalization install) is present.
    let missingRef: string | null = null;
    if (named.length > 0 || raw.length === 0) {
      for (const ref of refs) {
        if (!(await isSet(resolver, ref))) {
          missingRef = ref;
          break;
        }
      }
    }
    const present = refs.length > 0 || raw.length > 0 ? missingRef === null : false;
    const nameRef = missingRef ?? refs[0];
    results.push({
      key: (nameRef && REF_TO_ENV.get(nameRef)) || row.label(config),
      present,
      required: false,
      applicable: true,
      fillWith: nameRef ? `ethos secrets set ${nameRef} <value>` : '',
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Codex model check — is the configured model on this ChatGPT account's roster?
// ---------------------------------------------------------------------------

/** `discover` is injectable so tests never reach the real models endpoint. */
export async function checkCodexModel(
  config: EthosConfig | null,
  secrets: SecretsResolver,
  deps: { discover?: (accessToken: string) => Promise<ModelDiscovery> } = {},
): Promise<CodexModelCheck> {
  if (config?.provider !== 'codex' || !config.model) return { status: 'skipped' };
  const model = config.model;
  const tokens = await new CodexTokenStore(secrets).load();
  if (!tokens) return { status: 'unauthorized' };
  const discovery = await (deps.discover ?? discoverModels)(tokens.accessToken);
  // The fallback roster is a guess, not proof — only a live list can say no.
  if (discovery.source !== 'live') return { status: 'unverified', model };
  if (discovery.models.includes(model)) return { status: 'ok', model };
  return { status: 'unsupported', model, supported: discovery.models };
}

function codexModelLine(check: CodexModelCheck): string | null {
  switch (check.status) {
    case 'skipped':
      return null;
    case 'unauthorized':
      return `  ${c.yellow}⚠${c.reset}  Codex tokens missing — run ${c.cyan}ethos setup auth${c.reset}`;
    case 'unverified':
      return `  ${c.dim}–  Could not verify model '${check.model}' against the Codex models endpoint (offline?).${c.reset}`;
    case 'ok':
      return `  ${c.green}✓${c.reset}  Model '${check.model}' is available to this ChatGPT account`;
    case 'unsupported':
      return `  ${c.yellow}⚠${c.reset}  ${unsupportedModelMessage(check.model, check.supported)}`;
  }
}

async function checkAwsSecrets(
  config: EthosConfig | null,
): Promise<{ enabled: boolean; reachable?: boolean; secretCount?: number; error?: string }> {
  if (!config?.aws?.secrets?.enabled) return { enabled: false };
  let resolver: { list(): Promise<string[]>; dispose(): void } | undefined;
  try {
    const { AwsSecretsManagerResolver } = await import('@ethosagent/secrets-aws');
    resolver = new AwsSecretsManagerResolver({
      region: config.aws.secrets.region ?? 'us-east-1',
      prefix: config.aws.secrets.prefix ?? 'ethos',
      endpoint: config.aws.secrets.endpoint,
    });
    const refs = await resolver.list();
    return { enabled: true, reachable: true, secretCount: refs.length };
  } catch (err) {
    return {
      enabled: true,
      reachable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    resolver?.dispose();
  }
}

// ---------------------------------------------------------------------------
// W2.3 — DB / gateway-heartbeat / channel-token liveness checks.
//
// Exit-code contract: a HARD failure (rejected credential, stale heartbeat,
// unopenable sessions.db) exits 1; an UNREACHABLE-but-not-rejected channel
// probe exits with a DISTINCT warn code (2) so CI can tell "bad token" from
// "the platform is down" (W1.2 liveness).
// ---------------------------------------------------------------------------

const WARN_EXIT = 2;

export interface DoctorFailFlags {
  coreFailure: boolean;
  configuredMissing: boolean;
  awsFailed: boolean;
  requiredSecretMissing: boolean;
  dbUnopenable: boolean;
  /** `PRAGMA integrity_check` failed on at least one store — corruption is a
   *  hard failure, the same weight as `dbUnopenable`. Optional so existing
   *  call sites/tests need no change; absent behaves as `false`. */
  dbIntegrityFailed?: boolean;
  /** `~/.ethos/secrets/` is reachable by group or other. Optional; absent
   *  behaves as `false`. */
  secretsDirTooOpen?: boolean;
  gatewayStale: boolean;
  channelRejected: boolean;
  /** Unreachable-but-not-rejected — warn only, never a hard fail. */
  channelUnreachable: boolean;
  /** Call capture is configured (`callCapture.personalityId` set) but a
   *  dependency preflight check failed — "configured but broken", the same
   *  weight as `configuredMissing`. Optional so existing call sites/tests
   *  need no change; absent behaves as `false`. */
  callCaptureDepsMissing?: boolean;
  /** Call capture is configured but its daemon's heartbeat has gone stale
   *  (started, then went quiet — likely crashed) — the same weight as
   *  `gatewayStale`. A `down` daemon (never started / no heartbeat file) is
   *  NOT a failure here, mirroring `gatewayStale`'s own stale-only gate:
   *  a configured deployment between runs of `ethos serve`/`ethos gateway`
   *  is a normal state. Optional so existing call sites/tests need no
   *  change; absent behaves as `false`. */
  callCaptureDaemonStale?: boolean;
}

/** Exit-code matrix: any hard failure → 1; else an unreachable channel probe →
 *  the DISTINCT warn code (2), so CI tells "bad token" from "platform down";
 *  else 0. Hard failures always outrank the warn. */
export function computeDoctorExit(f: DoctorFailFlags): number {
  const hardFail =
    f.coreFailure ||
    f.configuredMissing ||
    f.awsFailed ||
    f.requiredSecretMissing ||
    f.dbUnopenable ||
    f.dbIntegrityFailed === true ||
    f.secretsDirTooOpen === true ||
    f.gatewayStale ||
    f.channelRejected ||
    f.callCaptureDepsMissing === true ||
    f.callCaptureDaemonStale === true;
  if (hardFail) return 1;
  if (f.channelUnreachable) return WARN_EXIT;
  return 0;
}

/**
 * Open the spool (only if it exists — a doctor run must not create one) and
 * report counts, the oldest owed row, orphans, dead letters and interrupted rows.
 *
 * A raw open plus the package's read helpers, never `SQLiteInboundSpool`,
 * whose constructor migrates (plan openclaw-9.5-adoption D24). Pinned by
 * __tests__/diagnostics-never-migrate.test.ts.
 */
export async function checkInboundSpool(
  dataDir: string,
  botKeys: readonly string[] | null,
  now = Date.now(),
): Promise<InboundSpoolReport> {
  const path = join(dataDir, 'inbound-spool.db');
  if (!existsSync(path)) return { status: 'absent' };
  const { default: Database } = await import('@ethosagent/sqlite');
  const {
    readSpoolDead,
    readSpoolInterrupted,
    readSpoolOldestReceivedAt,
    readSpoolOrphaned,
    readSpoolStats,
  } = await import('@ethosagent/inbound-spool');
  let db: InstanceType<typeof Database> | undefined;
  try {
    db = new Database(path);
    const oldest = readSpoolOldestReceivedAt(db);
    return {
      status: 'ok',
      counts: readSpoolStats(db),
      ...(oldest !== null ? { oldestReceivedAgeMs: Math.max(0, now - oldest) } : {}),
      orphaned:
        botKeys === null
          ? null
          : readSpoolOrphaned(db, botKeys).map((r) => ({
              id: r.id,
              platform: r.platform,
              botKey: r.botKey,
              chatId: r.chatId,
            })),
      dead: readSpoolDead(db, 500).map((r) => ({
        id: r.id,
        platform: r.platform,
        chatId: r.chatId,
        attempts: r.attempts,
        lastError: r.lastError ?? null,
      })),
      interrupted: readSpoolInterrupted(db, 500).map((r) => ({
        id: r.id,
        platform: r.platform,
        chatId: r.chatId,
        lastError: r.lastError ?? null,
      })),
    };
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
  } finally {
    db?.close();
  }
}

async function inboundSpoolReportFor(config: EthosConfig | null): Promise<InboundSpoolReport> {
  let botKeys: string[] | null = null;
  if (config) {
    try {
      botKeys = await configuredGatewayBotKeys(config);
    } catch {
      botKeys = null;
    }
  }
  return checkInboundSpool(ethosDir(), botKeys);
}

interface GatewayHealthResult {
  status: 'ok' | 'stale' | 'down';
  adapters: Array<{ name: string; ok: boolean }>;
  lastHeartbeatAgeSec: number | null;
}

/** Mirrors the web-api `/healthz` heartbeat semantics (30s staleness). */
async function checkGatewayHealth(storage: Storage): Promise<GatewayHealthResult> {
  const healthPath = join(homedir(), '.ethos', 'gateway-health.json');
  try {
    const raw = await storage.read(healthPath);
    if (!raw) return { status: 'down', adapters: [], lastHeartbeatAgeSec: null };
    const hb = JSON.parse(raw) as {
      updatedAt: string;
      adapters?: Array<{ name: string; ok: boolean }>;
    };
    const ageSec = (Date.now() - new Date(hb.updatedAt).getTime()) / 1000;
    const stale = !Number.isFinite(ageSec) || ageSec > 30;
    return {
      status: stale ? 'stale' : 'ok',
      // Guard against a malformed heartbeat file where `adapters` is present
      // but not an array — iterating a non-array below would throw.
      adapters: Array.isArray(hb.adapters) ? hb.adapters : [],
      lastHeartbeatAgeSec: Number.isFinite(ageSec) ? Math.round(ageSec) : null,
    };
  } catch {
    return { status: 'down', adapters: [], lastHeartbeatAgeSec: null };
  }
}

/** Mirrors `checkGatewayHealth`'s exact shape/semantics (30s staleness), for
 *  the call-capture daemon's own heartbeat file (`ethos serve`/`ethos
 *  gateway` both write it every 10s while their `CallCaptureDaemon` is
 *  running — see `extensions/platform-callcapture/src/health.ts`'s
 *  `callCaptureHealthPath()`). Says whether the daemon is alive RIGHT NOW,
 *  which `checkCallCapture`'s binary-presence check cannot answer on its
 *  own — a crashed or never-started daemon would otherwise report healthy. */
export async function checkCallCaptureDaemonHealth(
  storage: Storage,
): Promise<CallCaptureDaemonHealthResult> {
  try {
    const raw = await storage.read(callCaptureHealthPath());
    if (!raw) return { status: 'down', lastHeartbeatAgeSec: null };
    const hb = JSON.parse(raw) as { updatedAt: string };
    const ageSec = (Date.now() - new Date(hb.updatedAt).getTime()) / 1000;
    const stale = !Number.isFinite(ageSec) || ageSec > 30;
    return {
      status: stale ? 'stale' : 'ok',
      lastHeartbeatAgeSec: Number.isFinite(ageSec) ? Math.round(ageSec) : null,
    };
  } catch {
    return { status: 'down', lastHeartbeatAgeSec: null };
  }
}

interface ChannelProbeResult {
  platform: 'telegram' | 'slack' | 'discord';
  ok: boolean;
  reason?: 'rejected' | 'unreachable' | 'unverified';
  label?: string;
  error?: string;
}

/** Live-probe every configured channel token. `config` must be RESOLVED
 *  (actual tokens, not `${secrets:…}` refs). */
async function probeConfiguredChannels(config: EthosConfig | null): Promise<ChannelProbeResult[]> {
  if (!config) return [];
  const out: ChannelProbeResult[] = [];
  if (config.telegramToken) {
    const { validateTelegramToken } = await import('@ethosagent/platform-telegram/validate');
    const v = await validateTelegramToken(config.telegramToken);
    out.push({ platform: 'telegram', ok: v.ok, reason: v.reason, label: v.label, error: v.error });
  }
  if (config.slackBotToken) {
    const { validateSlackToken } = await import('@ethosagent/platform-slack/validate');
    const v = await validateSlackToken(config.slackBotToken);
    out.push({ platform: 'slack', ok: v.ok, reason: v.reason, label: v.label, error: v.error });
  }
  if (config.discordToken) {
    const { validateDiscordToken } = await import('@ethosagent/platform-discord/validate');
    const v = await validateDiscordToken(config.discordToken);
    out.push({ platform: 'discord', ok: v.ok, reason: v.reason, label: v.label, error: v.error });
  }
  return out;
}

/** Load-bearing doctor line for a channel probe (W2.3 / Z-T15). Telegram
 *  strings are verbatim; other platforms follow the same grammar. */
function channelProbeLine(p: ChannelProbeResult): string {
  if (p.ok) return `${p.platform}: ok${p.label ? ` (${p.label})` : ''}`;
  if (p.reason === 'rejected') {
    if (p.platform === 'telegram') {
      return 'telegram: token rejected (401) — regenerate with @BotFather.';
    }
    return `${p.platform}: token rejected — regenerate the token in the platform settings.`;
  }
  if (p.reason === 'unverified') {
    return `${p.platform}: rate-limited (429) — token unverified, retry later (not a settled verdict).`;
  }
  if (p.platform === 'telegram') {
    return 'telegram: unreachable (timeout) — token unverified, not necessarily invalid.';
  }
  return `${p.platform}: unreachable — token unverified, not necessarily invalid.`;
}

export interface DoctorOptions {
  /** v2.2 — Optional plugin loader for running plugin health checks.
   *  When provided (e.g. from a running gateway), doctor displays plugin
   *  health alongside the standard checks. */
  pluginLoader?: {
    runHealthChecks(): Promise<
      Array<{
        pluginId: string;
        checkName: string;
        description: string;
        result: { status: 'ok' | 'warn' | 'error'; message: string; durationMs?: number };
      }>
    >;
  };
}

/**
 * The provider-chain lines of `ethos doctor`'s Config section — empty when
 * there is no `providers:` chain. The chain decides which provider every turn
 * runs on, and this command is the one whose job is "what is wrong with my
 * config"; it said nothing about it. Mirrors `ethos fallback list`: the runtime
 * runs the chain from two entries on and the top-level fields below that
 * (`createLLM`, packages/wiring), and unmodelled fields are listed by NAME
 * only. Exported for `__tests__/doctor-provider-chain.test.ts`.
 */
export function providerChainLines(config: EthosConfig): string[] {
  const chain = config.providers ?? [];
  if (chain.length === 0) return [];
  const lines: string[] = [];
  lines.push(
    chain.length >= 2
      ? `     chain:       ${chain.length} entries — entry 1 is primary, the top-level provider/apiKey/model are not in use`
      : `     chain:       1 entry — not in use, a chain takes effect at two entries; the top-level provider/apiKey/model run`,
  );
  for (const [i, p] of chain.entries()) {
    const extra = Object.keys(p.passthrough ?? {}).sort();
    lines.push(
      `       ${i + 1}. ${c.cyan}${p.provider}${c.reset}` +
        ` · ${p.model ?? '(inherits primary model)'}` +
        ` · ${p.apiKey ? 'key set' : `${c.yellow}no key${c.reset}`}` +
        (p.baseUrl ? ` · ${p.baseUrl}` : '') +
        (p.apiVersion ? ` · apiVersion ${p.apiVersion}` : '') +
        (p.region ? ` · region ${p.region}` : '') +
        (p.awsProfile ? ` · profile ${p.awsProfile}` : '') +
        (extra.length > 0 ? ` · ${c.dim}also: ${extra.join(', ')}${c.reset}` : ''),
    );
  }
  return lines;
}

/**
 * Every personality doctor can see — built-ins plus `~/.ethos/personalities/`
 * — for the decision rows. Fail-soft: an unloadable registry costs the rows,
 * never the doctor run (the "Personality data" section reports the directory).
 */
async function loadDoctorPersonalities(
  storage: ReturnType<typeof getStorage>,
): Promise<PersonalityConfig[]> {
  try {
    const { createPersonalityRegistry } = await import('@ethosagent/personalities');
    const reg = await createPersonalityRegistry({ storage, userPersonalitiesDir: ethosDir() });
    await reg.loadFromDirectory(join(ethosDir(), 'personalities'));
    return reg.list();
  } catch {
    return [];
  }
}

export async function runDoctor(args: string[] = [], options?: DoctorOptions): Promise<void> {
  if (args.includes('--recent-errors')) {
    runRecentErrorsReport();
    return;
  }

  if (args.includes('--fix')) {
    await runDoctorFix();
    return;
  }

  if (args.includes('--check-provider')) {
    const jsonMode = args.includes('--json');
    await runProviderProbe(jsonMode);
    return;
  }

  if (args.includes('--funnel')) {
    await runFunnelReport(args.includes('--json'));
    return;
  }

  const jsonMode = args.includes('--json');

  if (jsonMode) {
    const storage = getStorage();
    const config = await readRawConfig(storage);
    const cfgPath = join(ethosDir(), 'config.yaml');
    const userPersonalitiesDir = join(homedir(), '.ethos', 'personalities');
    const personalitiesLoadable = await storage.exists(userPersonalitiesDir);

    const sdks: Array<{
      label: string;
      module: string;
      required: boolean;
      configured?: boolean;
      loadable: boolean;
    }> = [];

    for (const row of CORE_SDKS) {
      const { ok } = await checkSdk(row);
      sdks.push({ label: row.label, module: row.module, required: true, loadable: ok });
    }
    for (const row of CHANNEL_SDKS) {
      const { ok } = await checkSdk(row);
      const configured = config ? Boolean(row.configuredWhen?.(config)) : false;
      sdks.push({
        label: row.label,
        module: row.module,
        required: false,
        configured,
        loadable: ok,
      });
    }

    const coreFailures = sdks.filter((s) => s.required && !s.loadable);
    const configuredMissing = sdks.filter((s) => !s.required && s.configured && !s.loadable);

    const secretResults = await checkSecrets(config);
    const requiredSecretMissing = secretResults.some((s) => !s.present);

    const awsSecretsStatus = await checkAwsSecrets(config);
    const awsFailed = awsSecretsStatus.enabled && awsSecretsStatus.reachable === false;

    // W2.3 — DB, gateway heartbeat, and channel-token liveness.
    const db = await checkSessionsDb(storage);
    const integrity = await checkDatabaseIntegrity(ethosDir());
    const secretsDir = checkSecretsDirMode(ethosDir());
    const stateDirFilesystem = checkStateDirFilesystem(ethosDir());
    const skillIssues = checkSkillsDir(ethosDir());
    const teamIssues = checkTeamsDir(ethosDir());
    const gateway = await checkGatewayHealth(storage);
    const skipChannelProbe =
      args.includes('--skip-channel-probe') || process.env.ETHOS_SKIP_VALIDATION === '1';
    const resolvedConfig = skipChannelProbe
      ? null
      : await readConfig(storage, await getSecretsResolver());
    const channels = skipChannelProbe ? [] : await probeConfiguredChannels(resolvedConfig);
    const channelRejected = channels.some((c) => !c.ok && c.reason === 'rejected');
    // `unverified` (rate-limited) shares the warn exit with `unreachable` — the
    // distinct reason is still surfaced per-channel in the JSON below, so a 429
    // is never reported as a settled/clean verdict.
    const channelUnreachable = channels.some(
      (c) => !c.ok && (c.reason === 'unreachable' || c.reason === 'unverified'),
    );

    const callCapture = await checkCallCapture(config, storage);

    const exitCode = computeDoctorExit({
      coreFailure: coreFailures.length > 0,
      configuredMissing: configuredMissing.length > 0,
      awsFailed,
      requiredSecretMissing,
      dbUnopenable: !db.ok,
      dbIntegrityFailed: integrity.some((r) => r.status === 'failed'),
      secretsDirTooOpen: secretsDir.tooOpen,
      gatewayStale: gateway.status === 'stale',
      channelRejected,
      channelUnreachable,
      callCaptureDepsMissing: callCapture.configured && !callCapture.ok,
      callCaptureDaemonStale: callCapture.daemon?.status === 'stale',
    });

    const result = {
      version: buildVersionInfo(),
      sdks,
      config: config ? { present: true, path: cfgPath } : { present: false, path: cfgPath },
      personalities: { dir: userPersonalitiesDir, loadable: personalitiesLoadable },
      secrets: secretResults.map((s) => ({
        key: s.key,
        present: s.present,
        required: s.required,
        fillWith: s.fillWith,
      })),
      skillCliIssues: await buildSkillsCliJson(),
      awsSecrets: awsSecretsStatus,
      db: { ok: db.ok, absent: db.absent, ...(db.error ? { error: db.error } : {}) },
      storeIntegrity: integrity,
      sessionsFts: sessionsFtsOf(integrity),
      inboundSpool: await inboundSpoolReportFor(resolvedConfig ?? config),
      secretsDir,
      stateDirFilesystem,
      skillIssues,
      teamIssues,
      gateway,
      channels: channels.map((c) => ({
        platform: c.platform,
        ok: c.ok,
        ...(c.reason ? { reason: c.reason } : {}),
        ...(c.label ? { label: c.label } : {}),
      })),
      decisions: await checkDecisionLayer(
        config,
        await getSecretsResolver(),
        await loadDoctorPersonalities(storage),
      ),
      dockerSandbox: await checkDockerSandbox(config, await loadDoctorPersonalities(storage)),
      callCapture: {
        configured: callCapture.configured,
        ok: callCapture.ok,
        ...(callCapture.missing.length > 0 ? { missing: callCapture.missing } : {}),
        ...(callCapture.errors.length > 0 ? { errors: callCapture.errors } : {}),
        ...(callCapture.daemon ? { daemon: callCapture.daemon } : {}),
      },
      exit: exitCode,
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (exitCode > 0) process.exit(exitCode);
    return;
  }

  console.log('');
  console.log(`${c.bold}ethos doctor${c.reset}  ${c.dim}runtime health check${c.reset}`);
  console.log('');

  // -------------------------------------------------------------------------
  // Environment
  // -------------------------------------------------------------------------

  console.log(`${c.bold}Environment${c.reset}`);
  console.log(`  ethos    ${ETHOS_VERSION}`);
  console.log(`  node     ${process.version}`);
  console.log(`  platform ${process.platform} ${process.arch}`);
  console.log('');

  // -------------------------------------------------------------------------
  // Config
  // -------------------------------------------------------------------------

  console.log(`${c.bold}Config${c.reset}`);
  const storage = getStorage();
  const config = await readRawConfig(storage);
  const cfgPath = join(ethosDir(), 'config.yaml');
  if (!config) {
    console.log(`  ${c.yellow}⚠${c.reset}  No config at ${c.dim}${cfgPath}${c.reset}`);
    console.log(
      `      ${c.dim}Run ${c.reset}${c.cyan}ethos setup${c.reset}${c.dim} to create one.${c.reset}`,
    );
    console.log(
      `      ${c.dim}Or: ${c.reset}${c.cyan}ethos doctor --fix${c.reset}${c.dim} → ${c.cyan}ethos setup auth${c.reset}${c.dim} → ${c.cyan}ethos setup model${c.reset}`,
    );
  } else {
    console.log(`  ${c.green}✓${c.reset}  ${cfgPath}`);
    // B3 — the same Resolved block `ethos status` prints, at the top of the
    // Config section: what this config ACTUALLY selects, and from which key.
    const resolved = await resolveEffective(config);
    for (const line of formatResolvedLines(resolved, {
      stateDirFromEnv: Boolean(process.env.ETHOS_STATE_DIR),
    })) {
      console.log(`     ${line}`);
    }
    console.log(`     provider:    ${config.provider ?? '(not set)'}`);
    // `ethos gateway` and `ethos listen` surface these at boot; an operator
    // running `ethos serve` and driving the web UI would otherwise never see
    // them, and this is the command whose job is "what is wrong with my config".
    for (const line of providerChainLines(config)) console.log(line);
    for (const line of decisionLayerLines(
      await checkDecisionLayer(
        config,
        await getSecretsResolver(),
        await loadDoctorPersonalities(storage),
      ),
    ))
      console.log(line);
    for (const line of dockerSandboxLines(
      await checkDockerSandbox(config, await loadDoctorPersonalities(storage)),
    ))
      console.log(line);
    const notices = configParseNotices(config);
    for (const err of notices.errors) console.log(`  ${c.red}✗${c.reset}  ${err}`);
    for (const warn of notices.warnings) console.log(`  ${c.yellow}⚠${c.reset}  ${warn}`);
    // A `model:` the ChatGPT account cannot use fails every turn with a bare
    // 400; this is the command whose job is to say so before the first turn.
    if (process.env.ETHOS_SKIP_VALIDATION !== '1') {
      const line = codexModelLine(await checkCodexModel(config, await getSecretsResolver()));
      if (line) console.log(line);
    }
  }
  console.log('');

  // -------------------------------------------------------------------------
  // Secrets
  // -------------------------------------------------------------------------

  console.log(`${c.bold}Secrets${c.reset}`);
  const secretResults = await checkSecrets(config);
  let requiredSecretMissing = false;
  for (const s of secretResults) {
    const keyCol = s.key.padEnd(24);
    if (s.present) {
      console.log(`  ${c.green}✓${c.reset}  ${keyCol} present`);
    } else {
      requiredSecretMissing = true;
      console.log(
        `  ${c.red}✗${c.reset}  ${keyCol} ${c.red}missing${c.reset}   ${c.dim}${s.fillWith}${c.reset}`,
      );
    }
  }
  console.log('');

  // -------------------------------------------------------------------------
  // AWS Secrets Manager
  // -------------------------------------------------------------------------

  if (config?.aws?.secrets?.enabled) {
    console.log(`${c.bold}AWS Secrets Manager${c.reset}`);
    let awsResolver: { list(): Promise<string[]>; dispose(): void } | undefined;
    try {
      const { AwsSecretsManagerResolver } = await import('@ethosagent/secrets-aws');
      awsResolver = new AwsSecretsManagerResolver({
        region: config.aws.secrets.region ?? 'us-east-1',
        prefix: config.aws.secrets.prefix ?? 'ethos',
        endpoint: config.aws.secrets.endpoint,
      });
      const refs = await awsResolver.list();
      console.log(
        `  ${c.green}✓${c.reset}  Reachable, ${refs.length} secret${refs.length === 1 ? '' : 's'} visible under ${c.dim}${config.aws.secrets.prefix ?? 'ethos'}/${c.reset}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ${c.red}✗${c.reset}  Not reachable: ${c.dim}${msg}${c.reset}`);
    } finally {
      awsResolver?.dispose();
    }
    console.log('');
  }

  // -------------------------------------------------------------------------
  // Personality data directory
  // -------------------------------------------------------------------------

  console.log(`${c.bold}Personality data${c.reset}`);
  const userPersonalitiesDir = join(homedir(), '.ethos', 'personalities');
  if (await storage.exists(userPersonalitiesDir)) {
    console.log(
      `  ${c.green}✓${c.reset}  Custom personalities dir: ${c.dim}${userPersonalitiesDir}${c.reset}`,
    );
  } else {
    console.log(
      `  ${c.dim}–  No custom personalities directory yet (built-ins still work). Create ${userPersonalitiesDir}/ to add your own.${c.reset}`,
    );
  }
  console.log('');

  // -------------------------------------------------------------------------
  // Core SDKs
  // -------------------------------------------------------------------------

  console.log(`${c.bold}Core SDKs${c.reset}`);
  const coreResults: RowResult[] = [];
  for (const row of CORE_SDKS) {
    const { ok } = await checkSdk(row);
    coreResults.push({ row, ok, inUse: true });
    printRow(coreResults.at(-1) as RowResult);
  }
  console.log('');

  // -------------------------------------------------------------------------
  // Channel SDKs
  // -------------------------------------------------------------------------

  console.log(
    `${c.bold}Channel SDKs${c.reset}  ${c.dim}(optional — only matters when configured)${c.reset}`,
  );
  const channelResults: RowResult[] = [];
  for (const row of CHANNEL_SDKS) {
    const { ok } = await checkSdk(row);
    const inUse = config ? Boolean(row.configuredWhen?.(config)) : false;
    channelResults.push({ row, ok, inUse });
    printRow(channelResults.at(-1) as RowResult);
  }
  console.log('');

  // -------------------------------------------------------------------------
  // Skill prerequisites
  // -------------------------------------------------------------------------

  console.log(
    `${c.bold}Skill prerequisites${c.reset}  ${c.dim}(external CLIs declared by bundled skills)${c.reset}`,
  );
  const skillIssues = await checkSkillPrerequisites();
  if (skillIssues.length === 0) {
    console.log(`  ${c.green}✓${c.reset}  All declared external CLIs are reachable.`);
  } else {
    for (const issue of skillIssues) {
      console.log(
        `  ${c.yellow}⚠${c.reset}  ${c.bold}${issue.skill}${c.reset} needs ${c.cyan}${issue.cli}${c.reset} ${c.dim}(not on PATH)${c.reset}`,
      );
    }
  }
  console.log('');

  // -------------------------------------------------------------------------
  // Voice — what `config.voice.*` + `auxiliary.asr/tts` actually resolve to
  // -------------------------------------------------------------------------

  console.log(`${c.bold}Voice${c.reset}`);
  for (const line of await voiceReport(config)) console.log(line);
  console.log('');

  // -------------------------------------------------------------------------
  // Call capture (Phase 4) — macOS-only, opt-in via callCapture.personalityId.
  // Silent when unconfigured — see checkCallCapture's doc comment.
  // -------------------------------------------------------------------------

  const callCapture = await checkCallCapture(config, storage);
  if (callCapture.configured) {
    console.log(`${c.bold}Call capture${c.reset}`);
    if (callCapture.ok) {
      console.log(
        `  ${c.green}✓${c.reset}  All dependencies present ${c.dim}(capture-offer-card, mic-detector, mic-capture, audiotee)${c.reset}`,
      );
    } else {
      console.log(`  ${c.red}✗${c.reset}  Missing: ${callCapture.missing.join(', ')}`);
      for (const err of callCapture.errors) console.log(`      ${c.dim}${err}${c.reset}`);
    }
    if (callCapture.daemon) {
      if (callCapture.daemon.status === 'ok') {
        console.log(
          `  ${c.green}✓${c.reset}  Daemon alive ${c.dim}(heartbeat ${callCapture.daemon.lastHeartbeatAgeSec}s ago)${c.reset}`,
        );
      } else if (callCapture.daemon.status === 'stale') {
        console.log(
          `  ${c.red}✗${c.reset}  Daemon heartbeat stale (${callCapture.daemon.lastHeartbeatAgeSec}s ago) — it may have crashed`,
        );
      } else {
        console.log(
          `  ${c.dim}–  No daemon heartbeat (not currently running inside 'ethos serve'/'ethos gateway').${c.reset}`,
        );
      }
    }
    console.log('');
  }

  // -------------------------------------------------------------------------
  // Plugin health checks (v2.2)
  // -------------------------------------------------------------------------

  if (options?.pluginLoader) {
    console.log(`${c.bold}Plugin Health Checks${c.reset}`);
    try {
      const results = await options.pluginLoader.runHealthChecks();
      if (results.length === 0) {
        console.log(`  ${c.dim}–  No plugin health checks registered.${c.reset}`);
      } else {
        for (const r of results) {
          const icon =
            r.result.status === 'ok'
              ? `${c.green}✓${c.reset}`
              : r.result.status === 'warn'
                ? `${c.yellow}⚠${c.reset}`
                : `${c.red}✗${c.reset}`;
          const duration =
            r.result.durationMs != null
              ? ` ${c.dim}(${Math.round(r.result.durationMs)}ms)${c.reset}`
              : '';
          console.log(`  ${icon}  ${r.pluginId}/${r.checkName}${duration}`);
          console.log(`      ${c.dim}${r.result.message}${c.reset}`);
        }
      }
    } catch (err) {
      console.log(
        `  ${c.yellow}⚠${c.reset}  ${c.dim}Plugin health checks failed: ${err instanceof Error ? err.message : String(err)}${c.reset}`,
      );
    }
    console.log('');
  }

  // -------------------------------------------------------------------------
  // Sessions database (W2.3)
  // -------------------------------------------------------------------------

  console.log(`${c.bold}Sessions database${c.reset}`);
  const db = await checkSessionsDb(storage);
  if (db.absent) {
    console.log(`  ${c.dim}–  Not created yet (built on first chat).${c.reset}`);
  } else if (db.ok) {
    console.log(`  ${c.green}✓${c.reset}  sessions.db opens and queries cleanly`);
  } else {
    console.log(`  ${c.red}✗${c.reset}  sessions.db failed to open: ${c.dim}${db.error}${c.reset}`);
    // N2 — pair the failure with the next step (same phrasing as the Store
    // integrity section; `ethos import` is the restore command that exists).
    console.log(
      `      ${c.dim}Restore from a backup: ${c.reset}${c.bold}ethos import <archive>${c.reset}`,
    );
  }
  console.log('');

  // -------------------------------------------------------------------------
  // Store integrity (plan agent-state-backup §4)
  // -------------------------------------------------------------------------

  console.log(`${c.bold}Store integrity${c.reset}`);
  const integrity = await checkDatabaseIntegrity(ethosDir());
  const present = integrity.filter((r) => r.status !== 'absent');
  const broken = integrity.filter((r) => r.status === 'failed');
  if (present.length === 0) {
    console.log(`  ${c.dim}–  No databases created yet.${c.reset}`);
  } else if (broken.length === 0) {
    console.log(
      `  ${c.green}✓${c.reset}  PRAGMA integrity_check ok on ${present.length} store(s) ${c.dim}(${integrity.length - present.length} not created yet)${c.reset}`,
    );
  } else {
    for (const row of broken) {
      console.log(`  ${c.red}✗${c.reset}  ${row.database}: ${c.dim}${row.detail}${c.reset}`);
    }
    for (const line of integrityAdvice(integrity)) {
      console.log(`  ${c.dim}${line}${c.reset}`);
    }
  }
  const probeError = integrity.find((r) => r.database === 'sessions.db')?.ftsProbeError;
  if (probeError) {
    console.log(
      `  ${c.yellow}!${c.reset}  FTS drift check could not run: ${c.dim}${probeError}${c.reset}`,
    );
  }
  const ftsDrift = sessionsFtsOf(integrity);
  if (ftsDrift) {
    const drifted = ftsDrift.unindexed + ftsDrift.dangling;
    if (drifted > 0) {
      console.log(
        `  ${c.yellow}!${c.reset}  sessions.db search index out of step: ${ftsDrift.unindexed} unindexed, ${ftsDrift.dangling} dangling ${c.dim}(run \`ethos sessions repair\`)${c.reset}`,
      );
    } else {
      console.log(
        `  ${c.green}✓${c.reset}  sessions.db search index in step ${c.dim}(${ftsDrift.messages} messages)${c.reset}`,
      );
    }
  }
  console.log('');

  // -------------------------------------------------------------------------
  // Inbound spool (plan reach-and-containment §2.6)
  // -------------------------------------------------------------------------

  console.log(`${c.bold}Inbound spool${c.reset}`);
  {
    const secrets = await getSecretsResolver();
    const spoolConfig = await readConfig(getStorage(), secrets).catch(() => null);
    for (const line of describeInboundSpool(await inboundSpoolReportFor(spoolConfig ?? null))) {
      console.log(`  ${line}`);
    }
  }
  console.log('');

  // -------------------------------------------------------------------------
  // Secrets vault, skills and teams (plan agent-state-backup §4)
  // -------------------------------------------------------------------------

  console.log(`${c.bold}Data directory${c.reset}`);
  const secretsDir = checkSecretsDirMode(ethosDir());
  if (!secretsDir.present) {
    console.log(`  ${c.dim}–  ${describeSecretsDirMode(secretsDir)}${c.reset}`);
  } else if (secretsDir.tooOpen) {
    console.log(
      `  ${c.red}✗${c.reset}  ${describeSecretsDirMode(secretsDir)} — run ${c.bold}ethos doctor --fix${c.reset}`,
    );
  } else {
    console.log(`  ${c.green}✓${c.reset}  ${describeSecretsDirMode(secretsDir)}`);
  }
  const stateFs = checkStateDirFilesystem(ethosDir());
  if (stateFs.status === 'warn') {
    console.log(`  ${c.yellow}⚠${c.reset}  ${stateFs.message}`);
  } else if (stateFs.status === 'ok') {
    console.log(`  ${c.green}✓${c.reset}  ${stateFs.message}`);
  } else {
    console.log(`  ${c.dim}–  ${stateFs.message}${c.reset}`);
  }
  const dirIssues = [...checkSkillsDir(ethosDir()), ...checkTeamsDir(ethosDir())];
  if (dirIssues.length === 0) {
    console.log(`  ${c.green}✓${c.reset}  skills/ and teams/ layouts look right`);
  } else {
    for (const issue of dirIssues) {
      console.log(`  ${c.yellow}⚠${c.reset}  ${issue.message}`);
    }
  }
  console.log('');

  // -------------------------------------------------------------------------
  // Gateway heartbeat (W2.3) — mirrors web-api /healthz semantics
  // -------------------------------------------------------------------------

  console.log(`${c.bold}Gateway heartbeat${c.reset}`);
  const gateway = await checkGatewayHealth(storage);
  if (gateway.status === 'ok') {
    console.log(
      `  ${c.green}✓${c.reset}  fresh (${gateway.lastHeartbeatAgeSec}s ago), ${gateway.adapters.length} adapter(s)`,
    );
  } else if (gateway.status === 'stale') {
    console.log(
      `  ${c.red}✗${c.reset}  stale heartbeat (${gateway.lastHeartbeatAgeSec}s ago — gateway may have died)`,
    );
  } else {
    console.log(`  ${c.dim}–  No heartbeat file (gateway not running).${c.reset}`);
  }
  for (const a of gateway.adapters) {
    const icon = a.ok ? `${c.green}✓${c.reset}` : `${c.yellow}⚠${c.reset}`;
    console.log(`      ${icon} ${a.name}`);
  }
  console.log('');

  // -------------------------------------------------------------------------
  // Channel-token liveness (W2.3) — live probe per configured channel
  // -------------------------------------------------------------------------

  const skipChannelProbe =
    args.includes('--skip-channel-probe') || process.env.ETHOS_SKIP_VALIDATION === '1';
  const channelProbes = skipChannelProbe
    ? []
    : await probeConfiguredChannels(await readConfig(storage, await getSecretsResolver()));
  console.log(`${c.bold}Channel tokens${c.reset}`);
  if (skipChannelProbe) {
    console.log(`  ${c.dim}–  Skipped (--skip-channel-probe / ETHOS_SKIP_VALIDATION).${c.reset}`);
  } else if (channelProbes.length === 0) {
    console.log(`  ${c.dim}–  No channels configured.${c.reset}`);
  } else {
    for (const p of channelProbes) {
      const icon = p.ok
        ? `${c.green}✓${c.reset}`
        : p.reason === 'rejected'
          ? `${c.red}✗${c.reset}`
          : `${c.yellow}⚠${c.reset}`;
      console.log(`  ${icon}  ${channelProbeLine(p)}`);
    }
  }
  console.log('');

  // -------------------------------------------------------------------------
  // Verdict
  // -------------------------------------------------------------------------

  const coreFailures = coreResults.filter((r) => !r.ok);
  const configuredButMissing = channelResults.filter((r) => !r.ok && r.inUse);
  const channelRejected = channelProbes.some((p) => !p.ok && p.reason === 'rejected');
  const channelUnreachable = channelProbes.some(
    (p) => !p.ok && (p.reason === 'unreachable' || p.reason === 'unverified'),
  );

  let exitCode = 0;

  if (coreFailures.length > 0) {
    console.log(
      `${c.red}✗ Core SDK missing — ethos cannot run.${c.reset} Reinstall: ${c.cyan}npm install -g @ethosagent/cli${c.reset}`,
    );
    exitCode = 1;
  }
  if (configuredButMissing.length > 0) {
    const list = configuredButMissing.map((r) => r.row.label).join(', ');
    console.log(`${c.red}✗ Configured channels with missing SDKs: ${list}${c.reset}`);
    console.log(
      `${c.dim}  Install the listed packages globally, or remove the channel from ~/.ethos/config.yaml.${c.reset}`,
    );
    console.log(
      `${c.dim}  Or try: ${c.reset}${c.cyan}ethos doctor --fix${c.reset}${c.dim} → ${c.cyan}ethos setup auth${c.reset}${c.dim} → ${c.cyan}ethos setup model${c.reset}`,
    );
    exitCode = 1;
  }
  if (requiredSecretMissing) {
    console.log(`${c.red}✗ Required secret missing — see Secrets section above.${c.reset}`);
    exitCode = 1;
  }
  if (!db.ok) {
    console.log(
      `${c.red}✗ sessions.db could not be opened — see Sessions database above.${c.reset}`,
    );
    exitCode = 1;
  }
  if (broken.length > 0) {
    console.log(
      `${c.red}✗ ${broken.length} store(s) failed PRAGMA integrity_check — see Store integrity above.${c.reset}`,
    );
    exitCode = 1;
  }
  if (secretsDir.tooOpen) {
    console.log(
      `${c.red}✗ secrets/ is readable beyond its owner (mode ${secretsDir.mode}) — run ${c.cyan}ethos doctor --fix${c.reset}${c.red}.${c.reset}`,
    );
    exitCode = 1;
  }
  if (gateway.status === 'stale') {
    console.log(
      `${c.red}✗ Gateway heartbeat is stale — the gateway process may have died.${c.reset}`,
    );
    exitCode = 1;
  }
  if (channelRejected) {
    console.log(`${c.red}✗ A channel token was rejected — see Channel tokens above.${c.reset}`);
    exitCode = 1;
  }
  if (callCapture.configured && !callCapture.ok) {
    console.log(
      `${c.red}✗ Call capture is configured but a dependency is missing — see Call capture above.${c.reset}`,
    );
    exitCode = 1;
  }
  // Unreachable-but-not-rejected → DISTINCT warn exit code (2), so CI can tell a
  // bad token from an outage. Hard failures still take precedence.
  if (exitCode === 0 && channelUnreachable) {
    console.log(
      `${c.yellow}⚠ A channel token could not be verified (platform unreachable) — see above.${c.reset}`,
    );
    exitCode = WARN_EXIT;
  }
  if (exitCode > 0) {
    process.exit(exitCode);
  }
  console.log(`${c.green}✓ Healthy.${c.reset}`);
}

/**
 * Call-capture dependency diagnostics (plan/phases/call-capture-extension.md,
 * "Preflight" §6 / T5). Structured result — text mode and `--json` mode each
 * render it their own way, mirroring `probeConfiguredChannels` /
 * `channelProbeLine`'s data/presentation split. `configured && !ok` feeds
 * `computeDoctorExit`'s `callCaptureDepsMissing` flag: configured-but-broken
 * is a hard failure, the same weight as a configured-but-missing channel SDK.
 */
export async function checkCallCapture(
  config: EthosConfig | null,
  storage: Storage,
  options: CheckCallCaptureOptions = {},
): Promise<CallCaptureCheckResult> {
  if (!config?.callCapture?.personalityId) {
    return { configured: false, ok: true, missing: [], errors: [] };
  }
  const checkDependencies =
    options.checkDependencies ??
    (async () => {
      const { checkCallCaptureDependencies } = await import('@ethosagent/platform-callcapture');
      return checkCallCaptureDependencies();
    });
  const [result, daemon] = await Promise.all([
    checkDependencies(),
    checkCallCaptureDaemonHealth(storage),
  ]);
  if (result.ok) return { configured: true, ok: true, missing: [], errors: [], daemon };
  return { configured: true, ok: false, missing: result.missing, errors: result.errors, daemon };
}

/**
 * Voice diagnostics. Runs the SAME resolution path the pipeline uses — same
 * registries, same `trustedVoicePlugins` gate — so a refusal shows up here
 * rather than as silent "voice doesn't work". Resolution constructs providers
 * only; it makes no network calls.
 */
async function voiceReport(config: EthosConfig | null): Promise<string[]> {
  const lines: string[] = [];
  const asr = config?.auxiliary?.asr;
  const tts = config?.auxiliary?.tts;
  const voice = config?.voice;
  if (!asr && !tts && !voice) {
    lines.push(
      `  ${c.dim}–  Not configured (no auxiliary.asr / auxiliary.tts / voice.*).${c.reset}`,
    );
    return lines;
  }

  // Dynamic import — @ethosagent/wiring pulls in the full provider/tool graph
  // (the heaviest package in the repo); loading it only when voice is actually
  // configured keeps --check-provider and other narrow doctor paths cheap.
  const { createBuiltinVoiceRegistries } = await import('@ethosagent/wiring');
  const { sttProviders, ttsProviders } = createBuiltinVoiceRegistries();
  const trustedVoicePlugins = voice?.trustedPlugins ? new Set(voice.trustedPlugins) : undefined;
  const stt = await resolveSttProvider({
    registry: sttProviders,
    providerName: asr?.provider,
    providerConfig: { ...asr },
    ...(trustedVoicePlugins ? { trustedVoicePlugins } : {}),
  });
  const speech = await resolveTtsProvider({
    registry: ttsProviders,
    providerName: tts?.provider,
    providerConfig: { ...tts },
    ...(trustedVoicePlugins ? { trustedVoicePlugins } : {}),
  });

  for (const [label, result] of [
    ['STT', stt],
    ['TTS', speech],
  ] as const) {
    if (result.ok) {
      const local = result.provider.caps.local ? 'local' : 'remote';
      lines.push(
        `  ${c.green}✓${c.reset}  ${label} ${c.cyan}${result.providerId}${c.reset} ${c.dim}(${local})${c.reset}`,
      );
    } else if (result.code === 'not_configured') {
      lines.push(`  ${c.dim}–  ${label} not configured.${c.reset}`);
    } else {
      lines.push(`  ${c.red}✗${c.reset}  ${label}: ${c.dim}${result.error}${c.reset}`);
    }
  }

  lines.push(
    trustedVoicePlugins
      ? `  ${c.green}✓${c.reset}  Egress gate armed ${c.dim}(voice.trustedPlugins: ${
          trustedVoicePlugins.size > 0
            ? [...trustedVoicePlugins].join(', ')
            : 'local providers only'
        })${c.reset}`
      : `  ${c.dim}–  Egress gate off (set voice.trustedPlugins to restrict non-local providers).${c.reset}`,
  );

  // Telephony gets its own rows only when there is a `voice.*` block to report
  // on. Without one there is no number, no trunk and no media question to ask —
  // and a dynamic import of a native package is not worth paying for to print
  // "absent" three ways.
  if (voice) lines.push(...(await telephonyReport(voice)));
  else lines.push(`  ${c.dim}–  Telephony not configured (no voice.*).${c.reset}`);
  return lines;
}

async function checkSkillPrerequisites(): Promise<SkillPrereqIssue[]> {
  const issues: SkillPrereqIssue[] = [];
  const pool = await new UniversalScanner({
    storage: getStorage(),
    trustedFirstPartySources: [bundledSkillsSource()],
  }).scan();

  for (const skill of pool.values()) {
    if (skill.source !== 'ethos-bundled') continue;
    const { all, anyOf } = readExternalCliRequirements(skill);

    for (const cli of all) {
      if (!isOnPath(cli)) issues.push({ skill: skill.name, cli });
    }

    if (anyOf.length > 0 && !anyOf.some(isOnPath)) {
      issues.push({ skill: skill.name, cli: `one of ${anyOf.join(' / ')}` });
    }
  }

  return issues;
}

async function buildSkillsCliJson(): Promise<
  Array<{ name: string; path: string | null; ok: boolean }>
> {
  const skillIssues = await checkSkillPrerequisites();
  return skillIssues.map((i) => ({ name: i.cli, path: null, ok: false }));
}
