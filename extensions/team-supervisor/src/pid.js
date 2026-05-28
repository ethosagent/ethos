import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { noopLogger } from '@ethosagent/logger';

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process (dead). EPERM = alive but not ours.
    return err.code === 'EPERM';
  }
}
/**
 * Acquire the PID file for a named team (CC-3).
 *
 * - Creates `pidPath` exclusively (atomic `O_CREAT | O_EXCL`).
 * - If the file exists and the stored PID is alive, throws with the
 *   "already running" message required by the CC-3 spec.
 * - If the file exists but the PID is dead (stale crash), logs and retakes.
 *
 * Returns a cleanup function that removes the PID file on exit.
 */
export function acquirePidFile(pidPath, opts = {}) {
  const logger = opts.logger ?? noopLogger;
  mkdirSync(dirname(pidPath), { recursive: true });
  const tryCreate = () => {
    try {
      // O_CREAT | O_EXCL | O_WRONLY — atomic, fails with EEXIST if file exists
      const fd = openSync(pidPath, 'wx');
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      return false;
    }
  };
  if (!tryCreate()) {
    // File already exists — check liveness.
    let existingPid = null;
    try {
      const src = readFileSync(pidPath, 'utf-8').trim();
      existingPid = Number(src) || null;
    } catch {
      /* unreadable — treat as stale */
    }
    if (existingPid !== null && isProcessAlive(existingPid)) {
      throw new Error(
        `Team already running (PID ${existingPid}). ` +
          "Use 'ethos team status <name>' for details.",
      );
    }
    // Stale PID file from a previous crash — clean up and take the lock.
    logger.warn(
      `[team-supervisor] Cleaning up stale PID file from previous crash (PID ${existingPid ?? 'unknown'})`,
      { component: 'team-supervisor', staleEntryPid: existingPid ?? 'unknown' },
    );
    try {
      unlinkSync(pidPath);
    } catch {
      /* ignore */
    }
    if (!tryCreate()) {
      throw new Error(`Could not acquire PID file at ${pidPath} after stale cleanup`);
    }
  }
  return () => {
    try {
      unlinkSync(pidPath);
    } catch {
      /* ignore */
    }
  };
}
