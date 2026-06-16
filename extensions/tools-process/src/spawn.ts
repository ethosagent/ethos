// TODO(capability-migration): spawnDetached requires detached: true + fd-based
// stdio redirection for log files, which ctx.scopedProcess.spawn does not support
// (it collects output to memory strings). Keep node:child_process here until
// ScopedProcess gains a detached/fd mode.
import { spawn } from 'node:child_process';
// TODO(capability-migration): Log file rotation uses sync fs ops (open/close/rename/
// stat/unlink/mkdir) on the dataDir. These could migrate to ctx.scopedFs once the
// tool threads ctx through to spawnDetached, but the function is also called from
// non-tool code paths (operations.ts rotate-on-touch). Deferred.
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import type { ExecSession, ExecutionBackend, PersonalityConfig } from '@ethosagent/types';
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
  onExit?: (result: { exitCode: number | null; signal: NodeJS.Signals | null }) => void,
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
    // Gap 10 — surface the real exit to the caller (process_complete hook).
    // Fired after the registry patch is kicked off; the callback receives the
    // exit data directly so it never depends on the async registry write.
    onExit?.({ exitCode: code, signal });
  });

  child.unref();

  if (child.pid === undefined) {
    throw new Error('Failed to spawn process: pid is undefined');
  }

  return { pid: child.pid, stdoutLog, stderrLog };
}

/** Sentinel pid for backend-routed (containerized) processes — they have no
 * host pid. `isAlive(SENTINEL)` is false, so liveness for these entries is
 * driven by the registry status (flipped on stream completion), not host pid
 * polling. process_stop/process_watch special-case this pid. */
export const BACKEND_ROUTED_PID = -1;

/**
 * Live handle to a backend-routed process's session, keyed by process id. Lets
 * process_stop deliver a real signal to the in-container process and lets the
 * drain loop be unblocked. Cleared once the stream completes. In-process only —
 * a backend-routed process cannot outlive the host that spawned it (the
 * container is torn down on dispose), so cross-process recovery is N/A.
 */
const routedSessions = new Map<string, ExecSession>();

/** Resolve the live session for a backend-routed process, if still running. */
export function routedSessionFor(id: string): ExecSession | undefined {
  return routedSessions.get(id);
}

/**
 * Route a long-running process through an ExecutionBackend session (review c).
 * Streams the session's stdout/stderr into the same per-process log files that
 * `spawnDetached` writes, so process_list/process_logs keep working. Output is
 * appended as the stream yields; `onExit` fires once the stream completes.
 *
 * Lane C2: the session is registered in `routedSessions` so process_stop can
 * deliver a real signal to the in-container process via `session.stop()`, and
 * process_watch can tail the live log + observe terminal state via the
 * registry. The handle is removed once the stream ends.
 */
export function spawnViaBackend(
  id: string,
  command: string,
  cwd: string,
  env: Record<string, string> | undefined,
  dataDir: string,
  backend: ExecutionBackend,
  personality: PersonalityConfig | undefined,
  onExit?: (result: { exitCode: number | null; signal: NodeJS.Signals | null }) => void,
): SpawnResult {
  const dir = join(dataDir, 'processes', id);
  mkdirSync(dir, { recursive: true });
  const stdoutLog = join(dir, 'stdout.log');
  const stderrLog = join(dir, 'stderr.log');
  rotateLogIfNeeded(stdoutLog);
  rotateLogIfNeeded(stderrLog);

  const session = backend.spawnSession(personality?.id ?? 'unknown');
  routedSessions.set(id, session);
  // Clean env by default (review #3): only explicitly-opted vars cross in.
  const stream = session.exec(command, { cwd, env: env ?? {}, personality });

  // Drain the stream in the background, appending to the log files. A detached
  // host child is not created; the registry entry is flipped to terminal when
  // the stream ends (or errors). The exit chunk (Lane C2) carries the real exit
  // code; absent it (older backend), fall back to 0 on clean completion.
  void (async () => {
    let errored = false;
    let exitCode = 0;
    try {
      for await (const chunk of stream) {
        if (chunk.stream === 'exit') {
          exitCode = chunk.code;
          continue;
        }
        const target = chunk.stream === 'stdout' ? stdoutLog : stderrLog;
        try {
          appendFileSync(target, chunk.data);
        } catch {
          // best-effort log capture
        }
      }
    } catch {
      errored = true;
    } finally {
      routedSessions.delete(id);
      await session.dispose().catch(() => {});
      const finalExit = errored ? -1 : exitCode;
      updateEntryIf(dataDir, id, (e) => e.status === 'running', {
        status: 'exited' as const,
        exitCode: finalExit,
      }).catch(() => {});
      onExit?.({ exitCode: finalExit, signal: null });
    }
  })();

  return { pid: BACKEND_ROUTED_PID, stdoutLog, stderrLog };
}
