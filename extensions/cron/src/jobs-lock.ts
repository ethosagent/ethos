// Cross-process lock around the read-modify-write of `<cronDir>/jobs.json`.
//
// Raw `node:fs` on purpose: an atomic create-if-absent (`wx`) has no
// equivalent in the Storage contract — `exists()` then `write()` is the race
// the lock closes. jobs.json itself still goes through Storage.
//
// THE DEFECT THIS REPLACES. The previous lock was an EMPTY `wx` file with no
// holder identity and no stale rule: a process killed between the create and
// the `unlink` in its `finally` left `jobs.json.lock` behind for ever, and every
// later `cron` create/update/delete — in every process — waited 5s and failed
// with `Could not acquire lock`. Nothing reclaimed it; an operator had to find
// and delete the file.
//
// The lock now records who holds it (pid, boot, a random token) and a waiter
// reclaims it when it can PROVE the holder is gone:
//   - the recorded pid is not running, or belongs to an earlier boot (Linux
//     only — see `currentBootId`);
//   - the body names no pid (a lock left by the previous release, or a holder
//     killed between create and write) and the file is older than
//     `unreadableStaleMs`. The critical section is a JSON read-modify-write of
//     a few KB, so any such lock older than that is not being worked on.
// A lock naming a LIVE pid is never reclaimed by age: preempting a working
// holder puts two writers on jobs.json, which is the failure the lock exists to
// prevent. The same rule, and the same reasoning, as
// `extensions/gateway/src/channel-digest-lock.ts` and
// `packages/wiring/src/backup/sentinel-lock.ts` (not importable from here —
// `packages/wiring` sits above `extensions/` in the layer model).

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { open, readFile, stat, unlink } from 'node:fs/promises';
import { platform } from 'node:os';

export interface JobsLockOptions {
  /** Total wait before giving up. Default 5s. */
  timeoutMs?: number;
  /** Poll interval while a live holder has it. Default 100ms. */
  pollMs?: number;
  /** Age after which a lock with no readable pid is stale. Default 30s. */
  unreadableStaleMs?: number;
  /** Injectable liveness probe (tests). Default `process.kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean;
}

interface Holder {
  pid: number;
  boot: string | null;
}

let cachedBootId: string | null | undefined;

/**
 * An exact identifier for this boot, or `null` where none can be trusted. A
 * copy of `currentBootId` in `extensions/gateway/src/channel-digest-lock.ts`:
 * only Linux's kernel boot id counts; wall-clock derivations elsewhere could
 * make two processes of the SAME boot preempt each other, so `null` there, and
 * `null` never proves a different boot.
 */
export function currentBootId(): string | null {
  if (cachedBootId === undefined) {
    cachedBootId = null;
    if (platform() === 'linux') {
      try {
        const id = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
        cachedBootId = id === '' ? null : `boot-id:${id}`;
      } catch {
        /* no /proc — degrade to "cannot prove" */
      }
    }
  }
  return cachedBootId;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the pid exists but belongs to another user — alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readHolder(body: string): Holder | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null || !('pid' in parsed)) return null;
    const pid: unknown = parsed.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
    const boot: unknown = 'boot' in parsed ? parsed.boot : null;
    return { pid, boot: typeof boot === 'string' ? boot : null };
  } catch {
    return null;
  }
}

async function readBody(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

/** Why the current lock is stale, or `null` when a waiter must keep waiting. */
async function staleReason(
  path: string,
  body: string,
  opts: Required<Pick<JobsLockOptions, 'unreadableStaleMs' | 'isAlive'>>,
): Promise<string | null> {
  const holder = readHolder(body);
  if (holder) {
    const current = currentBootId();
    if (holder.boot !== null && current !== null && holder.boot !== current) {
      return `holder pid ${holder.pid} belongs to an earlier boot`;
    }
    return opts.isAlive(holder.pid) ? null : `holder pid ${holder.pid} is not running`;
  }
  let ageMs: number;
  try {
    ageMs = Date.now() - (await stat(path)).mtimeMs;
  } catch {
    return null; // gone already — the next create attempt decides
  }
  return ageMs > opts.unreadableStaleMs
    ? `lock names no holder and is ${Math.round(ageMs / 1000)}s old`
    : null;
}

/**
 * Run `fn` holding `lockPath`. Throws `Could not acquire lock: <path> …` after
 * `timeoutMs` when a live holder keeps it; the message names the holder.
 */
export async function withJobsFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: JobsLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const pollMs = options.pollMs ?? 100;
  const stale = {
    unreadableStaleMs: options.unreadableStaleMs ?? 30_000,
    isAlive: options.isAlive ?? defaultIsAlive,
  };
  const body = JSON.stringify({
    pid: process.pid,
    boot: currentBootId(),
    token: randomUUID(),
    acquiredAt: new Date().toISOString(),
  });
  const start = Date.now();
  let lastSeen = '';

  for (;;) {
    try {
      const fd = await open(lockPath, 'wx'); // exclusive create — atomic
      try {
        await fd.writeFile(body, 'utf-8');
      } finally {
        await fd.close();
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const seen = await readBody(lockPath);
    if (seen !== null) {
      lastSeen = seen;
      if ((await staleReason(lockPath, seen, stale)) !== null) {
        // Remove it only if it is still the lock we judged: a peer may have
        // reclaimed it and taken a fresh one in between.
        if ((await readBody(lockPath)) === seen) await unlink(lockPath).catch(() => {});
        continue;
      }
    }
    if (Date.now() - start >= timeoutMs) {
      const holder = readHolder(lastSeen);
      const who = holder
        ? `held by running pid ${holder.pid}`
        : 'held with no recorded holder (not yet stale)';
      throw new Error(
        `Could not acquire lock: ${lockPath} (${who}; delete the file only if no ethos process is running)`,
      );
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  try {
    return await fn();
  } finally {
    // Delete only our own lock — never one a peer took after reclaiming ours.
    if ((await readBody(lockPath)) === body) await unlink(lockPath).catch(() => {});
  }
}
