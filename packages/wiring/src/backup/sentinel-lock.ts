// The advisory `wx` sentinel lock shared by this package's cross-process locks:
// `acquireBackupLock` (`backup-schedule.ts`, `backups/.lock`),
// `acquireIdentityMapLock` (`identity-map.ts`, `users/identity-map.json.lock`)
// and `acquireGatewayLock` (`gateway-lock.ts`, `gateway.lock`).
// One implementation, because two copies of a lock primitive in one package
// drift. Each caller keeps its own wait bound, poll interval, unreadable-body
// stale window and refusal text, passed in as options.
//
// NOT shared with `extensions/agent-mesh/src/index.ts` or
// `extensions/gateway/src/channel-digest-lock.ts`: those are deliberate copies,
// because `extensions/` cannot import `packages/wiring` (ARCHITECTURE.md §II).
// `backup/restore.ts`'s `.restore-in-progress` sentinel is a different protocol
// (a write-ahead journal and an mtime-only stale rule) and does not use this.
//
// Raw `node:fs` on purpose — the documented Storage carve-out (AGENTS.md). An
// atomic create-if-absent has no equivalent in the `Storage` contract: `exists()`
// then `write()` is the race this exists to close.

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { classifyHolder, currentBootId } from './holder-identity';

export interface SentinelLockOptions {
  /** The sentinel file. Its parent directory is created if missing. */
  lockPath: string;
  /**
   * How long a contended acquire keeps retrying before it throws. `0` makes
   * exactly one attempt — a stale incumbent is still reclaimed — and then
   * refuses at once.
   */
  timeoutMs: number;
  /** The poll interval while contended. */
  retryMs: number;
  /**
   * The clock fallback, used ONLY when the lock body carries no readable pid (a
   * truncated write, or a foreign file): past this age such a lock is stale. A
   * body naming a live pid from this boot is never stale at any age.
   */
  unreadableStaleMs: number;
  /**
   * The refusal message thrown when the wait runs out. `holderPid` is the pid
   * recorded in the lock at that moment, or `null` when there is none readable.
   * Each caller's text tells the operator how to clear the lock safely.
   */
  refusal: (holderPid: number | null) => string;
}

/** The lock file's exact bytes, or `null` when it is not there. */
function readLockBody(lockPath: string): string | null {
  try {
    return readFileSync(lockPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * The recorded holder, or `null` when the body carries no readable pid. `boot`
 * is null when the body does not record one — a lock written before that field
 * existed, or on a platform with no boot identity — which `classifyHolder` reads
 * as "cannot prove a different boot", so the live pid holds.
 */
function parseHolder(body: string): { pid: number; boot: string | null } | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { pid, boot } = parsed as Record<string, unknown>;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
    return { pid, boot: typeof boot === 'string' && boot !== '' ? boot : null };
  } catch {
    return null; // empty, truncated, or foreign
  }
}

/**
 * Was this lock left behind by a holder that is gone? In order:
 *
 * - a holder from another boot — abandoned, whatever its pid answers now.
 * - a pid that is gone — abandoned NOW, without waiting out a clock.
 * - a pid that is alive, from this boot — HELD, at any age. Nothing expires it;
 *   the refusal names it and says how to clear it by hand.
 * - no readable pid — the clock (`unreadableStaleMs`).
 *
 * See `holder-identity.ts` for why a pid is qualified by boot rather than capped
 * by a wall clock.
 */
function lockIsStale(lockPath: string, body: string, unreadableStaleMs: number): boolean {
  const holder = parseHolder(body);
  if (holder) return classifyHolder(holder.pid, holder.boot) !== 'live';
  try {
    return Date.now() - statSync(lockPath).mtimeMs > unreadableStaleMs;
  } catch {
    return true; // no mtime to judge by — the lock is gone or unreadable
  }
}

/** What {@link inspectSentinelLock} found at a lock path. */
export type SentinelLockInspection =
  | { holder: 'none' }
  | {
      /** `live` — a process from this boot holds it; `stale` — the next
       *  acquire will take it over (same rule `acquireSentinelLock` applies). */
      holder: 'live' | 'stale';
      /** The recorded pid, or `null` when the body carries none readable. */
      pid: number | null;
      /** The recorded `startedAt`, when present. */
      startedAt: string | null;
    };

/**
 * Read a lock WITHOUT taking it: is it held, by whom, and would the next
 * acquire take it over? Classified by the exact rule the acquire uses
 * (`lockIsStale`), so a status display and the lock can never disagree.
 * `ethos gateway status` reads `gateway.lock` through this.
 */
export function inspectSentinelLock(
  lockPath: string,
  unreadableStaleMs: number,
): SentinelLockInspection {
  const body = readLockBody(lockPath);
  if (body === null) return { holder: 'none' };
  const holder = parseHolder(body);
  let startedAt: string | null = null;
  try {
    const parsed: unknown = JSON.parse(body);
    const raw = (parsed as { startedAt?: unknown } | null)?.startedAt;
    if (typeof raw === 'string') startedAt = raw;
  } catch {
    // unreadable body — no startedAt
  }
  return {
    holder: lockIsStale(lockPath, body, unreadableStaleMs) ? 'stale' : 'live',
    pid: holder?.pid ?? null,
    startedAt,
  };
}

/**
 * Take an advisory exclusive lock; resolves to its `release`.
 *
 * The lock is OWNED, not just present: its body carries a `token` unique to the
 * acquiring call. Exactly ONE step below is atomic, and it is the only one that
 * decides anything — the `wx` create. Whoever's create returns without EEXIST
 * won; every read, compare and unlink around it is confirmation, never
 * arbitration. The protocol:
 *
 *  1. `wx` create. Succeeding means we MAY hold the lock.
 *  2. Re-read, and confirm the file still carries OUR bytes. A contender that
 *     had already classified the lock we displaced as stale can unlink ours and
 *     install its own in the gap after step 1. If it did, we do not hold the
 *     lock — so we abandon the attempt and go back to waiting rather than hand
 *     the caller a release closure for someone else's file. This is what makes
 *     "two contenders both took over the same abandoned lock" settle on one
 *     holder instead of two.
 *  3. On EEXIST, classify the incumbent. Stale (pid gone, a holder from another
 *     boot, or unreadable and past `unreadableStaleMs`) means re-read and unlink
 *     only if the bytes are still the ones we judged. That comparison makes the
 *     losing contender decline in the common case; it is NOT the guarantee.
 *     Step 2 is.
 *
 * What this does NOT do, plainly. POSIX has no atomic compare-and-delete for a
 * pathname: `unlink` names a path, not the inode that was read, so every
 * check-then-unlink here — the takeover's and `release`'s alike — leaves a
 * window in which the file can be replaced between the compare and the unlink,
 * and the unlink then removes a successor's live lock. Step 2 answers that
 * without curing it: a contender notices the loss only if its confirmation read
 * lands after the unlink that took its lock away. Should it land before, two
 * processes both believe they hold the lock. Both windows are a few
 * microseconds of adjacent synchronous syscalls, reachable only when two
 * contenders classify the SAME abandoned lock as stale inside that span.
 * Narrowed and stated, not closed.
 *
 * Comparing the open descriptor's inode against a `stat` of the path just
 * before unlinking was considered and rejected: it relocates the window rather
 * than closing it, and buys nothing the `token` does not already buy — a
 * successor's body is never byte-equal to the one we read.
 *
 * `release` keeps the same comparison, for the same reason and with the same
 * residual: a holder that was legitimately taken over must not delete its
 * successor's lock on the way out. Step 2 cannot help there — by then the
 * guarded work has already run — so declining to unlink bytes that are not ours
 * is the whole of what release can do, and it does that much.
 *
 * The token is what makes every byte comparison sound: `pid` + `startedAt`
 * alone repeat if one process re-acquires within the same millisecond.
 *
 * Sound only where it is meant to be. Holder identity is a pid and a boot, which
 * mean something only on the machine that wrote them: a directory shared by two
 * machines over a network filesystem reads the other machine's live holder as
 * gone and takes it over. A filesystem without a reliable exclusive create
 * (NFSv2) does not provide step 1 at all.
 */
export async function acquireSentinelLock(opts: SentinelLockOptions): Promise<() => void> {
  const { lockPath } = opts;
  mkdirSync(dirname(lockPath), { recursive: true });
  const body = JSON.stringify({
    token: randomUUID(),
    pid: process.pid,
    boot: currentBootId(),
    startedAt: new Date().toISOString(),
  });
  const release = (): void => {
    try {
      if (readLockBody(lockPath) === body) unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
  };
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    let created = false;
    let reclaimed = false;
    try {
      // Step 1 — the atomic one. Nothing else in this loop decides a winner.
      writeFileSync(lockPath, body, { flag: 'wx' });
      created = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Step 3 — classify the incumbent, and reclaim it only if it is stale.
      const observed = readLockBody(lockPath);
      if (observed !== null && lockIsStale(lockPath, observed, opts.unreadableStaleMs)) {
        try {
          // The lock we judged stale may already have been taken over and
          // replaced with a live one since the read above.
          if (readLockBody(lockPath) === observed) {
            unlinkSync(lockPath);
            reclaimed = true;
          }
        } catch {
          // Another contender reclaimed it first, or we may not remove it.
          // Either way fall through to the wait so this cannot spin.
        }
      }
    }
    // Step 2 — we created it, but do we still hold it? If a racing takeover
    // unlinked our lock and installed its own, the answer is no, and returning
    // `release` here would hand out a closure over that contender's file.
    if (created && readLockBody(lockPath) === body) return release;
    // A reclaim frees the path for us; retry the create at once rather than
    // sleeping out the retry interval first.
    if (reclaimed) continue;
    if (Date.now() >= deadline) {
      // Name the holder, so "is anything actually running?" is answerable by
      // the person reading this rather than a guess about a file they cannot see.
      const holder = readLockBody(lockPath);
      const pid = holder === null ? null : (parseHolder(holder)?.pid ?? null);
      throw new Error(opts.refusal(pid));
    }
    await new Promise<void>((r) => setTimeout(r, opts.retryMs));
  }
}
