// `ethos run-all` — child-process supervisor.
//
// One command to bring the gateway (Telegram + Slack + Discord + Email) and
// `serve --web-experimental` (web dashboard + ACP) up together. Each child is
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
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { ethosDir } from '../config';

// Tuning constants. Exported via `__testing__` so unit tests can assert on
// them without re-deriving the values.
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const STABLE_THRESHOLD_MS = 60_000;
const MAX_RESTARTS_IN_WINDOW = 10;
const RESTART_WINDOW_MS = 5 * 60_000;
const SHUTDOWN_GRACE_MS = 5_000;

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
}

export function defaultChildSpecs(): ChildSpec[] {
  return [
    { name: 'gateway', args: ['gateway', 'start'] },
    { name: 'serve', args: ['serve', '--web-experimental'] },
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

interface SupervisedChild {
  spec: ChildSpec;
  process: ChildProcess | null;
  restarts: number[]; // timestamps in this window
  backoffMs: number;
  shuttingDown: boolean;
  stableTimer: NodeJS.Timeout | null;
  logStream: WriteStream | null;
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

  const children: SupervisedChild[] = (opts.children ?? defaultChildSpecs()).map((spec) => ({
    spec,
    process: null,
    restarts: [],
    backoffMs: INITIAL_BACKOFF_MS,
    shuttingDown: false,
    stableTimer: null,
    logStream: null,
  }));

  log.log(`${c.bold}ethos run-all${c.reset} ${c.dim}— ${children.length} children${c.reset}`);

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.log(`\n${c.dim}run-all: ${signal} received, stopping children…${c.reset}`);
    for (const sc of children) {
      sc.shuttingDown = true;
      if (sc.stableTimer) clearTimeout(sc.stableTimer);
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
    startChild(sc, entryPoint, logsDir, spawn, log);
  }

  // Keep the event loop alive; signals and child exits drive everything.
  await new Promise<void>(() => {});
}

function startChild(
  sc: SupervisedChild,
  entryPoint: string,
  logsDir: string,
  spawn: typeof nodeSpawn,
  log: { log: (msg: string) => void; error: (msg: string) => void },
): void {
  if (sc.shuttingDown) return;

  const logPath = join(logsDir, `${sc.spec.name}.log`);
  const logStream = createWriteStream(logPath, { flags: 'a' });
  sc.logStream = logStream;

  const launchArgs = buildChildLaunchArgs(entryPoint, sc.spec.args);
  const child = spawn(process.execPath, launchArgs, {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);

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
    setTimeout(() => startChild(sc, entryPoint, logsDir, spawn, log), delay).unref();
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
};
