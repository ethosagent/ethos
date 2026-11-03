// Best-effort naming of the processes that have `sessions.db` open.
//
// SQLite cannot report the pid holding a lock, so this tries, in order:
//   1. `gateway.lock` (live holders only; a stale lock is not named)
//   2. `gateway-health.json` heartbeat (pid + age), when its pid is alive
//   3. `lsof -nP -F pcn -- sessions.db sessions.db-wal sessions.db-shm`
// and returns what it found, or `[]` (the caller supplies generic text).
//
// Source 3 lists processes with the file OPEN, a superset of "holds the lock", so
// its entries are labelled "processes with sessions.db open" and never claim lock
// ownership. Never throws. Results are cached for 30 s per data dir and concurrent
// callers share one probe. Pinned by __tests__/holders.test.ts.
//
// Raw `node:fs/promises` (`readFile`) and `process.kill(pid, 0)` are the documented
// packages/wiring carve-out: the heartbeat is read by explicit `dataDir`, which the
// Storage-backed readers (they resolve `~/.ethos` themselves) cannot take.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { classifyHolder } from '../backup/holder-identity';
import { inspectGatewayLock } from '../gateway-lock';

export type ExecFn = (
  file: string,
  args: string[],
  opts: { timeout: number; cwd: string },
) => Promise<{ stdout: string }>;

export interface HolderDeps {
  /** Runs `lsof`. Defaults to `execFile`. A non-zero exit may carry partial `stdout`. */
  exec?: ExecFn;
  now?: () => number;
  /** Our own pid, dropped from lsof output. Defaults to `process.pid`. */
  selfPid?: number;
  /** Liveness test for a heartbeat pid. Defaults to `process.kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean;
}

const CACHE_TTL_MS = 30_000;
const LSOF_TIMEOUT_MS = 1_500;
/** A heartbeat older than this is not evidence of a running gateway. */
const HEARTBEAT_FRESH_MS = 60_000;

interface CacheEntry {
  at: number;
  value: Promise<string[]>;
}
const cache = new Map<string, CacheEntry>();

const defaultExec: ExecFn = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: opts.timeout, cwd: opts.cwd }, (err, stdout) => {
      if (err) {
        // lsof exits 1 when any named file is absent but still lists the rest.
        reject(Object.assign(err, { stdout: String(stdout ?? '') }));
      } else {
        resolve({ stdout: String(stdout) });
      }
    });
  });

function defaultIsAlive(pid: number): boolean {
  return classifyHolder(pid, null) === 'live';
}

function clockTime(iso: string | null): string | null {
  if (!iso) return null;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  return t.toISOString().slice(11, 16);
}

function gatewayEntry(pid: number | null, startedAt: string | null): string {
  const parts = [pid === null ? 'pid unknown' : `pid ${pid}`];
  const at = clockTime(startedAt);
  if (at) parts.push(`started ${at} UTC`);
  return `ethos gateway (${parts.join(', ')})`;
}

/**
 * Parse `lsof -F pcn` output: one `p<pid>` line opens a process set, `c<command>`
 * follows, then `f<fd>`/`n<name>` pairs per open file. Only p and c are used.
 */
export function parseLsofFields(stdout: string): { pid: number; command: string }[] {
  const out: { pid: number; command: string }[] = [];
  let cur: { pid: number; command: string } | undefined;
  for (const line of stdout.split('\n')) {
    const tag = line[0];
    const val = line.slice(1);
    if (tag === 'p') {
      const pid = Number(val);
      cur = Number.isInteger(pid) && pid > 0 ? { pid, command: '' } : undefined;
      if (cur) out.push(cur);
    } else if (tag === 'c' && cur) {
      cur.command = val;
    }
  }
  return out;
}

async function probe(dataDir: string, deps: HolderDeps): Promise<string[]> {
  const entries: string[] = [];
  const named = new Set<number>();
  const now = (deps.now ?? Date.now)();
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const selfPid = deps.selfPid ?? process.pid;

  try {
    const lock = inspectGatewayLock(dataDir);
    if (lock.holder === 'live') {
      entries.push(gatewayEntry(lock.pid, lock.startedAt));
      if (lock.pid !== null) named.add(lock.pid);
    }
  } catch {
    // an unreadable lock is simply not a source
  }

  try {
    const raw = await readFile(join(dataDir, 'gateway-health.json'), 'utf-8');
    const hb: unknown = JSON.parse(raw);
    if (typeof hb === 'object' && hb !== null) {
      const { pid, startedAt, updatedAt } = hb as Record<string, unknown>;
      const age = typeof updatedAt === 'string' ? now - Date.parse(updatedAt) : Number.NaN;
      if (
        typeof pid === 'number' &&
        Number.isInteger(pid) &&
        pid > 0 &&
        !named.has(pid) &&
        age >= 0 &&
        age <= HEARTBEAT_FRESH_MS &&
        isAlive(pid)
      ) {
        entries.push(gatewayEntry(pid, typeof startedAt === 'string' ? startedAt : null));
        named.add(pid);
      }
    }
  } catch {
    // no heartbeat, or an unreadable one: not a source
  }

  try {
    const exec = deps.exec ?? defaultExec;
    let stdout = '';
    try {
      ({ stdout } = await exec(
        'lsof',
        ['-nP', '-F', 'pcn', '--', 'sessions.db', 'sessions.db-wal', 'sessions.db-shm'],
        { timeout: LSOF_TIMEOUT_MS, cwd: dataDir },
      ));
    } catch (err) {
      // lsof exits 1 if any named file is absent (for example no -wal) yet still
      // lists the others; a missing binary or a timeout carries no stdout.
      stdout =
        typeof (err as { stdout?: unknown }).stdout === 'string'
          ? (err as { stdout: string }).stdout
          : '';
    }
    const procs = parseLsofFields(stdout).filter((p) => p.pid !== selfPid && !named.has(p.pid));
    if (procs.length > 0) {
      const list = procs
        .map((p) => (p.command ? `${p.command} (pid ${p.pid})` : `pid ${p.pid}`))
        .join(', ');
      entries.push(`processes with sessions.db open: ${list}`);
    }
  } catch {
    // lsof is best effort
  }

  return entries;
}

/**
 * Names of the processes likely holding `<dataDir>/sessions.db`, best first. `[]`
 * when nothing could be named. Never throws.
 */
export function describeSessionsDbHolders(
  dataDir: string,
  deps: HolderDeps = {},
): Promise<string[]> {
  const now = (deps.now ?? Date.now)();
  const hit = cache.get(dataDir);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;
  const value = probe(dataDir, deps).catch(() => [] as string[]);
  cache.set(dataDir, { at: now, value });
  return value;
}
