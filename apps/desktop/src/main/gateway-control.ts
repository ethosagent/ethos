import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { app } from 'electron';
import { store } from './store';

const execFileAsync = promisify(execFile);

export interface GatewayStatus {
  state: 'running' | 'stopped' | 'crashed' | 'starting';
  serviceInstalled: boolean;
  /** The lock holder's pid, when `ethos gateway status --json` answered. */
  pid?: number | null;
  /** A live gateway whose heartbeat is old: surfaced, never restarted. */
  unhealthy?: boolean;
}

/** What `startGateway` did. `attached` — a gateway was already running for
 *  this state dir, so nothing was spawned. */
export interface GatewayStartResult {
  attached: boolean;
  pid: number | null;
}

/** The shape `ethos gateway status --json` prints
 *  (apps/ethos/src/commands/gateway-status.ts). */
export interface CliGatewayStatus {
  state: 'running' | 'stale' | 'unhealthy' | 'stopped';
  pid: number | null;
}

/** `ethos gateway start` exits with this when the gateway lock is held
 *  (`GATEWAY_LOCK_EXIT_CODE`, packages/wiring/src/gateway-lock.ts). */
export const GATEWAY_LOCK_HELD_EXIT_CODE = 3;

/** Narrow the CLI's JSON without trusting it. `null` = unusable output. */
export function parseCliGatewayStatus(stdout: string): CliGatewayStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { state, pid } = parsed as { state?: unknown; pid?: unknown };
  if (state !== 'running' && state !== 'stale' && state !== 'unhealthy' && state !== 'stopped') {
    return null;
  }
  return { state, pid: typeof pid === 'number' ? pid : null };
}

/**
 * Ask the CLI (plan reach-and-containment D2-13): `ethos gateway status
 * --json`, 2s timeout. It exits 1/2 for stopped/unhealthy, which `execFile`
 * reports as an error — the JSON is still on stdout, so it is read from there.
 * `null` when the CLI is missing, hangs, or prints something unusable; callers
 * then fall back to the heartbeat file.
 */
export async function readCliGatewayStatus(): Promise<CliGatewayStatus | null> {
  try {
    const { stdout } = await execFileAsync('ethos', ['gateway', 'status', '--json'], {
      timeout: 2000,
      env: { ...process.env, ETHOS_STATE_DIR: getDataDir() },
    });
    return parseCliGatewayStatus(stdout);
  } catch (err) {
    const stdout = (err as { stdout?: unknown }).stdout;
    return typeof stdout === 'string' ? parseCliGatewayStatus(stdout) : null;
  }
}

function getDataDir(): string {
  const saved = store.get('dataDir');
  if (saved) return saved;
  return join(app.getPath('home'), '.ethos');
}

// ---------------------------------------------------------------------------
// Health file
// ---------------------------------------------------------------------------

function checkHealthFile(): 'running' | 'stopped' | 'stale' {
  const healthPath = join(getDataDir(), 'gateway-health.json');
  try {
    const raw = readFileSync(healthPath, 'utf-8');
    const health = JSON.parse(raw);
    const age = (Date.now() - new Date(health.updatedAt).getTime()) / 1000;
    return age < 30 ? 'running' : 'stale';
  } catch {
    return 'stopped';
  }
}

// ---------------------------------------------------------------------------
// macOS launchd
// ---------------------------------------------------------------------------

const LAUNCHD_LABEL = 'com.ethos.gateway';

function launchdPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

function isLaunchdInstalled(): boolean {
  return existsSync(launchdPlistPath());
}

async function launchdStatus(): Promise<'running' | 'stopped' | 'crashed'> {
  try {
    const { stdout } = await execFileAsync('launchctl', ['list', LAUNCHD_LABEL]);
    // If the command succeeds the service is loaded; check exit status field
    const exitMatch = stdout.match(/"LastExitStatus"\s*=\s*(\d+)/);
    if (exitMatch && exitMatch[1] !== '0') return 'crashed';
    return 'running';
  } catch {
    return 'stopped';
  }
}

async function launchdStart(): Promise<void> {
  const plist = launchdPlistPath();
  try {
    const uid = process.getuid?.() ?? 501;
    await execFileAsync('launchctl', ['bootstrap', `gui/${uid}`, plist]);
  } catch {
    // Fallback for older macOS
    await execFileAsync('launchctl', ['load', '-w', plist]);
  }
}

async function launchdStop(): Promise<void> {
  const plist = launchdPlistPath();
  try {
    const uid = process.getuid?.() ?? 501;
    await execFileAsync('launchctl', ['bootout', `gui/${uid}`, plist]);
  } catch {
    await execFileAsync('launchctl', ['unload', plist]);
  }
}

// ---------------------------------------------------------------------------
// Linux systemd
// ---------------------------------------------------------------------------

const SYSTEMD_UNIT = 'ethos-gateway';

async function isSystemdInstalled(): Promise<boolean> {
  try {
    await execFileAsync('systemctl', ['--user', 'is-enabled', SYSTEMD_UNIT]);
    return true;
  } catch {
    return false;
  }
}

async function systemdStatus(): Promise<'running' | 'stopped' | 'crashed'> {
  try {
    const { stdout } = await execFileAsync('systemctl', ['--user', 'is-active', SYSTEMD_UNIT]);
    const state = stdout.trim();
    if (state === 'active') return 'running';
    if (state === 'failed') return 'crashed';
    return 'stopped';
  } catch {
    return 'stopped';
  }
}

async function systemdStart(): Promise<void> {
  await execFileAsync('systemctl', ['--user', 'start', SYSTEMD_UNIT]);
}

async function systemdStop(): Promise<void> {
  await execFileAsync('systemctl', ['--user', 'stop', SYSTEMD_UNIT]);
}

// ---------------------------------------------------------------------------
// Detached child process fallback
// ---------------------------------------------------------------------------

/**
 * Spawn `ethos gateway start` detached. Resolves with the child's exit code if
 * it exits within `watchMs` (a refusal exits at once), else `null` — still
 * running, which is what a successful start looks like.
 */
function spawnDetachedGateway(watchMs = 3000): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn('ethos', ['gateway', 'start'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ETHOS_STATE_DIR: getDataDir() },
    });
    const timer = setTimeout(() => resolve(null), watchMs);
    timer.unref?.();
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.unref();
  });
}

export interface StartGatewayDeps {
  cliStatus: () => Promise<CliGatewayStatus | null>;
  /** Start through the OS service when one is installed; `true` if it did. */
  startService: () => Promise<boolean>;
  spawnDetached: () => Promise<number | null>;
}

/**
 * Attach-or-start (D2-13), separated from the OS calls so it is testable.
 *
 * 1. A gateway already `running` or `unhealthy` for this state dir → attach,
 *    spawn nothing. `unhealthy` is surfaced, not restarted: a second start
 *    would be refused by the gateway lock anyway, and killing a live process
 *    is the operator's call.
 * 2. Otherwise start through the OS service if installed, else spawn.
 * 3. A spawn that exits 3 lost the race between the status read and the
 *    spawn — another gateway took the lock first — so it is an attach too.
 */
export async function startGatewayWith(deps: StartGatewayDeps): Promise<GatewayStartResult> {
  const before = await deps.cliStatus();
  if (before && (before.state === 'running' || before.state === 'unhealthy')) {
    return { attached: true, pid: before.pid };
  }
  if (await deps.startService()) return { attached: false, pid: null };
  const code = await deps.spawnDetached();
  if (code === GATEWAY_LOCK_HELD_EXIT_CODE) {
    const after = await deps.cliStatus();
    return { attached: true, pid: after?.pid ?? null };
  }
  return { attached: false, pid: null };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Map the CLI's four states onto the desktop's. */
export function statusFromCli(cli: CliGatewayStatus, serviceInstalled: boolean): GatewayStatus {
  const state =
    cli.state === 'running' || cli.state === 'unhealthy'
      ? 'running'
      : cli.state === 'stale'
        ? 'crashed'
        : 'stopped';
  return {
    state,
    serviceInstalled,
    pid: cli.pid,
    ...(cli.state === 'unhealthy' ? { unhealthy: true } : {}),
  };
}

export async function getGatewayStatus(): Promise<GatewayStatus> {
  const platform = process.platform;

  // The CLI reads the gateway lock AND the heartbeat, so it knows "is there
  // one" as well as "is it healthy". The OS-service and heartbeat reads below
  // remain as the fallback for when the CLI call fails.
  const cli = await readCliGatewayStatus();
  if (cli) {
    const serviceInstalled =
      (platform === 'darwin' && isLaunchdInstalled()) ||
      (platform === 'linux' && (await isSystemdInstalled()));
    return statusFromCli(cli, serviceInstalled);
  }

  if (platform === 'darwin' && isLaunchdInstalled()) {
    const svcState = await launchdStatus();
    // Cross-check with health file for more accurate status
    const health = checkHealthFile();
    const state = health === 'running' ? 'running' : svcState;
    return { state, serviceInstalled: true };
  }

  if (platform === 'linux' && (await isSystemdInstalled())) {
    const svcState = await systemdStatus();
    const health = checkHealthFile();
    const state = health === 'running' ? 'running' : svcState;
    return { state, serviceInstalled: true };
  }

  // No OS service — rely solely on health file
  const health = checkHealthFile();
  const state = health === 'stale' ? 'crashed' : health;
  return { state, serviceInstalled: false };
}

export async function startGateway(): Promise<GatewayStartResult> {
  const platform = process.platform;
  return startGatewayWith({
    cliStatus: readCliGatewayStatus,
    startService: async () => {
      if (platform === 'darwin' && isLaunchdInstalled()) {
        await launchdStart();
        return true;
      }
      if (platform === 'linux' && (await isSystemdInstalled())) {
        await systemdStart();
        return true;
      }
      return false;
    },
    // Fallback: detached child process
    spawnDetached: () => spawnDetachedGateway(),
  });
}

export async function stopGateway(): Promise<void> {
  const platform = process.platform;

  if (platform === 'darwin' && isLaunchdInstalled()) {
    await launchdStop();
    return;
  }

  if (platform === 'linux' && (await isSystemdInstalled())) {
    await systemdStop();
    return;
  }

  // No OS service and no PID tracking — nothing to stop
}

export function getGatewayLogPath(): string {
  return join(getDataDir(), 'logs', 'gateway.log');
}
