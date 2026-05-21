// `ethos run-all` — child-process supervisor.
//
// One command to bring the gateway (Telegram + Slack + Discord + Email) and
// `serve` (web dashboard + ACP) up together. Each child is
// a real subprocess: a crash in one doesn't take the other down, and the
// supervisor restarts a crashed child with exponential backoff. SIGINT and
// SIGTERM are forwarded to children before this process exits.
//
// Reboot survival is NOT in scope here — that's PM2 / systemd / launchd
// wrapping this command. `ethos run-all` makes the "one command to start
// everything" experience real; the OS service manager makes it survive
// reboots. The recommended pattern in docs/content/using/how-to/deploy-in-production.md
// is `pm2 start "ethos run-all" --name ethos`.

import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { createWriteStream, mkdirSync, statSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { ethosDir } from '../config';
import { type LogRotationConfig, rotateIfNeeded } from '../error-log';
import { createHealthServer } from '../health-server';
import { emitReady } from '../logger';
import { notifyReady, startWatchdog } from '../sd-notify';

// Tuning constants. Exported via `__testing__` so unit tests can assert on
// them without re-deriving the values.
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const STABLE_THRESHOLD_MS = 60_000;
const MAX_RESTARTS_IN_WINDOW = 10;
const RESTART_WINDOW_MS = 5 * 60_000;
const SHUTDOWN_GRACE_MS = 5_000;
const LOG_ROTATION_INTERVAL_MS = 60_000;

const DEFAULT_LOG_ROTATION: LogRotationConfig = {
  maxBytes: 10 * 1024 * 1024,
  maxFiles: 5,
  enabled: true,
};

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};

export interface ChildSpec {
  /** Stable label used for the log filename and console output. */
  name: string;
  /** argv tail handed to the ethos binary — e.g. `['gateway', 'start']`. */
  args: string[];
}

export interface RunAllOptions {
  /** Override the default child specs (gateway + serve). Tests use this. */
  children?: ChildSpec[];
  /** Override the ethos entry point. Defaults to `process.argv[1]`. */
  entryPoint?: string;
  /** Override the logs directory. Defaults to `~/.ethos/logs`. */
  logsDir?: string;
  /** Injectable spawn for tests. Defaults to `child_process.spawn`. */
  spawn?: typeof nodeSpawn;
  /** Injectable logger. Defaults to `console`. Tests pass a recorder. */
  logger?: {
    log: (msg: string) => void;
    error: (msg: string) => void;
  };
  /** Log rotation config for child log files. Defaults to 10 MiB / 5 backups. */
  rotation?: LogRotationConfig;
}

export function defaultChildSpecs(): ChildSpec[] {
  return [
    { name: 'gateway', args: ['gateway', 'start'] },
    { name: 'serve', args: ['serve'] },
  ];
}

// Pure: build the argv used to spawn one child. Mirrors `buildSupervisorLaunchArgs`
// in team.ts — running off a `.ts` source needs the `tsx` loader, running off
// the bundled `.js` binary doesn't.
export function buildChildLaunchArgs(entryPoint: string, childArgs: string[]): string[] {
  const needsTsxLoader = entryPoint.endsWith('.ts') || entryPoint.endsWith('.tsx');
  return needsTsxLoader
    ? ['--import', 'tsx', entryPoint, ...childArgs]
    : [entryPoint, ...childArgs];
}

// Pure: next backoff in the doubling 1s → 30s sequence.
export function nextBackoff(currentMs: number): number {
  return Math.min(currentMs * 2, MAX_BACKOFF_MS);
}

// Pure: prune restart timestamps older than the window. Used to bound the
// "have we crashed too many times recently?" check to a sliding window.
export function pruneRestarts(timestamps: number[], now: number, windowMs: number): number[] {
  return timestamps.filter((t) => now - t < windowMs);
}

// Pure: returns true when a chunk line contains a valid ethos.ready event.
export function isReadyLine(line: string): boolean {
  return line.includes('"event":"ethos.ready"');
}

// Pure factory: builds the aggregate-ready tracking callback used by runAll.
// Exported so unit tests can exercise the "emit exactly once" invariant
// without spawning real children.
export function createReadyTracker(
  childNames: Set<string>,
  onAllReady: () => void,
): (name: string) => void {
  const readyChildren = new Set<string>();
  let emitted = false;
  return (name: string): void => {
    readyChildren.add(name);
    if (!emitted && readyChildren.size === childNames.size) {
      onAllReady();
      emitted = true;
    }
  };
}

interface SupervisedChild {
  spec: ChildSpec;
  process: ChildProcess | null;
  restarts: number[]; // timestamps in this window
  backoffMs: number;
  shuttingDown: boolean;
  stableTimer: NodeJS.Timeout | null;
  logStream: WriteStream | null;
  rotationTimer: NodeJS.Timeout | null;
}

export async function runAll(opts: RunAllOptions = {}): Promise<void> {
  const entryPoint = opts.entryPoint ?? process.argv[1];
  if (!entryPoint) {
    (opts.logger ?? console).error(
      'run-all: cannot determine ethos entry point — process.argv[1] is empty.',
    );
    process.exit(1);
  }

  const logsDir = opts.logsDir ?? join(ethosDir(), 'logs');
  mkdirSync(logsDir, { recursive: true });

  const spawn = opts.spawn ?? nodeSpawn;
  const log = opts.logger ?? console;
  const rotation = opts.rotation ?? DEFAULT_LOG_ROTATION;

  const children: SupervisedChild[] = (opts.children ?? defaultChildSpecs()).map((spec) => ({
    spec,
    process: null,
    restarts: [],
    backoffMs: INITIAL_BACKOFF_MS,
    shuttingDown: false,
    stableTimer: null,
    logStream: null,
    rotationTimer: null,
  }));

  log.log(`${c.bold}ethos run-all${c.reset} ${c.dim}— ${children.length} children${c.reset}`);

  // Aggregate ready tracking: emit ethos.ready for run-all exactly once,
  // after every child has signalled ready on its own stderr.
  const childNames = new Set(children.map((sc) => sc.spec.name));
  let stopWatchdog: (() => void) | null = null;
  const onChildReady = createReadyTracker(childNames, () => {
    emitReady('run-all');
    notifyReady();
    stopWatchdog = startWatchdog();
  });

  let healthServer: import('node:http').Server | null = null;
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (stopWatchdog) stopWatchdog();
    if (healthServer) healthServer.close();
    log.log(`\n${c.dim}run-all: ${signal} received, stopping children…${c.reset}`);
    for (const sc of children) {
      sc.shuttingDown = true;
      if (sc.stableTimer) clearTimeout(sc.stableTimer);
      if (sc.rotationTimer) clearInterval(sc.rotationTimer);
      const child = sc.process;
      if (child?.pid && !child.killed) {
        try {
          child.kill('SIGTERM');
        } catch {
          /* already gone */
        }
      }
    }
    setTimeout(() => {
      for (const sc of children) {
        const child = sc.process;
        if (child?.pid && !child.killed) {
          try {
            child.kill('SIGKILL');
          } catch {
            /* gone */
          }
        }
      }
      process.exit(0);
    }, SHUTDOWN_GRACE_MS).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  for (const sc of children) {
    startChild(sc, entryPoint, logsDir, spawn, log, onChildReady, rotation);
  }

  const healthPort = Number(process.env.ETHOS_RUNALL_HEALTH_PORT) || 3003;
  const healthHost = process.env.ETHOS_SERVE_HOST ?? '127.0.0.1';
  healthServer = createHealthServer(healthPort, healthHost, () => {
    const childStatuses = children.map((child) => ({
      name: child.spec.name,
      running: child.process !== null && !child.shuttingDown,
      pid: child.process?.pid ?? null,
      restarts: child.restarts.length,
    }));
    const allRunning = childStatuses.every((s) => s.running);
    return {
      status: allRunning ? 'ok' : 'degraded',
      uptime: process.uptime(),
      children: childStatuses,
    };
  });
  log.log(`${c.dim}  health: http://${healthHost}:${healthPort}/healthz${c.reset}`);

  // Keep the event loop alive; signals and child exits drive everything.
  await new Promise<void>(() => {});
}

function startChild(
  sc: SupervisedChild,
  entryPoint: string,
  logsDir: string,
  spawn: typeof nodeSpawn,
  log: { log: (msg: string) => void; error: (msg: string) => void },
  onChildReady: (name: string) => void,
  rotation: LogRotationConfig,
): void {
  if (sc.shuttingDown) return;

  const logPath = join(logsDir, `${sc.spec.name}.log`);
  rotateIfNeeded(logPath, rotation);
  sc.logStream = createWriteStream(logPath, { flags: 'a' });

  sc.rotationTimer = setInterval(() => {
    if (!rotation.enabled) return;
    try {
      const stat = statSync(logPath);
      if (stat.size < rotation.maxBytes) return;
    } catch {
      return;
    }
    // Close current stream, rotate, open new stream
    sc.logStream?.end();
    rotateIfNeeded(logPath, rotation);
    sc.logStream = createWriteStream(logPath, { flags: 'a' });
  }, LOG_ROTATION_INTERVAL_MS);
  (sc.rotationTimer as NodeJS.Timeout).unref();

  const launchArgs = buildChildLaunchArgs(entryPoint, sc.spec.args);
  const child = spawn(process.execPath, launchArgs, {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Use data handlers instead of pipe() so that the rotation interval can
  // swap sc.logStream to a fresh WriteStream after rotating the file.
  // pipe() binds to a fixed destination — a renamed file's fd never changes.
  child.stdout?.on('data', (chunk: Buffer) => {
    sc.logStream?.write(chunk);
  });

  let stderrBuf = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    sc.logStream?.write(chunk);
    stderrBuf += chunk.toString();
    const lines = stderrBuf.split('\n');
    // Last element is either '' (if chunk ended with \n) or an incomplete line
    stderrBuf = lines.pop() ?? '';
    for (const line of lines) {
      if (isReadyLine(line)) {
        onChildReady(sc.spec.name);
        stderrBuf = ''; // no need to buffer further
        break;
      }
    }
  });

  sc.process = child;

  log.log(
    `${c.green}✓${c.reset} ${sc.spec.name.padEnd(8)} ${c.dim}pid ${child.pid} · logs: ${logPath}${c.reset}`,
  );

  // After STABLE_THRESHOLD_MS of uptime, reset backoff and clear restart
  // history. A child that ran cleanly for a minute gets a fresh restart
  // budget when it next dies.
  sc.stableTimer = setTimeout(() => {
    sc.backoffMs = INITIAL_BACKOFF_MS;
    sc.restarts = [];
  }, STABLE_THRESHOLD_MS);

  child.on('exit', (code, signal) => {
    sc.logStream?.end();
    sc.logStream = null;
    if (sc.stableTimer) {
      clearTimeout(sc.stableTimer);
      sc.stableTimer = null;
    }
    if (sc.rotationTimer) {
      clearInterval(sc.rotationTimer);
      sc.rotationTimer = null;
    }
    sc.process = null;

    if (sc.shuttingDown) return;

    const reason = signal ? `signal=${signal}` : `code=${code}`;
    log.log(`${c.yellow}✗${c.reset} ${sc.spec.name} exited (${reason})`);

    const now = Date.now();
    sc.restarts = pruneRestarts(sc.restarts, now, RESTART_WINDOW_MS);
    sc.restarts.push(now);

    if (sc.restarts.length > MAX_RESTARTS_IN_WINDOW) {
      log.error(
        `${c.red}run-all: ${sc.spec.name} crashed ${sc.restarts.length} times in ${
          RESTART_WINDOW_MS / 1000
        }s — giving up. Inspect ${logPath}.${c.reset}`,
      );
      process.exitCode = 1;
      // Leave sibling children running; the operator (or PM2/systemd) can
      // restart the whole supervisor once they've fixed the underlying issue.
      return;
    }

    const delay = sc.backoffMs;
    log.log(`${c.dim}run-all: restarting ${sc.spec.name} in ${delay}ms${c.reset}`);
    setTimeout(
      () => startChild(sc, entryPoint, logsDir, spawn, log, onChildReady, rotation),
      delay,
    ).unref();
    sc.backoffMs = nextBackoff(sc.backoffMs);
  });

  child.on('error', (err) => {
    log.error(`${c.red}run-all: failed to spawn ${sc.spec.name}: ${err.message}${c.reset}`);
  });
}

// Test surface: tuning constants + pure helpers + the default specs.
export const __testing__ = {
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
  STABLE_THRESHOLD_MS,
  MAX_RESTARTS_IN_WINDOW,
  RESTART_WINDOW_MS,
  SHUTDOWN_GRACE_MS,
  LOG_ROTATION_INTERVAL_MS,
  DEFAULT_LOG_ROTATION,
};
