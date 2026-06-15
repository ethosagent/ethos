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

function spawnDetachedGateway(): void {
  const child = spawn('ethos', ['gateway', 'start'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getGatewayStatus(): Promise<GatewayStatus> {
  const platform = process.platform;

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

export async function startGateway(): Promise<void> {
  const platform = process.platform;

  if (platform === 'darwin' && isLaunchdInstalled()) {
    await launchdStart();
    return;
  }

  if (platform === 'linux' && (await isSystemdInstalled())) {
    await systemdStart();
    return;
  }

  // Fallback: detached child process
  spawnDetachedGateway();
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
