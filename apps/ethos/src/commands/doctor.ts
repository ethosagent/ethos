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

import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type EthosConfig, ethosDir, readRawConfig } from '@ethosagent/config';
import { bundledSkillsSource, UniversalScanner } from '@ethosagent/skills';
import type { Skill } from '@ethosagent/types';
import { errorLogExists, errorLogPath, readRecentErrors } from '../error-log';
import { buildVersionInfo } from '../version-info';
import { createLLM, getSecretsResolver, getStorage } from '../wiring';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

declare const __ETHOS_VERSION__: string;
const ETHOS_VERSION =
  typeof __ETHOS_VERSION__ === 'string' ? __ETHOS_VERSION__ : (process.env.ETHOS_VERSION ?? 'dev');

interface SdkRow {
  label: string;
  module: string;
  required: boolean;
  /** Config keys that, if set, mean this SDK is "in use" — missing is a hard error. */
  configuredWhen?: (cfg: EthosConfig) => boolean;
}

const CORE_SDKS: SdkRow[] = [
  { label: 'Anthropic provider', module: '@anthropic-ai/sdk', required: true },
  { label: 'OpenAI-compat provider', module: 'openai', required: true },
];

const CHANNEL_SDKS: SdkRow[] = [
  {
    label: 'Telegram',
    module: 'grammy',
    required: false,
    configuredWhen: (cfg) => Boolean(cfg.telegramToken),
  },
  {
    label: 'Discord',
    module: 'discord.js',
    required: false,
    configuredWhen: (cfg) => Boolean(cfg.discordToken),
  },
  {
    label: 'Slack',
    module: '@slack/bolt',
    required: false,
    configuredWhen: (cfg) =>
      Boolean(cfg.slackBotToken && cfg.slackAppToken && cfg.slackSigningSecret),
  },
  {
    label: 'Email (IMAP)',
    module: 'imapflow',
    required: false,
    configuredWhen: (cfg) => Boolean(cfg.emailImapHost && cfg.emailUser && cfg.emailPassword),
  },
  {
    label: 'Email (parser)',
    module: 'mailparser',
    required: false,
    configuredWhen: (cfg) => Boolean(cfg.emailImapHost && cfg.emailUser && cfg.emailPassword),
  },
  {
    label: 'Email (SMTP)',
    module: 'nodemailer',
    required: false,
    configuredWhen: (cfg) => Boolean(cfg.emailSmtpHost && cfg.emailUser && cfg.emailPassword),
  },
];

interface SecretCheckRow {
  key: string;
  secretRef: string;
  required: boolean;
  fillWith: string;
  configuredWhen?: (cfg: EthosConfig) => boolean;
}

const SECRET_CHECKS: SecretCheckRow[] = [
  {
    key: 'ANTHROPIC_API_KEY',
    secretRef: 'anthropic-api-key',
    required: false,
    fillWith: 'ethos keys set anthropic-api-key <value>',
    configuredWhen: (cfg) => cfg.provider === 'anthropic',
  },
  {
    key: 'OPENAI_API_KEY',
    secretRef: 'openai-api-key',
    required: false,
    fillWith: 'ethos keys set openai-api-key <value>',
    configuredWhen: (cfg) => cfg.provider === 'openai-compat',
  },
  {
    key: 'TELEGRAM_BOT_TOKEN',
    secretRef: 'telegram-bot-token',
    required: false,
    fillWith: 'ethos keys set telegram-bot-token <value>',
    configuredWhen: (cfg) => Boolean(cfg.telegramToken),
  },
  {
    key: 'SLACK_BOT_TOKEN',
    secretRef: 'slack-bot-token',
    required: false,
    fillWith: 'ethos keys set slack-bot-token <value>',
    configuredWhen: (cfg) => Boolean(cfg.slackBotToken),
  },
  {
    key: 'DISCORD_BOT_TOKEN',
    secretRef: 'discord-bot-token',
    required: false,
    fillWith: 'ethos keys set discord-bot-token <value>',
    configuredWhen: (cfg) => Boolean(cfg.discordToken),
  },
];

interface SecretCheckResult {
  key: string;
  present: boolean;
  required: boolean;
  applicable: boolean;
  fillWith: string;
}

async function checkSecrets(config: EthosConfig | null): Promise<SecretCheckResult[]> {
  const secrets = await getSecretsResolver();
  const results: SecretCheckResult[] = [];
  for (const row of SECRET_CHECKS) {
    const hasCondition = Boolean(row.configuredWhen);
    const conditionMet = hasCondition && config ? row.configuredWhen?.(config) : false;
    const applicable = row.required || Boolean(conditionMet);
    if (!applicable) continue;
    const val = await secrets.get(row.secretRef);
    const present = val !== null && val.trim().length > 0;
    results.push({
      key: row.key,
      present,
      required: row.required,
      applicable: true,
      fillWith: row.fillWith,
    });
  }
  return results;
}

async function checkSdk(modulePath: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await import(modulePath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

interface RowResult {
  row: SdkRow;
  ok: boolean;
  inUse: boolean;
}

function printRow(r: RowResult): void {
  const tag = r.ok
    ? `${c.green}✓${c.reset}`
    : r.row.required || r.inUse
      ? `${c.red}✗${c.reset}`
      : `${c.dim}–${c.reset}`;
  const label = r.row.label.padEnd(24);
  const module = `${c.dim}${r.row.module}${c.reset}`;
  const note = r.ok
    ? ''
    : r.row.required
      ? `  ${c.red}(required — ethos will not work)${c.reset}`
      : r.inUse
        ? `  ${c.red}(configured but SDK missing — install with ${c.cyan}npm install -g ${r.row.module}${c.reset}${c.red})${c.reset}`
        : `  ${c.dim}(not installed; not in use)${c.reset}`;
  console.log(`  ${tag}  ${label} ${module}${note}`);
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
      const { ok } = await checkSdk(row.module);
      sdks.push({ label: row.label, module: row.module, required: true, loadable: ok });
    }
    for (const row of CHANNEL_SDKS) {
      const { ok } = await checkSdk(row.module);
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
    const exitCode =
      coreFailures.length > 0 || configuredMissing.length > 0 || awsFailed || requiredSecretMissing
        ? 1
        : 0;

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
    console.log(`     provider:    ${config.provider ?? '(not set)'}`);
    console.log(`     model:       ${config.model ?? '(not set)'}`);
    console.log(`     personality: ${config.personality ?? '(default)'}`);
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
    const { ok } = await checkSdk(row.module);
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
    const { ok } = await checkSdk(row.module);
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
  // Verdict
  // -------------------------------------------------------------------------

  const coreFailures = coreResults.filter((r) => !r.ok);
  const configuredButMissing = channelResults.filter((r) => !r.ok && r.inUse);

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
  if (exitCode > 0) {
    process.exit(exitCode);
  }
  if (coreFailures.length === 0 && configuredButMissing.length === 0 && !requiredSecretMissing) {
    console.log(`${c.green}✓ Healthy.${c.reset}`);
  }
}

// ---------------------------------------------------------------------------
// --fix: auto-repair common issues
// ---------------------------------------------------------------------------

async function runDoctorFix(): Promise<void> {
  const { chmod } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const storage = getStorage();
  const dir = ethosDir();
  let exitCode = 0;

  console.log('');
  console.log(`${c.bold}ethos doctor --fix${c.reset}`);
  console.log('');

  // 1. Ensure ~/.ethos/personalities/ exists
  const personalitiesDir = join(dir, 'personalities');
  if (!(await storage.exists(personalitiesDir))) {
    await storage.mkdir(personalitiesDir);
    console.log(`  ${c.green}✓ Fixed:${c.reset}  Created ${personalitiesDir}`);
  } else {
    console.log(`  ${c.green}✓${c.reset}  ${personalitiesDir} exists`);
  }

  // 2. Seed MEMORY.md and USER.md
  for (const filename of ['MEMORY.md', 'USER.md']) {
    const path = join(dir, filename);
    if (!(await storage.exists(path))) {
      await storage.write(path, '');
      console.log(`  ${c.green}✓ Fixed:${c.reset}  Created ${path}`);
    } else {
      console.log(`  ${c.green}✓${c.reset}  ${path} exists`);
    }
  }

  // 3. Fix keys.json permissions (should be 0o600)
  const keysPath = join(dir, 'keys.json');
  if (existsSync(keysPath)) {
    try {
      await chmod(keysPath, 0o600);
      console.log(`  ${c.green}✓ Fixed:${c.reset}  Set ${keysPath} to 0600`);
    } catch {
      console.log(`  ${c.yellow}⚠${c.reset}  Could not chmod ${keysPath}`);
      exitCode = 1;
    }
  }

  // 4. Fix config.yaml permissions (may contain secret refs; restrict to owner)
  const configPath = join(dir, 'config.yaml');
  if (existsSync(configPath)) {
    try {
      await chmod(configPath, 0o600);
      console.log(`  ${c.green}✓ Fixed:${c.reset}  Set ${configPath} to 0600`);
    } catch {
      console.log(`  ${c.yellow}⚠${c.reset}  Could not chmod ${configPath}`);
      exitCode = 1;
    }
  }

  // 5. Validate provider in config
  const config = await readRawConfig(storage);
  if (config) {
    const { PROVIDER_CATALOG } = await import('@ethosagent/wiring/provider-catalog');
    const knownIds = PROVIDER_CATALOG.map((p) => p.id);
    if (!knownIds.includes(config.provider)) {
      const closest = knownIds.find((id) => id.startsWith(config.provider[0] ?? '')) ?? 'anthropic';
      console.log(
        `  ${c.yellow}→ Action needed:${c.reset}  Unknown provider '${config.provider}'. Did you mean '${closest}'?`,
      );
      console.log(`  ${c.dim}  Edit ~/.ethos/config.yaml and set provider: ${closest}${c.reset}`);
      exitCode = 1;
    } else {
      console.log(`  ${c.green}✓${c.reset}  Provider '${config.provider}' is valid`);
    }
  } else {
    console.log(
      `  ${c.yellow}→ Action needed:${c.reset}  No config found. Run: ${c.cyan}ethos setup${c.reset}`,
    );
    exitCode = 1;
  }

  console.log('');
  if (exitCode === 0) {
    console.log(`${c.green}✓ All auto-repairs complete.${c.reset}`);
  } else {
    console.log(
      `${c.yellow}⚠ Some issues need manual action. Try: ${c.cyan}ethos doctor --fix → ethos setup auth → ethos setup model${c.reset}`,
    );
    process.exit(exitCode);
  }
}

// ---------------------------------------------------------------------------
// --check-provider: live connectivity probe against the configured LLM
// ---------------------------------------------------------------------------

export interface ProviderProbeResult {
  provider: string;
  model: string;
  reachable: boolean;
  latencyMs: number | null;
  error: string | null;
  exit: number;
}

async function runProviderProbe(jsonMode: boolean): Promise<void> {
  const storage = getStorage();
  const config = await readRawConfig(storage);

  if (!config) {
    const result: ProviderProbeResult = {
      provider: 'unknown',
      model: 'unknown',
      reachable: false,
      latencyMs: null,
      error: 'No config found — run ethos setup',
      exit: 1,
    };
    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      console.log(
        `Provider connectivity: ${c.red}✗${c.reset} No config found — run ${c.cyan}ethos setup${c.reset}`,
      );
    }
    process.exit(1);
  }

  const provider = config.provider;
  const model = config.model;

  let reachable = false;
  let latencyMs: number | null = null;
  let error: string | null = null;

  try {
    const llm = await createLLM(config);
    const start = performance.now();
    // Consume the async iterable — we only need to confirm the provider responds.
    // Using max 1 token keeps the call as cheap as possible.
    for await (const _chunk of llm.complete([{ role: 'user', content: 'ping' }], [], {
      maxTokens: 1,
    })) {
      // drain
    }
    latencyMs = Math.round(performance.now() - start);
    reachable = true;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const exit = reachable ? 0 : 1;
  const result: ProviderProbeResult = { provider, model, reachable, latencyMs, error, exit };

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (reachable) {
    console.log(
      `Provider connectivity: ${c.green}✓${c.reset} ${provider} (${model}) — ${latencyMs}ms`,
    );
  } else {
    console.log(`Provider connectivity: ${c.red}✗${c.reset} ${provider} (${model}) — ${error}`);
  }

  if (exit > 0) process.exit(exit);
}

// ---------------------------------------------------------------------------
// --recent-errors: grouped summary of ~/.ethos/logs/errors.jsonl
// ---------------------------------------------------------------------------

function runRecentErrorsReport(): void {
  console.log('');
  console.log(`${c.bold}ethos doctor${c.reset}  ${c.dim}recent errors${c.reset}`);
  console.log('');

  if (!errorLogExists()) {
    console.log(`  ${c.dim}No error log yet (${errorLogPath()}).${c.reset}`);
    console.log(`  ${c.dim}This is a healthy state — nothing has failed.${c.reset}`);
    console.log('');
    return;
  }

  const recent = readRecentErrors(50);
  if (recent.length === 0) {
    console.log(`  ${c.dim}Log file is present but empty: ${errorLogPath()}${c.reset}`);
    console.log('');
    return;
  }

  // Group by code, count, keep newest occurrence per code for the timestamp.
  const byCode = new Map<string, { count: number; latest: string; sample: string }>();
  for (const e of recent) {
    const existing = byCode.get(e.code);
    if (existing) {
      existing.count += 1;
      // recent[] is newest-first; keep the first timestamp seen.
    } else {
      byCode.set(e.code, { count: 1, latest: e.ts, sample: e.cause });
    }
  }

  const rows = [...byCode.entries()].sort((a, b) => b[1].count - a[1].count);

  console.log(`  ${c.dim}From ${errorLogPath()} (last ${recent.length} entries)${c.reset}`);
  console.log('');
  console.log(`  ${c.bold}${'Count'.padStart(5)}  ${'Code'.padEnd(28)}  Most-recent at${c.reset}`);
  for (const [code, info] of rows) {
    const count = String(info.count).padStart(5);
    const codeCol = code.padEnd(28);
    console.log(`  ${count}  ${c.cyan}${codeCol}${c.reset}  ${c.dim}${info.latest}${c.reset}`);
    console.log(`         ${c.dim}↳ ${info.sample}${c.reset}`);
  }
  console.log('');
  console.log(`  ${c.dim}File a bug? Attach the relevant lines from ${errorLogPath()}.${c.reset}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// Skill prerequisite check — reads `ethos.prerequisites.external_cli` from
// each bundled skill's frontmatter and verifies the binary is on PATH.
// `coding-agent` lists multiple CLI alternatives — at least one must be
// present (it routes to whichever is installed).
// ---------------------------------------------------------------------------

interface SkillPrereqIssue {
  skill: string;
  cli: string;
}

function readExternalCliRequirements(skill: Skill): { all: string[]; anyOf: string[] } {
  const ethos = skill.rawFrontmatter.ethos as
    | { prerequisites?: { external_cli?: unknown } }
    | undefined;
  const raw = ethos?.prerequisites?.external_cli;
  if (!Array.isArray(raw)) return { all: [], anyOf: [] };
  const all: string[] = [];
  const anyOf: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      all.push(item);
    } else if (item && typeof item === 'object' && 'any_of' in item) {
      const list = (item as { any_of: unknown }).any_of;
      if (Array.isArray(list)) {
        for (const candidate of list) {
          if (typeof candidate === 'string') anyOf.push(candidate);
        }
      }
    }
  }
  return { all, anyOf };
}

function isOnPath(bin: string): boolean {
  return spawnSync('which', [bin], { stdio: 'ignore' }).status === 0;
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
