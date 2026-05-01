import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
}

export type Registry = Record<string, ProcessEntry>;

function registryPath(dataDir: string): string {
  return join(dataDir, 'processes', 'registry.json');
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

export function updateEntry(dataDir: string, id: string, patch: Partial<ProcessEntry>): void {
  const registry = loadRegistry(dataDir);
  const entry = registry[id];
  if (!entry) return;
  registry[id] = { ...entry, ...patch, lastTouchedAt: new Date().toISOString() };
  saveRegistry(dataDir, registry);
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
