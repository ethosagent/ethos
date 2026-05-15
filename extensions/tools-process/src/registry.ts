// TODO(capability-migration): Registry persistence uses sync fs ops (advisory
// lock, JSON read/write, atomic rename). This module is shared between tools and
// the CLI — migrating to ctx.scopedFs requires threading ctx through every call
// site, including non-tool code paths (reconcileRegistry at startup). Deferred.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export type ProcessStatus = 'running' | 'exited' | 'killed' | 'orphan';

export interface ProcessEntry {
  id: string;
  name: string;
  pid: number;
  command: string;
  cwd: string;
  status: ProcessStatus;
  startedAt: string;
  exitCode?: number;
  lastTouchedAt: string;
  /**
   * Personality id that started the process. Optional because registry.json
   * files written before this field existed won't have it — consumers must
   * default (`started_by ?? 'unknown'`).
   */
  started_by?: string;
}

export type Registry = Record<string, ProcessEntry>;

function registryPath(dataDir: string): string {
  return join(dataDir, 'processes', 'registry.json');
}

function lockPath(dataDir: string): string {
  return join(dataDir, 'processes', 'registry.lock');
}

// Advisory lock mirrored from extensions/agent-mesh/src/index.ts: acquire by
// creating the lock file with the 'wx' (exclusive) flag, release by unlinking.
// Stale locks (holder crashed) are reclaimed once older than LOCK_TTL_MS.
const LOCK_TTL_MS = 5_000;
const LOCK_RETRY_MS = 10;

async function acquireRegistryLock(dataDir: string): Promise<() => void> {
  const path = lockPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + LOCK_TTL_MS;
  while (Date.now() < deadline) {
    try {
      writeFileSync(path, '', { flag: 'wx' });
      return () => {
        try {
          unlinkSync(path);
        } catch {
          /* already gone */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        const stat = statSync(path);
        if (Date.now() - stat.mtimeMs > LOCK_TTL_MS) {
          try {
            unlinkSync(path);
          } catch {
            /* race: another holder already cleaned it up */
          }
          continue;
        }
      } catch {
        /* lock file disappeared between check and stat — retry immediately */
        continue;
      }
      await new Promise<void>((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }
  throw new Error(`Failed to acquire registry lock at ${path} within ${LOCK_TTL_MS}ms`);
}

/**
 * Run `fn` while holding the registry advisory lock. Wrap every
 * read-modify-write of the registry in this so concurrent mutations
 * (e.g. parallel process_start calls) don't lose entries.
 */
export async function withRegistryLock<T>(dataDir: string, fn: () => T | Promise<T>): Promise<T> {
  const release = await acquireRegistryLock(dataDir);
  try {
    return await fn();
  } finally {
    release();
  }
}

export function loadRegistry(dataDir: string): Registry {
  const path = registryPath(dataDir);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Registry;
  } catch {
    return {};
  }
}

export function saveRegistry(dataDir: string, registry: Registry): void {
  const path = registryPath(dataDir);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(registry, null, 2), 'utf8');
  renameSync(tmp, path);
}

export async function updateEntry(
  dataDir: string,
  id: string,
  patch: Partial<ProcessEntry>,
): Promise<void> {
  await updateEntryIf(dataDir, id, () => true, patch);
}

/**
 * Conditionally patch an entry: load + predicate-check + write all happen
 * under ONE lock acquisition, so the check-then-act is atomic. Use this when
 * a writer must only mutate an entry that is still in a particular state
 * (e.g. the spawn exit handler must not clobber a status set by process_stop
 * while the handler was waiting for the lock).
 */
export async function updateEntryIf(
  dataDir: string,
  id: string,
  predicate: (entry: ProcessEntry) => boolean,
  patch: Partial<ProcessEntry>,
): Promise<void> {
  await withRegistryLock(dataDir, () => {
    const registry = loadRegistry(dataDir);
    const entry = registry[id];
    if (!entry || !predicate(entry)) return;
    registry[id] = { ...entry, ...patch, lastTouchedAt: new Date().toISOString() };
    saveRegistry(dataDir, registry);
  });
}

/**
 * Check whether a process is still alive. Returns false when the signal(0)
 * syscall throws ESRCH (no such process).
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const REAP_AGE_MS = 24 * 60 * 60 * 1000;

export function reapStale(registry: Registry): Registry {
  const cutoff = Date.now() - REAP_AGE_MS;
  const out: Registry = {};
  for (const [id, entry] of Object.entries(registry)) {
    const terminal = entry.status === 'orphan' || entry.status === 'exited';
    if (terminal && new Date(entry.lastTouchedAt).getTime() < cutoff) continue;
    out[id] = entry;
  }
  return out;
}
