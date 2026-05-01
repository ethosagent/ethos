import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CACHE_PATH = join(homedir(), '.ethos', 'update-cache.json');
const REGISTRY_URL = 'https://registry.npmjs.org/@ethosagent/cli/latest';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;

interface UpdateCache {
  lastChecked: number;
  latest: string;
}

export interface UpdateStatus {
  behind: number;
  latest: string;
}

function parseVersion(v: string): number[] {
  return v
    .replace(/^[^0-9]*/, '')
    .split('.')
    .map(Number);
}

function isOlder(current: string, latest: string): boolean {
  const c = parseVersion(current);
  const l = parseVersion(latest);
  for (let i = 0; i < 3; i++) {
    const cv = c[i] ?? 0;
    const lv = l[i] ?? 0;
    if (cv < lv) return true;
    if (cv > lv) return false;
  }
  return false;
}

function versionDelta(current: string, latest: string): number {
  const c = parseVersion(current);
  const l = parseVersion(latest);
  // Patch-level distance as a rough proxy for "versions behind"
  const cp = (c[0] ?? 0) * 10000 + (c[1] ?? 0) * 100 + (c[2] ?? 0);
  const lp = (l[0] ?? 0) * 10000 + (l[1] ?? 0) * 100 + (l[2] ?? 0);
  return Math.max(0, lp - cp);
}

async function readCache(): Promise<UpdateCache | null> {
  try {
    const raw = await readFile(CACHE_PATH, 'utf-8');
    return JSON.parse(raw) as UpdateCache;
  } catch {
    return null;
  }
}

async function writeCache(cache: UpdateCache): Promise<void> {
  try {
    await writeFile(CACHE_PATH, JSON.stringify(cache), 'utf-8');
  } catch {
    // ignore write failures — fail-open
  }
}

async function fetchLatest(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(REGISTRY_URL, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return typeof data.version === 'string' ? data.version : null;
  } catch {
    return null;
  }
}

export async function getUpdateStatus(currentVersion: string): Promise<UpdateStatus | null> {
  try {
    const cache = await readCache();
    let latest: string | null = null;

    if (cache && Date.now() - cache.lastChecked < CACHE_TTL_MS) {
      latest = cache.latest;
    } else {
      latest = await fetchLatest();
      if (latest) {
        await writeCache({ lastChecked: Date.now(), latest });
      } else if (cache) {
        latest = cache.latest;
      }
    }

    if (!latest) return null;
    if (!isOlder(currentVersion, latest)) return null;

    return { behind: versionDelta(currentVersion, latest), latest };
  } catch {
    return null;
  }
}
