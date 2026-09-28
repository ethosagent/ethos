// Is the process wearing a registry entry's pid still the one we started?
//
// Registry entries (./registry.ts) persist across host restarts and reboots,
// and `process.kill(pid, 0)` answers only "is SOME process wearing this
// number". Once `process_stop` signals the pid's whole process GROUP (UBP-041),
// a reused pid would take an unrelated process and its children down with it
// (V-ES-5). So `spawnDetached` records the process's identity at spawn and
// `stopProcess` (./operations.ts) refuses to signal when it no longer matches.
//
// The start time is a per-process field the kernel stores at fork, not a clock
// reading taken now, so two reads for one process agree across clock changes:
// - Linux: `starttime` from `/proc/<pid>/stat` (clock ticks since boot), plus
//   `/proc/sys/kernel/random/boot_id`, because ticks-since-boot repeat across
//   boots.
// - macOS: `ps -o lstart=` (the recorded start time, second resolution).
// - Elsewhere: no identity, and `stopProcess` falls back to signalling the pid
//   alone, which is what it did before process groups.
//
// `currentBootId` is COPIED from packages/wiring/src/backup/holder-identity.ts
// (extensions cannot import packages/wiring, ARCHITECTURE.md §II), as
// extensions/gateway/src/channel-digest-lock.ts already copies it. Raw
// `node:fs`/`execFileSync` here read system paths and a system binary, never
// `~/.ethos/`. Pinned by 'stopProcess after pid reuse (V-ES-5)' in
// __tests__/operations.test.ts.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export interface ProcessIdentity {
  /** The process's start time as the kernel recorded it; absent where unknown. */
  pidStartToken?: string;
  /** The boot the pid belongs to (Linux only). */
  bootId?: string;
}

/** The start-time token of `pid`, or null when it is gone or this platform has none. */
export function processStartToken(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // Fields after `(comm)` start at field 3; `starttime` is field 22.
      const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      return start ? `linux:${start}` : null;
    } catch {
      return null;
    }
  }
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 2_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return out ? `darwin:${out}` : null;
    } catch {
      // ps exits 1 when no such pid exists.
      return null;
    }
  }
  return null;
}

/** The kernel's per-boot UUID on Linux; null elsewhere (see holder-identity.ts for why). */
export function currentBootId(): string | null {
  if (process.platform !== 'linux') return null;
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** The identity to record for a freshly spawned `pid`. */
export function identityOf(pid: number): ProcessIdentity {
  const token = processStartToken(pid);
  const boot = currentBootId();
  return { ...(token ? { pidStartToken: token } : {}), ...(boot ? { bootId: boot } : {}) };
}

/**
 * Whether `pid` is still the process `recorded` describes. `'unknown'` when
 * nothing was recorded (an entry from before identities, or a platform with
 * none) — the caller must not widen its signal to the group on that answer.
 */
export function matchesIdentity(
  pid: number,
  recorded: ProcessIdentity,
): 'same' | 'different' | 'unknown' {
  if (recorded.bootId !== undefined) {
    const boot = currentBootId();
    if (boot !== null && boot !== recorded.bootId) return 'different';
  }
  if (recorded.pidStartToken === undefined) return 'unknown';
  return processStartToken(pid) === recorded.pidStartToken ? 'same' : 'different';
}
