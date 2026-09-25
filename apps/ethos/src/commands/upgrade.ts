// `ethos upgrade` — fetch the latest published version, compare with what's
// running, and upgrade through `npm install -g`, gated on the new binary's
// health. Detects source-mode (running via tsx from a git clone) and prints the
// right git/pnpm instructions instead.
//
// Per Phase 29.5; the health gate is plan openclaw-9.5-adoption item 4
// (D8, D24–D26). `--version <spec>` (plan openclaw-2026.9.6-gaps U7) targets an
// exact version or a dist-tag instead of `latest`; the registry resolves it to
// the exact version the gate then checks for (`resolveVersion`).
//
//   1. Baseline — the CURRENT binary's `ethos doctor --json`.
//   2. Backup — `ethos backup --json`. A failure aborts before anything is
//      installed.
//   3. Install — `npm install -g @ethosagent/cli@<target>`.
//   4. Gate — the NEW binary's `ethos doctor --json`, resolved from
//      `$(npm root -g)/@ethosagent/cli/<bin entry>` and spawned with
//      `process.execPath`, never a PATH lookup (which can hit another nvm
//      install). `evaluateUpgrade` decides.
//   5. Rollback — `npm install -g @ethosagent/cli@<previous>`, then the old
//      binary's doctor must match the baseline (`matchesBaseline`). If either
//      step fails, print the backup and the exact `ethos import` command. A
//      restore is never run from here: it is destructive and takes its own lock.
//
// The gate is only meaningful because doctor never migrates a store (D24,
// pinned by __tests__/diagnostics-never-migrate.test.ts): the new binary's
// doctor leaves every `user_version` where the old binary can still open it.
// A running gateway is never restarted (D26) — once a new gateway has migrated
// the stores, rolling the binary back is unsafe — so upgrade prints a hint.

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EthosError } from '@ethosagent/types';
import { z } from 'zod';
import { importCommand } from './backup';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

const PACKAGE = '@ethosagent/cli';
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
/** The public changelog; each release has a `#v<major>-<minor>-<patch>` anchor. */
const CHANGELOG_URL = 'https://ethosagent.ai/docs/changelog';
/** An exact version (`0.7.3`, `0.8.0-rc.1`) or a dist-tag (`latest`, `next`).
 *  Not a range: the gate compares the installed version to one exact string. */
const VERSION_SPEC = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;
/** A doctor run probes channels over the network; give it room, not forever. */
const CHILD_TIMEOUT_MS = 180_000;

declare const __ETHOS_VERSION__: string;
const CURRENT_VERSION =
  typeof __ETHOS_VERSION__ === 'string' ? __ETHOS_VERSION__ : (process.env.ETHOS_VERSION ?? 'dev');

// ---------------------------------------------------------------------------
// Doctor report — the subset of `ethos doctor --json` the gate reads
// (`runDoctor` in ./doctor.ts builds it). Parsed, not cast: a different
// version's doctor produced it.
// ---------------------------------------------------------------------------

const DoctorReportSchema = z.object({
  version: z.object({ version: z.string() }),
  sdks: z
    .array(
      z.object({
        module: z.string(),
        required: z.boolean(),
        configured: z.boolean().optional(),
        loadable: z.boolean(),
      }),
    )
    .default([]),
  secrets: z.array(z.object({ key: z.string(), present: z.boolean() })).default([]),
  awsSecrets: z.object({ enabled: z.boolean(), reachable: z.boolean().optional() }).optional(),
  db: z.object({ ok: z.boolean(), error: z.string().optional() }),
  storeIntegrity: z
    .array(z.object({ database: z.string(), status: z.string(), detail: z.string().optional() }))
    .default([]),
  inboundSpool: z
    .object({
      status: z.string(),
      error: z.string().optional(),
      orphaned: z.array(z.unknown()).nullable().optional(),
    })
    .optional(),
  secretsDir: z.object({ tooOpen: z.boolean() }).optional(),
  gateway: z.object({ status: z.string() }).optional(),
  channels: z
    .array(z.object({ platform: z.string(), ok: z.boolean(), reason: z.string().optional() }))
    .default([]),
  callCapture: z
    .object({
      configured: z.boolean(),
      ok: z.boolean(),
      daemon: z.object({ status: z.string() }).optional(),
    })
    .optional(),
});

export type DoctorReport = z.infer<typeof DoctorReportSchema>;

/**
 * How a failing check is treated.
 *
 * - `binary` — about the installed code itself: a failure on the new binary
 *   rolls back whatever the baseline said.
 * - `regression` — rolls back only when the check passed in the baseline.
 * - `environmental` — about processes and the network, not the binary: never
 *   rolls back, always reported.
 */
export type CheckKind = 'binary' | 'regression' | 'environmental';

export interface FailedCheck {
  id: string;
  kind: CheckKind;
  detail: string;
}

/** Every failing check in a report. The mapping from `runDoctor`'s JSON — and
 *  from `computeDoctorExit`'s flags — to a kind lives here and only here. */
export function failedChecks(r: DoctorReport): FailedCheck[] {
  const out: FailedCheck[] = [];
  const add = (id: string, kind: CheckKind, detail: string) => out.push({ id, kind, detail });

  // coreFailure
  for (const s of r.sdks) {
    if (s.required && !s.loadable) add(`sdk:${s.module}`, 'binary', 'core SDK not loadable');
  }
  // dbUnopenable
  if (!r.db.ok) add('db', 'binary', `sessions.db failed to open: ${r.db.error ?? 'unknown'}`);
  // dbIntegrityFailed
  for (const s of r.storeIntegrity) {
    if (s.status === 'failed') {
      add(`integrity:${s.database}`, 'binary', `integrity check failed: ${s.detail ?? ''}`);
    }
  }
  // configuredMissing
  for (const s of r.sdks) {
    if (!s.required && s.configured === true && !s.loadable) {
      add(`sdk:${s.module}`, 'regression', 'configured channel SDK not loadable');
    }
  }
  // requiredSecretMissing
  for (const s of r.secrets) {
    if (!s.present) add(`secret:${s.key}`, 'regression', 'secret missing');
  }
  // awsFailed
  if (r.awsSecrets?.enabled && r.awsSecrets.reachable === false) {
    add('awsSecrets', 'regression', 'AWS Secrets Manager unreachable');
  }
  // secretsDirTooOpen
  if (r.secretsDir?.tooOpen) add('secretsDir', 'regression', 'secrets directory too open');
  // channelRejected / channelUnreachable
  for (const ch of r.channels) {
    if (ch.ok) continue;
    if (ch.reason === 'rejected') add(`channel:${ch.platform}`, 'regression', 'token rejected');
    else add(`channel:${ch.platform}`, 'environmental', `channel ${ch.reason ?? 'unreachable'}`);
  }
  // callCaptureDepsMissing / callCaptureDaemonStale
  if (r.callCapture?.configured && !r.callCapture.ok) {
    add('callCapture', 'regression', 'call capture dependencies missing');
  }
  if (r.callCapture?.daemon?.status === 'stale') {
    add('callCaptureDaemon', 'environmental', 'call-capture daemon heartbeat stale');
  }
  // gatewayStale
  if (r.gateway?.status === 'stale') add('gateway', 'environmental', 'gateway heartbeat stale');
  // Not in computeDoctorExit: the spool opening at all is the binary's job; the
  // rows a gateway has not delivered yet are not.
  if (r.inboundSpool?.status === 'failed') {
    add('inboundSpool', 'regression', `inbound-spool.db failed to open: ${r.inboundSpool.error}`);
  }
  const orphaned = r.inboundSpool?.orphaned?.length ?? 0;
  if (orphaned > 0) {
    add(
      'inboundSpool:orphaned',
      'environmental',
      `${orphaned} owed message(s) for an unconfigured bot`,
    );
  }
  return out;
}

/** Parse a doctor's stdout. `null` when it is not a doctor report. */
export function parseDoctorReport(stdout: string): DoctorReport | null {
  // Doctor writes exactly one JSON line; anything else a child prints to
  // stdout (a warning) precedes it.
  const lines = stdout.trim().split('\n').reverse();
  for (const line of lines) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const parsed = DoctorReportSchema.safeParse(JSON.parse(line));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
  return null;
}

export interface UpgradeVerdict {
  /** Why to roll back. Empty means the new binary is accepted. */
  triggers: string[];
  /** Failing checks that do not roll back — pre-existing or environmental. */
  reported: string[];
}

/**
 * Decide on the new binary from its doctor run (plan openclaw-9.5-adoption
 * D25). `after` is `null` when the new doctor could not be spawned or printed
 * no report; `spawnError` says which.
 */
export function evaluateUpgrade(
  baseline: DoctorReport,
  after: DoctorReport | null,
  target: string,
  spawnError?: string,
): UpgradeVerdict {
  if (after === null) {
    return { triggers: [spawnError ?? 'the new doctor printed no JSON report'], reported: [] };
  }
  const triggers: string[] = [];
  const reported: string[] = [];
  if (after.version.version !== target) {
    triggers.push(`the new binary reports version ${after.version.version}, not ${target}`);
  }
  const before = new Set(failedChecks(baseline).map((f) => f.id));
  for (const f of failedChecks(after)) {
    const line = `${f.id}: ${f.detail}`;
    if (f.kind === 'binary') triggers.push(line);
    else if (f.kind === 'regression' && !before.has(f.id)) triggers.push(`regression — ${line}`);
    else reported.push(before.has(f.id) ? `${line} (already failing before the upgrade)` : line);
  }
  return { triggers, reported };
}

/** The rolled-back binary is healthy iff it is the previous version and fails
 *  nothing the baseline did not already fail (environmental checks aside). */
export function matchesBaseline(
  baseline: DoctorReport,
  after: DoctorReport | null,
  previous: string,
): boolean {
  if (after === null || after.version.version !== previous) return false;
  const before = new Set(failedChecks(baseline).map((f) => f.id));
  return failedChecks(after).every((f) => f.kind === 'environmental' || before.has(f.id));
}

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

type InstallMethod = 'npm' | 'source';

export interface ChildResult {
  /** Set when the child could not be spawned or was killed by the timeout. */
  spawnError?: string;
  stdout: string;
  code: number | null;
}

export interface UpgradeDeps {
  installMethod: InstallMethod;
  currentVersion: string;
  /** The running binary's entry script (`process.argv[1]`). */
  currentEntry: string;
  /** Resolve an exact version or dist-tag to the exact version it names. */
  resolveVersion(spec: string): Promise<string>;
  /** Run `node <entry> ...args` and capture stdout. */
  runEthos(entry: string, args: string[]): Promise<ChildResult>;
  /** `npm install -g <spec>`, output inherited. Returns the exit code. */
  npmInstall(spec: string): Promise<number>;
  /** `npm root -g`. */
  npmRootGlobal(): Promise<string>;
  readFile(path: string): Promise<string>;
  /** Whether a gateway process holds this state dir's lock right now. */
  gatewayLive(): Promise<boolean>;
  log(line: string): void;
  error(line: string): void;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function runUpgrade(
  args: readonly string[] = [],
  deps: UpgradeDeps = defaultDeps(),
): Promise<number> {
  const { log, error } = deps;
  const noRollback = args.includes('--no-rollback');
  const versionAt = args.indexOf('--version');
  const requested = versionAt === -1 ? 'latest' : args[versionAt + 1];
  if (requested === undefined || !VERSION_SPEC.test(requested)) {
    error(
      `${c.red}✗${c.reset} --version needs an exact version or a dist-tag, e.g. ${c.cyan}ethos upgrade --version 0.7.3${c.reset}.`,
    );
    return 1;
  }

  // Source-mode users update via git, not npm — no need to hit the registry.
  // (Also avoids confusing "registry 404" errors when running from a private
  // fork or before the cli has been published.)
  if (deps.installMethod === 'source') {
    log(`\n  ${c.dim}Current:${c.reset} ${c.bold}${deps.currentVersion}${c.reset}\n`);
    printSourceInstructions(log);
    return 0;
  }

  // npm install — check the registry to show before/after, then install.
  log(`${c.dim}Checking npm registry...${c.reset}`);
  let target: string;
  try {
    target = await deps.resolveVersion(requested);
  } catch (err) {
    error(`${c.red}✗${c.reset} Couldn't reach the npm registry: ${errMsg(err)}`);
    error(
      `${c.dim}  Check your network and try again, or install manually: npm install -g ${PACKAGE}@${requested}${c.reset}`,
    );
    return 1;
  }

  const previous = deps.currentVersion;
  log(`\n  ${c.dim}Current:${c.reset} ${c.bold}${previous}${c.reset}`);
  const label = requested === 'latest' ? 'Latest: ' : 'Target: ';
  log(`  ${c.dim}${label}${c.reset} ${c.bold}${target}${c.reset}\n`);
  if (previous === target) {
    log(
      `${c.green}✓${c.reset} Already on ${requested === 'latest' ? 'the latest version' : target}.`,
    );
    return 0;
  }

  // 1. Baseline.
  log(`${c.dim}Recording a health baseline (ethos doctor --json)...${c.reset}`);
  const baselineRun = await deps.runEthos(deps.currentEntry, ['doctor', '--json']);
  const baseline = baselineRun.spawnError ? null : parseDoctorReport(baselineRun.stdout);
  if (baseline === null) {
    error(
      `${c.red}✗${c.reset} Could not record a baseline: ${baselineRun.spawnError ?? 'ethos doctor --json printed no report'}. Nothing was installed.`,
    );
    return 1;
  }

  // 2. Backup.
  log(`${c.dim}Backing up ~/.ethos (ethos backup)...${c.reset}`);
  const backupRun = await deps.runEthos(deps.currentEntry, ['backup', '--json']);
  const archive = backupPath(backupRun);
  if (archive === null) {
    error(
      `${c.red}✗${c.reset} Backup failed (${backupRun.spawnError ?? `exit ${backupRun.code}`}). Nothing was installed.`,
    );
    error(`${c.dim}  Run ${c.reset}${c.cyan}ethos backup${c.reset}${c.dim} to see why.${c.reset}`);
    return 1;
  }
  log(`${c.green}✓${c.reset} Backup written to ${archive}`);

  // 3. Install.
  const spec = `${PACKAGE}@${target}`;
  log(`${c.dim}Running ${c.reset}${c.cyan}npm install -g ${spec}${c.reset}${c.dim}...${c.reset}\n`);
  const installCode = await deps.npmInstall(spec);
  if (installCode !== 0) {
    error(`\n${c.red}✗${c.reset} npm install failed (exit code ${installCode}).`);
    return installCode;
  }

  // 4. Gate.
  log(`\n${c.dim}Checking the new binary (ethos doctor --json)...${c.reset}`);
  const verdict = await gate(deps, baseline, target);
  for (const line of verdict.reported) log(`  ${c.yellow}⚠${c.reset}  ${line}`);
  for (const line of verdict.triggers) log(`  ${c.red}✗${c.reset}  ${line}`);

  if (verdict.triggers.length === 0) {
    log(`\n${c.green}✓${c.reset} Upgraded to ${c.bold}${spec}${c.reset}.`);
    log(`${c.dim}  What changed: ${changelogUrl(target)}${c.reset}`);
    await printGatewayHint(deps);
    return 0;
  }

  if (noRollback) {
    error(
      `\n${c.red}✗${c.reset} ${spec} failed its health check. --no-rollback: it stays installed.`,
    );
    printRestore(error, archive, previous);
    await printGatewayHint(deps);
    return 1;
  }

  // 5. Rollback.
  const previousSpec = `${PACKAGE}@${previous}`;
  error(`\n${c.red}✗${c.reset} ${spec} failed its health check. Rolling back to ${previousSpec}.`);
  const rollbackCode = await deps.npmInstall(previousSpec);
  if (rollbackCode !== 0) {
    error(`${c.red}✗${c.reset} Rollback install failed (exit code ${rollbackCode}).`);
    printRestore(error, archive, previous);
    return 1;
  }
  const check = await runInstalledDoctor(deps);
  if (!matchesBaseline(baseline, check.report, previous)) {
    error(`${c.red}✗${c.reset} ${previousSpec} is installed but does not match its baseline.`);
    printRestore(error, archive, previous);
    return 1;
  }
  error(`${c.yellow}⚠${c.reset} Rolled back: ${previousSpec} is installed and healthy again.`);
  error(`${c.dim}  Backup kept at ${archive}${c.reset}`);
  return 1;
}

async function gate(deps: UpgradeDeps, baseline: DoctorReport, target: string) {
  const run = await runInstalledDoctor(deps);
  return evaluateUpgrade(baseline, run.report, target, run.spawnError);
}

/** Resolve the globally installed binary from npm's own root and run its doctor. */
async function runInstalledDoctor(
  deps: UpgradeDeps,
): Promise<{ report: DoctorReport | null; spawnError?: string }> {
  let entry: string;
  try {
    entry = await installedEntry(deps);
  } catch (err) {
    return { report: null, spawnError: `could not locate the installed binary: ${errMsg(err)}` };
  }
  const run = await deps.runEthos(entry, ['doctor', '--json']);
  if (run.spawnError)
    return { report: null, spawnError: `the new doctor failed: ${run.spawnError}` };
  const report = parseDoctorReport(run.stdout);
  return report === null
    ? { report: null, spawnError: 'the new doctor printed no JSON report' }
    : { report };
}

/** `$(npm root -g)/@ethosagent/cli/<bin entry>` — the path npm just wrote. */
async function installedEntry(deps: UpgradeDeps): Promise<string> {
  const pkgDir = join(await deps.npmRootGlobal(), PACKAGE);
  const PackageJson = z.object({
    bin: z.union([z.string(), z.record(z.string(), z.string())]),
  });
  const pkg = PackageJson.parse(JSON.parse(await deps.readFile(join(pkgDir, 'package.json'))));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin.ethos ?? Object.values(pkg.bin)[0]);
  if (!bin) {
    throw new EthosError({
      code: 'FILE_NOT_FOUND',
      cause: `${PACKAGE}/package.json declares no bin`,
      action: `Reinstall: npm install -g ${PACKAGE}@latest`,
    });
  }
  return join(pkgDir, bin);
}

function backupPath(run: ChildResult): string | null {
  if (run.spawnError) return null;
  const Backup = z.object({ ok: z.literal(true), path: z.string() });
  for (const line of run.stdout.trim().split('\n').reverse()) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const parsed = Backup.safeParse(JSON.parse(line));
      return parsed.success ? parsed.data.path : null;
    } catch {
      return null;
    }
  }
  return null;
}

function printRestore(out: (line: string) => void, archive: string, previous: string): void {
  out('');
  out(`${c.bold}Your data was backed up before the upgrade:${c.reset} ${archive}`);
  out('To go back by hand:');
  out(`  ${c.cyan}npm install -g ${PACKAGE}@${previous}${c.reset}`);
  out(`  ${c.cyan}${importCommand(archive)}${c.reset}`);
  out(
    `${c.dim}Nothing was restored automatically — ethos import replaces the current state.${c.reset}`,
  );
}

async function printGatewayHint(deps: UpgradeDeps): Promise<void> {
  if (!(await deps.gatewayLive())) return;
  deps.log(
    `${c.yellow}⚠${c.reset} A gateway is running the old version. Restart it (e.g. ${c.cyan}systemctl --user restart ethos-gateway${c.reset}) to run the new one.`,
  );
}

// ---------------------------------------------------------------------------
// Production seams
// ---------------------------------------------------------------------------

function defaultDeps(): UpgradeDeps {
  return {
    installMethod: detectInstallMethod(),
    currentVersion: CURRENT_VERSION,
    currentEntry: process.argv[1] ?? '',
    resolveVersion: fetchVersion,
    runEthos: (entry, args) => runChild(process.execPath, [entry, ...args]),
    npmInstall: (spec) =>
      new Promise((resolve) => {
        const child = spawn('npm', ['install', '-g', spec], { stdio: 'inherit' });
        child.on('exit', (code) => resolve(code ?? 1));
        child.on('error', () => resolve(1));
      }),
    npmRootGlobal: async () => {
      const run = await runChild('npm', ['root', '-g']);
      const root = run.stdout.trim();
      if (run.spawnError || run.code !== 0 || !root) {
        throw new EthosError({
          code: 'INTERNAL',
          cause: run.spawnError ?? `npm root -g exited ${run.code}`,
          action: 'Check that npm is on PATH and `npm root -g` prints a directory.',
        });
      }
      return root;
    },
    readFile: (path) => readFile(path, 'utf-8'),
    gatewayLive: async () => {
      const { readGatewayStatus } = await import('./gateway-status');
      const { state } = await readGatewayStatus();
      return state === 'running' || state === 'unhealthy';
    },
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  };
}

function runChild(command: string, args: string[]): Promise<ChildResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const done = (r: ChildResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ spawnError: `timed out after ${CHILD_TIMEOUT_MS / 1000}s`, stdout, code: null });
    }, CHILD_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      done({ spawnError: err.message, stdout, code: null });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      done(
        signal && code === null
          ? { spawnError: `killed by ${signal}`, stdout, code }
          : { stdout, code },
      );
    });
  });
}

// ---------------------------------------------------------------------------
// Install method detection
// ---------------------------------------------------------------------------

/**
 * Inspect `process.argv[1]` to figure out whether the cli was launched from a
 * global npm install (path contains `/node_modules/@ethosagent/cli/`) or from
 * a source-tree dev run (everything else — typically `tsx apps/ethos/src/index.ts`
 * or a local worktree build).
 */
function detectInstallMethod(): InstallMethod {
  const path = process.argv[1] ?? '';
  // npm-global installs always land under .../node_modules/@ethosagent/cli/...
  // (matches macOS /usr/local, nvm $NVM_DIR/versions/node/.../, $HOME/.npm-global,
  // and Linux distro-managed prefixes alike).
  if (path.includes('/node_modules/@ethosagent/cli/')) return 'npm';
  return 'source';
}

function printSourceInstructions(log: (line: string) => void): void {
  log(
    `${c.yellow}⚠${c.reset} This binary is running from source ${c.dim}(${process.argv[1] ?? 'unknown path'})${c.reset}.`,
  );
  log('');
  log(`${c.bold}To upgrade your source checkout:${c.reset}`);
  log(`  ${c.cyan}git pull${c.reset}`);
  log(`  ${c.cyan}pnpm install${c.reset}`);
  log(`  ${c.cyan}pnpm build${c.reset}`);
  log('');
  log(`${c.bold}Or install the published cli globally:${c.reset}`);
  log(`  ${c.cyan}npm install -g ${PACKAGE}@latest${c.reset}`);
  log('');
}

// ---------------------------------------------------------------------------
// npm registry
// ---------------------------------------------------------------------------

/** The registry npm itself would use: `npm_config_registry` (set by npm for
 *  scripts, or exported by the operator), else the public registry. */
export function registryUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.npm_config_registry?.trim();
  return (configured || DEFAULT_REGISTRY).replace(/\/+$/, '');
}

interface RegistryResponse {
  version?: string;
  [key: string]: unknown;
}

/** The changelog entry for `version`, e.g. `…/changelog#v0-7-3`. */
export function changelogUrl(version: string): string {
  return `${CHANGELOG_URL}#v${version.replace(/[^0-9A-Za-z]+/g, '-')}`;
}

async function fetchVersion(spec: string): Promise<string> {
  // Hit the registry's <pkg>/<version-or-tag> endpoint — returns that one
  // version's manifest without pulling the full package metadata blob.
  const url = `${registryUrl()}/${PACKAGE}/${encodeURIComponent(spec)}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    // Don't sit on a slow registry forever. 10s is generous.
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new EthosError({
      code: 'REGISTRY_FETCH_FAILED',
      cause: `registry returned ${res.status} ${res.statusText}`,
      action: `Check that ${spec} is a published version or dist-tag of ${PACKAGE}, or install manually: npm install -g ${PACKAGE}@${spec}`,
    });
  }
  const body = (await res.json()) as RegistryResponse;
  if (!body.version || typeof body.version !== 'string') {
    throw new EthosError({
      code: 'REGISTRY_FETCH_FAILED',
      cause: "registry response missing 'version' field",
      action: `Try again later, or install manually: npm install -g ${PACKAGE}@latest`,
    });
  }
  return body.version;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
