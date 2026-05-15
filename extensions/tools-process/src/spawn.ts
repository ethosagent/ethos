import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { updateEntryIf } from './registry';

export interface SpawnResult {
  pid: number;
  stdoutLog: string;
  stderrLog: string;
}

/** Per-log-file size ceiling. At rotation a file is renamed to `.log.1`. */
export const LOG_MAX_BYTES = 10 * 1024 * 1024;
/** Rotated generations kept (.1 .. .5). Total ceiling ~50MB per stream. */
export const LOG_MAX_GENERATIONS = 5;

/**
 * Rotate a log file if it has grown past LOG_MAX_BYTES.
 *
 * IMPORTANT — only call this for a log whose owning process is NOT running.
 * Detached spawn (principle #2) means a live child holds an open fd to the
 * log inode; renaming it out from under the child would leave the child
 * writing to the renamed `.log.1` (or, after enough rotations, an unlinked
 * inode) while readers see a fresh empty `stdout.log`. We cannot rotate a
 * live detached stream without a supervising daemon, so we don't try:
 *   - `spawnDetached` rotates *before* opening fds — safe, the new child
 *     isn't writing yet, and a reused id's stale log has no live writer.
 *   - `process_list` / `process_logs` rotate only entries in a terminal
 *     state (exited / killed / orphan) — no live fd, rename is safe.
 *
 * Limitation: a long-lived running process is NOT capped at 10MB while it
 * runs; its logs are only rotated once it reaches a terminal state. This is
 * the honest tradeoff that preserves detached spawn. See the package README.
 *
 * When the file is oversized it is renamed `stdout.log` -> `stdout.log.1`,
 * shifting `.1`->`.2` ... up to LOG_MAX_GENERATIONS, dropping the oldest,
 * leaving a fresh empty file at the original path.
 */
export function rotateLogIfNeeded(logPath: string): void {
  let size: number;
  try {
    size = statSync(logPath).size;
  } catch {
    return; // file does not exist yet — nothing to rotate
  }
  if (size <= LOG_MAX_BYTES) return;

  // Every fs op below is race-tolerant: two concurrent observers
  // (e.g. parallel process_logs calls) can both reach this point, so a
  // rename/unlink whose source was already moved by the other caller is a
  // no-op, not a thrown ENOENT. Rotation is best-effort by design.
  const safe = (op: () => void): void => {
    try {
      op();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  };

  // Drop the oldest generation, then shift each generation down by one.
  safe(() => unlinkSync(`${logPath}.${LOG_MAX_GENERATIONS}`));
  for (let gen = LOG_MAX_GENERATIONS - 1; gen >= 1; gen--) {
    safe(() => renameSync(`${logPath}.${gen}`, `${logPath}.${gen + 1}`));
  }
  safe(() => renameSync(logPath, `${logPath}.1`));
  // Leave a fresh empty file at the original path so callers that only
  // observe (process_list / process_logs) don't leave the path missing.
  closeSync(openSync(logPath, 'a'));
}

export function spawnDetached(
  id: string,
  command: string,
  cwd: string,
  env: Record<string, string> | undefined,
  dataDir: string,
): SpawnResult {
  const dir = join(dataDir, 'processes', id);
  mkdirSync(dir, { recursive: true });

  const stdoutLog = join(dir, 'stdout.log');
  const stderrLog = join(dir, 'stderr.log');

  // Rotate-on-touch: a process id can be reused (or a log left oversized by a
  // prior run), so rotate before re-opening the fds for append.
  rotateLogIfNeeded(stdoutLog);
  rotateLogIfNeeded(stderrLog);

  const outFd = openSync(stdoutLog, 'a');
  const errFd = openSync(stderrLog, 'a');

  const child = spawn(command, [], {
    shell: true,
    detached: true,
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    stdio: ['ignore', outFd, errFd],
  });

  // A detached spawn can fail asynchronously (e.g. a non-existent cwd emits
  // 'error' with ENOENT instead of throwing synchronously). Without a listener
  // that 'error' event becomes an uncaught exception. The synchronous
  // `child.pid === undefined` check below already converts the failure into a
  // thrown error that process_start surfaces as SPAWN_FAILED — this listener
  // just keeps the async event from crashing the process.
  child.on('error', () => {});

  child.on('exit', (code, signal) => {
    // Killed by an external signal -> orphan; clean exit -> exited.
    const patch =
      signal !== null
        ? { status: 'orphan' as const }
        : { status: 'exited' as const, exitCode: code ?? -1 };
    // The "still running?" check must happen INSIDE the lock: process_stop can
    // set `killed` while this handler waits for the lock, and we must not
    // clobber that. updateEntryIf does the predicate-check + write atomically.
    // Swallow a failed write: a stale `running` entry is self-healing —
    // process_list's liveness check re-marks it `orphan` on the next touch.
    // No console.* in library code, and there is no observability channel here.
    updateEntryIf(dataDir, id, (e) => e.status === 'running', patch).catch(() => {});
  });

  child.unref();

  if (child.pid === undefined) {
    throw new Error('Failed to spawn process: pid is undefined');
  }

  return { pid: child.pid, stdoutLog, stderrLog };
}
