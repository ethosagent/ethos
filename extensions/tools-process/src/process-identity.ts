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
// - macOS: `ps -o lstart=` (the recorded start time, second resolution), run
//   as `/bin/ps` under a fixed env (`DARWIN_PS_ENV`: C locale, UTC) so the
//   spelling does not depend on the Ethos process's locale or time zone, and
//   neither the host PATH nor the process's secrets reach it (V2-SEC-3).
//   Tokens recorded before that (`darwin:` prefix) were spelled under the
//   process env of the time and are still compared that way.
// - Elsewhere: no identity, and `stopProcess` falls back to signalling the pid
//   alone, which is what it did before process groups.
//
// A read that cannot answer is NOT a different process (V3-4): a spawn error,
// a timeout, or an unreadable `/proc/<pid>/stat` is 'unknown', which liveness
// reads as alive (the entry stays tracked and keeps its PROCESS_CAP slot) and
// `stopProcess` reads as "signal the pid alone". Only `ps` exiting 1 with no
// output, or `/proc/<pid>` being missing, means the pid is gone. The read is
// async (`execFile` with a timeout), so it never blocks the event loop, and a
// verified 'same' is remembered per (pid, token) for `IDENTITY_CACHE_MS` so a
// liveness poll does not spawn `ps` every tick. Pinned by
// __tests__/identity-unknown.test.ts.
//
// `currentBootId` is COPIED from packages/wiring/src/backup/holder-identity.ts
// (extensions cannot import packages/wiring, ARCHITECTURE.md §II), as
// extensions/gateway/src/channel-digest-lock.ts already copies it. Raw
// `node:fs`/`execFile` here read system paths and a system binary, never
// `~/.ethos/`. Pinned by 'stopProcess after pid reuse (V-ES-5)' in
// __tests__/operations.test.ts.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

export interface ProcessIdentity {
  /** The process's start time as the kernel recorded it; absent where unknown. */
  pidStartToken?: string;
  /** The boot the pid belongs to (Linux only). */
  bootId?: string;
}

/** One start-time read: a token, "no such pid", or no answer (failed / timed out). */
type TokenRead = { state: 'token'; token: string } | { state: 'gone' } | { state: 'unknown' };

const UNKNOWN: TokenRead = { state: 'unknown' };
const GONE: TokenRead = { state: 'gone' };
const PS_TIMEOUT_MS = 2_000;

async function readStartToken(pid: number): Promise<TokenRead> {
  if (!Number.isInteger(pid) || pid <= 0) return GONE;
  if (process.platform === 'linux') {
    let stat: string;
    try {
      stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return code === 'ENOENT' || code === 'ESRCH' ? GONE : UNKNOWN;
    }
    // Fields after `(comm)` start at field 3; `starttime` is field 22.
    const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    return start ? { state: 'token', token: `linux:${start}` } : UNKNOWN;
  }
  if (process.platform === 'darwin') {
    const read = await darwinLstart(pid, DARWIN_PS_ENV);
    return read.state === 'token'
      ? { state: 'token', token: `${DARWIN_TOKEN}${read.token}` }
      : read;
  }
  return UNKNOWN;
}

/**
 * The start-time token of `pid`, or null when it is gone, the read could not
 * answer, or this platform has none.
 */
export async function processStartToken(pid: number): Promise<string | null> {
  const read = await readStartToken(pid);
  return read.state === 'token' ? read.token : null;
}

const DARWIN_TOKEN = 'darwin-utc:';
/** Pre-V2-SEC-3 tokens: `lstart` spelled under the Ethos process's own env. */
const LEGACY_DARWIN_TOKEN = 'darwin:';
const DARWIN_PS_ENV: NodeJS.ProcessEnv = { LC_ALL: 'C', TZ: 'UTC', PATH: '/usr/bin:/bin' };

/**
 * `lstart` of `pid` from `/bin/ps` under `env` (inherited when undefined),
 * whitespace-collapsed. `ps` exits 1 with no output when no such pid exists —
 * the only answer read as gone. A spawn error (ENOENT, EAGAIN, EMFILE), the
 * timeout, or any other exit is 'unknown'.
 */
function darwinLstart(pid: number, env: NodeJS.ProcessEnv | undefined): Promise<TokenRead> {
  return new Promise((resolve) => {
    try {
      execFile(
        '/bin/ps',
        ['-o', 'lstart=', '-p', String(pid)],
        { encoding: 'utf8', timeout: PS_TIMEOUT_MS, ...(env ? { env } : {}) },
        (err, stdout) => {
          // `lstart` pads a one-digit day with a second space; collapse runs.
          const out = String(stdout ?? '')
            .trim()
            .replace(/\s+/g, ' ');
          if (!err) resolve(out ? { state: 'token', token: out } : UNKNOWN);
          else if (err.code === 1 && !err.killed && out === '') resolve(GONE);
          else resolve(UNKNOWN);
        },
      );
    } catch {
      resolve(UNKNOWN);
    }
  });
}

/**
 * A legacy token's comparison value: `lstart` spelled the way it was recorded,
 * under the Ethos process's own locale and zone — so `/bin/ps` inherits this
 * process's env (no `env` option). Only for entries recorded before V2-SEC-3;
 * the binary is still the absolute system one.
 */
async function legacyDarwinToken(pid: number): Promise<TokenRead> {
  const read = await darwinLstart(pid, undefined);
  return read.state === 'token'
    ? { state: 'token', token: `${LEGACY_DARWIN_TOKEN}${read.token}` }
    : read;
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

/** The identity to record for a freshly spawned `pid`; no token when the read cannot answer. */
export async function identityOf(pid: number): Promise<ProcessIdentity> {
  const token = await processStartToken(pid);
  const boot = currentBootId();
  return { ...(token ? { pidStartToken: token } : {}), ...(boot ? { bootId: boot } : {}) };
}

/**
 * How long a verified 'same' is reused for a liveness check. Only a liveness
 * caller opts in (`isEntryAlive`, ./registry.ts): the worst a stale answer
 * does there is keep a just-reused pid's entry `running` for this long.
 * `stopProcess` always reads fresh, because it decides whether to signal.
 */
export const IDENTITY_CACHE_MS = 5_000;
const verified = new Map<string, number>();

/**
 * Whether `pid` is still the process `recorded` describes. `'unknown'` when
 * nothing was recorded (an entry from before identities, or a platform with
 * none) or when the read could not answer (V3-4) — the caller must not widen
 * its signal to the group, nor treat the process as gone, on that answer.
 * `'different'` when the boot changed, the pid is gone, or it now wears
 * another start time.
 */
export async function matchesIdentity(
  pid: number,
  recorded: ProcessIdentity,
  opts: { cacheMs?: number } = {},
): Promise<'same' | 'different' | 'unknown'> {
  if (recorded.bootId !== undefined) {
    const boot = currentBootId();
    if (boot !== null && boot !== recorded.bootId) return 'different';
  }
  const token = recorded.pidStartToken;
  if (token === undefined) return 'unknown';
  const key = `${pid}\0${token}`;
  const now = Date.now();
  const seen = verified.get(key);
  if (opts.cacheMs !== undefined && seen !== undefined && now - seen < opts.cacheMs) {
    return 'same';
  }
  const legacy = process.platform === 'darwin' && token.startsWith(LEGACY_DARWIN_TOKEN);
  const read = legacy ? await legacyDarwinToken(pid) : await readStartToken(pid);
  if (read.state === 'unknown') return 'unknown';
  const same =
    read.state === 'token' &&
    (legacy
      ? read.token.replace(/\s+/g, ' ') === token.replace(/\s+/g, ' ')
      : read.token === token);
  if (!same) {
    verified.delete(key);
    return 'different';
  }
  if (verified.size >= 256) {
    for (const [k, at] of verified) if (now - at >= IDENTITY_CACHE_MS) verified.delete(k);
    // Still full of fresh entries: drop the oldest (Map keeps insertion order).
    const oldest = verified.keys().next();
    if (verified.size >= 256 && !oldest.done) verified.delete(oldest.value);
  }
  verified.delete(key);
  verified.set(key, now);
  return 'same';
}
