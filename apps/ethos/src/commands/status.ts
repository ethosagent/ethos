import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  type EffectiveConfig,
  type EthosConfig,
  ethosCronDir,
  ethosDir,
  readRawConfig,
  resolveEffectiveConfig,
} from '@ethosagent/config';
import { backupDirectory, FileSecretsResolver } from '@ethosagent/wiring';
import { errorLogExists, errorLogPath, readRecentErrors } from '../error-log';
import { buildVersionInfo } from '../version-info';
import { getSecretsResolver, getStorage } from '../wiring';

// `ethos status` — single-pane health summary.
//
// Composes signals operators currently have to gather across four commands
// (doctor, cron list, mesh peers, config cat). Output is intentionally short:
// one line per facet, colour-coded by health. Exit 0 if everything green
// or yellow; exit non-zero only when something is structurally broken
// (no config, no provider, no personality) — same posture as `doctor`.

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

const G = `${c.green}✓${c.reset}`;
const W = `${c.yellow}!${c.reset}`;
const R = `${c.red}✗${c.reset}`;

declare const __ETHOS_VERSION__: string;
const ETHOS_VERSION =
  typeof __ETHOS_VERSION__ === 'string' ? __ETHOS_VERSION__ : (process.env.ETHOS_VERSION ?? 'dev');

export async function runStatus(cmdArgs: string[] = []): Promise<void> {
  const jsonMode = cmdArgs.includes('--json');
  let hardErrors = 0;

  if (!jsonMode) {
    console.log(`${c.bold}ethos${c.reset} ${c.dim}${ETHOS_VERSION}${c.reset}\n`);
  }

  // ---- Config ------------------------------------------------------------
  const storage = getStorage();
  const config = await readRawConfig(storage);
  if (!config) {
    if (jsonMode) {
      process.stdout.write(
        `${JSON.stringify({ version: buildVersionInfo(), config: { present: false }, adapters: [], personalities: { count: 0, dir: '' }, errorLog: { exists: false, recentCount: 0 }, exit: 1 })}\n`,
      );
      process.exit(1);
    }
    console.log(
      `${R} ${c.bold}config${c.reset}        no ~/.ethos/config.yaml — run ${c.bold}ethos setup${c.reset}`,
    );
    process.exit(1);
  }
  // ---- Personality data dir (shared data collection) -------------------
  const pdir = join(ethosDir(), 'personalities');
  const personalityCount = existsSync(pdir)
    ? readdirSync(pdir).filter((n) => !n.startsWith('.')).length
    : 0;

  // ---- Channel-filter (shared: may increment hardErrors) ---------------
  const adapterLines = adapterStatus(config);
  const channelFilters = countChannelFilters(config);
  if (channelFilters === 0 && adapterLines.length > 0) {
    hardErrors++;
  }

  // ---- Gateway memory (U9) ---------------------------------------------
  const memory = gatewayMemoryFacet(
    await storage.read(join(ethosDir(), 'gateway-health.json')).catch(() => null),
    Date.now(),
  );

  // ---- Resolved block (B3/B8) + pending work (N4) -----------------------
  const resolved = await resolveEffective(config);
  const pending = await collectPendingSummary(config, resolved.personality.id);

  // ---- JSON path -------------------------------------------------------
  if (jsonMode) {
    const result = {
      version: buildVersionInfo(),
      config: {
        present: true,
        provider: config.provider,
        model: config.model,
        personality: resolved.personality.id,
      },
      resolved,
      pending,
      adapters: buildAdapterJson(config),
      personalities: { count: personalityCount, dir: pdir },
      cron: countCronJobs(),
      backups: buildBackupJson(config),
      memory,
      errorLog: { exists: errorLogExists(), recentCount: readRecentErrors(10).length },
      exit: hardErrors > 0 ? 1 : 0,
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (hardErrors > 0) process.exit(1);
    return;
  }

  // ---- TTY path --------------------------------------------------------
  // B3 — what this machine ACTUALLY runs with, printed first (§6.3).
  console.log(`${c.bold}Resolved${c.reset}`);
  for (const line of formatResolvedLines(resolved, {
    stateDirFromEnv: Boolean(process.env.ETHOS_STATE_DIR),
  })) {
    console.log(`  ${line}`);
  }
  console.log('');

  const cfgLine =
    `${G} ${c.bold}config${c.reset}        ${c.cyan}${config.provider}${c.reset} · ${config.model}` +
    ` · personality=${resolved.personality.id}` +
    (config.providers && config.providers.length > 0
      ? ` · fallback chain (${config.providers.length})`
      : '');
  console.log(cfgLine);

  // ---- Config parse warnings (B2) ---------------------------------------
  if (resolved.warnings.length > 0) {
    console.log(
      `${W} ${c.bold}warnings${c.reset}      ${resolved.warnings.length} config warning${resolved.warnings.length === 1 ? '' : 's'} · run ${c.bold}ethos doctor${c.reset} for each line`,
    );
  }

  // ---- Adapters configured ----------------------------------------------
  for (const line of adapterLines) console.log(line);

  // ---- Personality data dir -------------------------------------------
  if (existsSync(pdir)) {
    const ids = readdirSync(pdir).filter((n) => !n.startsWith('.'));
    console.log(
      `${G} ${c.bold}personalities${c.reset} ${ids.length} user-level + bundled ${c.dim}(${pdir})${c.reset}`,
    );
  } else {
    console.log(
      `${W} ${c.bold}personalities${c.reset} no user-level dir at ${c.dim}${pdir}${c.reset} (only bundled visible)`,
    );
  }

  // ---- Mesh registry ---------------------------------------------------
  const meshDir = join(ethosDir(), 'meshes');
  if (existsSync(meshDir)) {
    const meshes = readdirSync(meshDir).filter((n) => !n.startsWith('.'));
    const totalPeers = meshes.reduce((sum, m) => sum + countMeshPeers(join(meshDir, m)), 0);
    console.log(
      `${G} ${c.bold}mesh${c.reset}          ${meshes.length} mesh${meshes.length === 1 ? '' : 'es'}` +
        `, ${totalPeers} registered agent${totalPeers === 1 ? '' : 's'} ${c.dim}(${meshDir})${c.reset}`,
    );
  } else {
    console.log(`${c.dim}- mesh          no meshes${c.reset}`);
  }

  // ---- Cron ------------------------------------------------------------
  const cron = countCronJobs();
  if (cron.status === 'absent') {
    console.log(`${c.dim}- cron          no scheduled jobs yet${c.reset}`);
  } else if (cron.status === 'unreadable') {
    console.log(
      `${W} ${c.bold}cron${c.reset}          store unreadable or malformed ${c.dim}(${join(ethosCronDir(), 'jobs.json')}: ${cron.detail})${c.reset}`,
    );
  } else {
    console.log(
      `${G} ${c.bold}cron${c.reset}          ${cron.total} job${cron.total === 1 ? '' : 's'}` +
        `, ${cron.enabled} enabled ${c.dim}(run ${c.reset}${c.bold}ethos cron list${c.dim} for details)${c.reset}`,
    );
  }

  // ---- Backups ---------------------------------------------------------
  const last = lastBackup(config);
  if (last === null) {
    console.log(
      `${c.dim}- backups       none in ${backupDir(config)} (run ${c.reset}${c.bold}ethos backup${c.dim})${c.reset}`,
    );
  } else {
    console.log(
      `${G} ${c.bold}backups${c.reset}       last ${last.mtime.toISOString().slice(0, 16).replace('T', ' ')}` +
        ` ${c.dim}(${(last.size / 1024 / 1024).toFixed(1)} MB, ${last.name}${last.count > 1 ? `, ${last.count} kept` : ''})${c.reset}`,
    );
  }

  // ---- MCP servers -----------------------------------------------------
  const mcpJson = join(ethosDir(), 'mcp.json');
  if (existsSync(mcpJson)) {
    const count = countMcpServers(mcpJson);
    console.log(
      `${G} ${c.bold}mcp${c.reset}           ${count} server${count === 1 ? '' : 's'} configured ${c.dim}(${mcpJson})${c.reset}`,
    );
  } else {
    console.log(`${c.dim}- mcp           no servers configured${c.reset}`);
  }

  // ---- Messaging allowlist --------------------------------------------
  const messagingJson = join(ethosDir(), 'messaging.json');
  if (existsSync(messagingJson)) {
    const count = countMessagingEntries(messagingJson);
    console.log(
      `${G} ${c.bold}messaging${c.reset}     ${count} personality allowlist${count === 1 ? '' : 's'} ${c.dim}(${messagingJson})${c.reset}`,
    );
  } else {
    console.log(
      `${c.dim}- messaging     no allowlists → send_message denied for all personalities${c.reset}`,
    );
  }

  // ---- Channel-filter --------------------------------------------------
  if (channelFilters > 0) {
    console.log(
      `${G} ${c.bold}channel_filter${c.reset} ${channelFilters} platform${channelFilters === 1 ? '' : 's'} owner-gated`,
    );
  } else if (adapterLines.length > 0) {
    console.log(
      `${R} ${c.bold}channel_filter${c.reset} adapters configured but no ${c.bold}channel_filter.<platform>.ownerUserId${c.reset} set — gateway will refuse to start`,
    );
  }

  // ---- Gateway memory (U9) ---------------------------------------------
  if (memory.gatewayRssBytes !== null) {
    console.log(
      `${G} ${c.bold}memory${c.reset}        gateway rss ${(memory.gatewayRssBytes / 1024 / 1024).toFixed(0)} MB` +
        ` ${c.dim}(heartbeat ${memory.heartbeatAgeSec}s ago)${c.reset}`,
    );
  } else {
    console.log(`${c.dim}- memory        no fresh gateway heartbeat${c.reset}`);
  }

  // ---- Pending work waiting for a human (N4) ---------------------------
  if (pending.memory !== null && pending.memory > 0) {
    console.log(
      `${W} ${c.bold}memory${c.reset}        ${pending.memory} candidate${pending.memory === 1 ? '' : 's'} awaiting approval · ${c.bold}ethos memory pending${c.reset}`,
    );
  }
  if (pending.outbox !== null && pending.outbox > 0) {
    console.log(
      `${W} ${c.bold}outbox${c.reset}        ${pending.outbox} draft${pending.outbox === 1 ? '' : 's'} · ${c.bold}ethos outbox list${c.reset}`,
    );
  }
  if (pending.cron !== null && pending.cron.failures24h > 0) {
    console.log(
      `${W} ${c.bold}cron${c.reset}          ${pending.cron.failures24h} failure${pending.cron.failures24h === 1 ? '' : 's'} in 24h · ${c.bold}ethos cron show ${pending.cron.latestFailedId ?? '<id>'}${c.reset}`,
    );
  }

  // ---- Recent errors --------------------------------------------------
  if (errorLogExists()) {
    const recent = readRecentErrors(10);
    if (recent.length === 0) {
      console.log(
        `${G} ${c.bold}errors${c.reset}        log present, no recent entries ${c.dim}(${errorLogPath()})${c.reset}`,
      );
    } else {
      const latest = recent[recent.length - 1];
      const when = latest ? latest.ts.slice(0, 19).replace('T', ' ') : '';
      console.log(
        `${W} ${c.bold}errors${c.reset}        ${recent.length} recent entr${recent.length === 1 ? 'y' : 'ies'}` +
          (latest ? ` · latest ${c.dim}${when}${c.reset} ${c.cyan}${latest.code}${c.reset}` : '') +
          ` ${c.dim}(${errorLogPath()})${c.reset}`,
      );
    }
  } else {
    console.log(`${c.dim}- errors        no error log written yet${c.reset}`);
  }

  // ---- Footer ---------------------------------------------------------
  console.log('');
  if (hardErrors > 0) {
    console.log(
      `${c.red}${hardErrors} blocking issue${hardErrors === 1 ? '' : 's'}.${c.reset} Run ${c.bold}ethos doctor${c.reset} for detailed diagnosis.`,
    );
    process.exit(1);
  }
  console.log(
    `${c.dim}Run ${c.reset}${c.bold}ethos doctor${c.reset}${c.dim} for deeper diagnostics; ${c.reset}${c.bold}ethos cron list${c.reset}${c.dim} for cron details; ${c.reset}${c.bold}ethos logs${c.reset}${c.dim} for activity.${c.reset}`,
  );
}

// ---------------------------------------------------------------------------
// B3/B8 — the Resolved block
// ---------------------------------------------------------------------------

/**
 * Resolve the effective config with the file vault's ref listing, so
 * `apiKey.overrides: 'vault'` and `source: 'missing'` can be computed (an env
 * hit that shadows a stored secret; a ref nothing on this machine serves).
 * The vault is listed directly — the merged resolver's `list()` unions
 * env-sourced refs in, which would claim the vault holds every key the
 * environment does. Fail-soft: an unreadable vault passes NO listing, so the
 * resolver reports env/vault without the overrides or missing claims.
 *
 * `getSecretsResolver()` runs first for its side effect: it is the same seam
 * wiring uses (apps/ethos/src/wiring.ts `initSecrets`), and it loads
 * `~/.ethos/.env` (or `ETHOS_ENV_FILE`) into `process.env` — without it a key
 * that lives only in .env would misreport its source as vault/missing here
 * while the runtime actually reads it from env.
 */
export async function resolveEffective(config: EthosConfig): Promise<EffectiveConfig> {
  try {
    await getSecretsResolver();
  } catch {
    // Fail-soft: status must always print; the resolution below still runs
    // against whatever process.env already holds.
  }
  let vaultRefs: string[] | undefined;
  try {
    const vault = new FileSecretsResolver({
      dir: join(ethosDir(), 'secrets'),
      storage: getStorage(),
    });
    vaultRefs = await vault.list();
  } catch {
    // No vault listing — never claim 'missing' on a vault this command
    // could not read.
    vaultRefs = undefined;
  }
  return resolveEffectiveConfig(config, process.env, vaultRefs === undefined ? {} : { vaultRefs });
}

/**
 * The `Resolved` block body (plan §6.3), shared by `ethos status` and the top
 * of `ethos doctor`'s Config section. The model rung is CONFIG-level only —
 * see the caveat on `resolveEffectiveConfig`; a personality's own declaration
 * or a model-registry role can land a turn elsewhere.
 */
export function formatResolvedLines(
  r: EffectiveConfig,
  opts: { stateDirFromEnv: boolean },
): string[] {
  const dim = (s: string) => `${c.dim}${s}${c.reset}`;
  const pad = (s: string) => s.padEnd(20);

  const personalityNote =
    r.personality.source === 'activeContext'
      ? `(activeContext${r.personality.shadowed ? `; personality: key says ${r.personality.shadowed}` : ''})`
      : r.personality.source === 'personality'
        ? '(personality:)'
        : '(default)';

  const rungNote =
    r.model.rung === 'model:' ? '(model:)' : `(${r.personality.id} → ${r.model.rung})`;

  let keyNote: string;
  if (r.apiKey.source === 'inline') {
    keyNote = 'source: inline apiKey in config.yaml';
  } else if (r.apiKey.source === 'env') {
    keyNote = `source: env ${r.apiKey.envVar ?? ''}${r.apiKey.overrides === 'vault' ? ', overrides vault' : ''}`;
  } else if (r.apiKey.source === 'missing') {
    keyNote = `source: none found — ethos secrets set ${r.apiKey.ref ?? '<ref>'}`;
  } else {
    keyNote = `source: vault ${r.apiKey.ref ?? ''}`;
  }

  const warningsNote =
    r.warnings.length > 0
      ? ` ${dim(`(${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'} · ethos doctor)`)}`
      : '';

  return [
    `state dir    ${pad(r.stateDir)} ${dim(opts.stateDirFromEnv ? '(ETHOS_STATE_DIR)' : '(ETHOS_STATE_DIR not set)')}`,
    `config       ${r.configPath}${warningsNote}`,
    `personality  ${pad(r.personality.id)} ${dim(personalityNote)}`,
    `model        ${pad(r.model.id)} ${dim(rungNote)}`,
    `api key      ${pad(r.apiKey.provider)} ${dim(keyNote)}`,
  ];
}

// ---------------------------------------------------------------------------
// N4 — pending work waiting for a human
// ---------------------------------------------------------------------------

export interface PendingSummary {
  /** Pending memory candidates for the effective personality; null when the
   *  store could not be opened. */
  memory: number | null;
  /** Publications awaiting review/approval; null when this machine has no
   *  outbox.db or it could not be opened. */
  outbox: number | null;
  /** Cron failures in the last 24h; null when the cron store is absent or
   *  unreadable. */
  cron: { failures24h: number; latestFailedId: string | null } | null;
}

/** Every facet is fail-soft: a store that is absent or refuses to open is
 *  `null`, never a crash — `ethos status` must always print. */
export async function collectPendingSummary(
  config: EthosConfig,
  personalityId: string,
): Promise<PendingSummary> {
  let memory: number | null = null;
  try {
    const { createPendingMemoryStore } = await import('@ethosagent/wiring');
    const { store } = createPendingMemoryStore({
      dataDir: ethosDir(),
      storage: getStorage(),
      config,
    });
    memory = (await store.list(`personality:${personalityId}`)).length;
  } catch {
    memory = null;
  }

  let outbox: number | null = null;
  try {
    const outboxPath = join(ethosDir(), 'outbox.db');
    // Open only a file that exists — reading must not create one (same rule
    // as `ethos outbox`).
    if (existsSync(outboxPath)) {
      const { SQLiteOutboxStore } = await import('../lib/outbox-wiring');
      const store = new SQLiteOutboxStore(outboxPath);
      try {
        outbox = store.listByState(['awaiting_review', 'awaiting_approval']).length;
      } finally {
        store.close();
      }
    }
  } catch {
    outbox = null;
  }

  let cron: PendingSummary['cron'] = null;
  const cronStore = countCronJobs();
  if (cronStore.status === 'ok') {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(ethosCronDir(), 'jobs.json'), 'utf-8'));
      cron = cronFailureSummary(parsed);
    } catch {
      cron = null;
    }
  }

  return { memory, outbox, cron };
}

/**
 * Jobs whose last run failed within the last 24h, from the fields the cron
 * store records (`lastRunAt` + `lastError`, extensions/cron/src/index.ts).
 * Limitation: `lastError` is written on failure and never cleared by a later
 * successful run, so a job that failed once and has succeeded since still
 * counts until its next failure overwrites the field — the store keeps no
 * per-run outcome history to disambiguate with.
 */
export function cronFailureSummary(
  jobs: unknown,
  now = Date.now(),
): { failures24h: number; latestFailedId: string | null } {
  if (!Array.isArray(jobs)) return { failures24h: 0, latestFailedId: null };
  let failures = 0;
  let latestId: string | null = null;
  let latestAt = 0;
  for (const j of jobs) {
    if (typeof j !== 'object' || j === null) continue;
    const { id, lastError, lastRunAt } = j as {
      id?: unknown;
      lastError?: unknown;
      lastRunAt?: unknown;
    };
    if (typeof lastError !== 'string' || lastError.length === 0) continue;
    if (typeof lastRunAt !== 'string') continue;
    const ranAt = Date.parse(lastRunAt);
    if (!Number.isFinite(ranAt) || now - ranAt > 24 * 60 * 60 * 1000) continue;
    failures++;
    if (ranAt > latestAt && typeof id === 'string') {
      latestAt = ranAt;
      latestId = id;
    }
  }
  return { failures24h: failures, latestFailedId: latestId };
}

// ---------------------------------------------------------------------------
// Per-facet helpers
// ---------------------------------------------------------------------------

/** A heartbeat older than this is a gateway that is not running — the same
 *  30s window `/healthz` in web-api and the desktop's gateway control use. */
const HEARTBEAT_FRESH_SEC = 30;

/**
 * U9 — the running gateway's resident set size, from the `rssBytes` its
 * heartbeat writer records every 10s (`buildGatewayHeartbeat`,
 * apps/ethos/src/commands/gateway.ts). Not this command's own
 * `process.memoryUsage()`: that would measure a CLI that exits in a second.
 * Null when the heartbeat is absent, unparseable, stale, or from a build that
 * predates the field. Pinned by `__tests__/status-memory.test.ts`.
 */
export function gatewayMemoryFacet(
  raw: string | null,
  now: number,
): { gatewayRssBytes: number | null; heartbeatAgeSec: number | null } {
  const none = { gatewayRssBytes: null, heartbeatAgeSec: null };
  if (raw === null) return none;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return none;
  }
  if (typeof parsed !== 'object' || parsed === null) return none;
  const { updatedAt, rssBytes } = parsed as { updatedAt?: unknown; rssBytes?: unknown };
  if (typeof updatedAt !== 'string' || typeof rssBytes !== 'number') return none;
  const ageSec = Math.round((now - Date.parse(updatedAt)) / 1000);
  if (!Number.isFinite(ageSec) || ageSec > HEARTBEAT_FRESH_SEC) return none;
  return { gatewayRssBytes: rssBytes, heartbeatAgeSec: Math.max(ageSec, 0) };
}

function adapterStatus(config: EthosConfig): string[] {
  const lines: string[] = [];

  // Telegram (legacy + multi-bot)
  const legacyTg = !!config.telegramToken;
  const tgBots = config.telegram?.bots ?? [];
  if (legacyTg || tgBots.length > 0) {
    const summary = legacyTg
      ? `legacy single bot${tgBots.length > 0 ? ` + ${tgBots.length} multi-bot` : ''}`
      : `${tgBots.length} bot${tgBots.length === 1 ? '' : 's'}`;
    lines.push(`${G} ${c.bold}telegram${c.reset}      ${summary}`);
  }

  // Slack (legacy + multi-app)
  const legacySlack = !!(config.slackBotToken && config.slackAppToken && config.slackSigningSecret);
  const slackApps = config.slack?.apps ?? [];
  if (legacySlack || slackApps.length > 0) {
    const summary = legacySlack
      ? `legacy single app${slackApps.length > 0 ? ` + ${slackApps.length} multi-app` : ''}`
      : `${slackApps.length} app${slackApps.length === 1 ? '' : 's'}`;
    lines.push(`${G} ${c.bold}slack${c.reset}         ${summary}`);
  }

  // Discord
  if (config.discordToken) {
    lines.push(`${G} ${c.bold}discord${c.reset}       configured`);
  }

  // Email
  if (config.emailImapHost && config.emailUser && config.emailPassword && config.emailSmtpHost) {
    lines.push(
      `${G} ${c.bold}email${c.reset}         IMAP+SMTP configured ${c.dim}(${config.emailUser})${c.reset}`,
    );
  }

  return lines;
}

function buildAdapterJson(
  config: EthosConfig,
): Array<{ name: string; configured: boolean; ok: boolean | null }> {
  const adapters: Array<{ name: string; configured: boolean; ok: boolean | null }> = [];
  const tgConfigured = Boolean(config.telegramToken || (config.telegram?.bots?.length ?? 0) > 0);
  adapters.push({ name: 'telegram', configured: tgConfigured, ok: tgConfigured ? true : null });
  const slackConfigured = Boolean(
    (config.slackBotToken && config.slackAppToken && config.slackSigningSecret) ||
      (config.slack?.apps?.length ?? 0) > 0,
  );
  adapters.push({ name: 'slack', configured: slackConfigured, ok: slackConfigured ? true : null });
  adapters.push({
    name: 'discord',
    configured: Boolean(config.discordToken),
    ok: config.discordToken ? true : null,
  });
  const emailConfigured = Boolean(
    config.emailImapHost && config.emailUser && config.emailPassword && config.emailSmtpHost,
  );
  adapters.push({ name: 'email', configured: emailConfigured, ok: emailConfigured ? true : null });
  return adapters;
}

function countChannelFilters(config: EthosConfig): number {
  let n = 0;
  if (config.channelFilter) {
    for (const cfg of Object.values(config.channelFilter)) {
      if (cfg && typeof cfg === 'object' && 'ownerUserId' in cfg && cfg.ownerUserId) n++;
    }
  }
  return n;
}

/**
 * Cron jobs live in `cron/jobs.json` — a `CronJob[]` written by
 * `CronScheduler` (`extensions/cron/src/index.ts`). There has never been a
 * `cron/jobs.db`: the check this replaces looked for a file nothing in the
 * repo writes, so it always reported "no scheduled jobs yet".
 *
 * The three states are distinct on purpose. A store that cannot be read or
 * parsed is an UNKNOWN number of jobs, and reporting it as `0` — as this did —
 * states as a fact the one thing that was not established. That is the same
 * mistake the `jobs.db` check this replaced made, one layer down.
 */
export type CronStoreState =
  | { status: 'absent' }
  | { status: 'ok'; total: number; enabled: number }
  | { status: 'unreadable'; detail: string };

export function countCronJobs(): CronStoreState {
  const path = join(ethosCronDir(), 'jobs.json');
  if (!existsSync(path)) return { status: 'absent' };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (!Array.isArray(parsed)) return { status: 'unreadable', detail: 'not a JSON array' };
    const enabled = parsed.filter(
      (j) => typeof j === 'object' && j !== null && (!('enabled' in j) || j.enabled !== false),
    ).length;
    return { status: 'ok', total: parsed.length, enabled };
  } catch (err) {
    return { status: 'unreadable', detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Where backups are kept — `backup.dir`, defaulting to `<ethosDir>/backups`.
 * The default is computed in code, never written as a `${ETHOS_HOME}` token in
 * config.yaml (plan D5). Config is optional so the helper still answers for a
 * deployment that has none.
 */
export function backupDir(config?: EthosConfig): string {
  return backupDirectory(config);
}

export interface LastBackup {
  name: string;
  size: number;
  mtime: Date;
  /** How many archives are kept in the directory. */
  count: number;
}

/** The newest `.tar.gz` in the backup directory, or `null` when there is none. */
export function lastBackup(config?: EthosConfig): LastBackup | null {
  const dir = backupDir(config);
  if (!existsSync(dir)) return null;
  let newest: LastBackup | null = null;
  let count = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.tar.gz')) continue;
      count++;
      const s = statSync(join(dir, entry.name));
      if (newest === null || s.mtime > newest.mtime) {
        newest = { name: entry.name, size: s.size, mtime: s.mtime, count: 0 };
      }
    }
  } catch {
    return null;
  }
  return newest === null ? null : { ...newest, count };
}

function buildBackupJson(config: EthosConfig): {
  dir: string;
  count: number;
  last: { name: string; bytes: number; at: string } | null;
} {
  const last = lastBackup(config);
  return {
    dir: backupDir(config),
    count: last?.count ?? 0,
    last: last && { name: last.name, bytes: last.size, at: last.mtime.toISOString() },
  };
}

function countMeshPeers(meshDir: string): number {
  const reg = join(meshDir, 'registry.json');
  if (!existsSync(reg)) return 0;
  try {
    const parsed = JSON.parse(readFileSync(reg, 'utf-8')) as { agents?: unknown[] };
    return Array.isArray(parsed.agents) ? parsed.agents.length : 0;
  } catch {
    return 0;
  }
}

function countMcpServers(path: string): number {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function countMessagingEntries(path: string): number {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return typeof parsed === 'object' && parsed !== null ? Object.keys(parsed).length : 0;
  } catch {
    return 0;
  }
}
