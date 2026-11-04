import { join } from 'node:path';
import type { Storage } from '@ethosagent/types';
import type { HostSpec } from './host-types';
import { PROTOCOL_VERSION, type Registration } from './protocol';
import { parseRegistration } from './registration-parse';
import { isRecord, isStringArray } from './util';

/**
 * Replayable registration list cache (plan plugin-process-isolation §5.4.3,
 * Part 7). With a matching cache the pool registers proxies without spawning;
 * the first real call spawns, activates and compares (the drift rule).
 *
 * Every read here is a miss on doubt: a corrupt, unreadable, mismatched or
 * unsafe-to-trust cache falls back to a normal spawn and never throws. Pinned
 * by `extensions/plugin-host/src/__tests__/registration-cache.test.ts`.
 */

export interface RegistrationCacheKey {
  id: string;
  version: string;
  /** `lock:<plugins.lock integrity>` when known, else `mtime:<entry mtime ms>`. */
  integrity: string;
  protocolVersion: number;
}

export interface RegistrationCacheEntry {
  key: RegistrationCacheKey;
  registrations: Registration[];
  holdsLongLived: boolean;
  /**
   * Sorted secret key NAMES the host was activated with. `isAvailable()` snapshots usually depend
   * on them, so a different set is a miss rather than a stale "unavailable" that nothing refreshes.
   */
  secretKeys: string[];
}

/** `<dataDir>/plugin-hosts/<dirName>/registrations.json`; `dirName` is `hostDirName(id)`. */
export function registrationCachePath(dataDir: string, dirName: string): string {
  return join(dataDir, 'plugin-hosts', dirName, 'registrations.json');
}

/**
 * The cache key for a plugin, or `undefined` when no stable identity exists
 * (no lock integrity and the entry has no mtime): such a plugin is never cached.
 */
export async function computeCacheKey(
  storage: Storage,
  spec: HostSpec,
): Promise<RegistrationCacheKey | undefined> {
  let integrity: string;
  if (spec.integrity) {
    integrity = `lock:${spec.integrity}`;
  } else {
    let mtime: number | null = null;
    try {
      mtime = await storage.mtime(spec.entry ?? spec.dir);
    } catch {
      mtime = null;
    }
    if (mtime === null) return undefined;
    integrity = `mtime:${mtime}`;
  }
  return {
    id: spec.id,
    version: spec.version ?? '',
    integrity,
    protocolVersion: PROTOCOL_VERSION,
  };
}

function sameKey(a: RegistrationCacheKey, b: RegistrationCacheKey): boolean {
  return (
    a.id === b.id &&
    a.version === b.version &&
    a.integrity === b.integrity &&
    a.protocolVersion === b.protocolVersion
  );
}

function parseKey(raw: unknown): RegistrationCacheKey | undefined {
  if (!isRecord(raw)) return undefined;
  const { id, version, integrity, protocolVersion } = raw;
  if (
    typeof id !== 'string' ||
    typeof version !== 'string' ||
    typeof integrity !== 'string' ||
    typeof protocolVersion !== 'number'
  ) {
    return undefined;
  }
  return { id, version, integrity, protocolVersion };
}

/** A long-lived host (route, monitor, bus subscription) has to be running, so the cache cannot defer it. */
export function mustSpawnEagerly(
  entry: Pick<RegistrationCacheEntry, 'registrations' | 'holdsLongLived'>,
): boolean {
  return entry.holdsLongLived || entry.registrations.some((r) => r.kind === 'route');
}

export function sortedSecretKeys(keys: readonly string[] | undefined): string[] {
  return [...(keys ?? [])].sort();
}

/** The cached entry when it parses and its key equals `key`; otherwise `undefined` (a miss). */
export async function readRegistrationCache(
  storage: Storage,
  path: string,
  key: RegistrationCacheKey,
  secretKeys: readonly string[],
): Promise<RegistrationCacheEntry | undefined> {
  try {
    const text = await storage.read(path);
    if (text === null) return undefined;
    const raw: unknown = JSON.parse(text);
    if (!isRecord(raw) || !Array.isArray(raw.registrations)) return undefined;
    const stored = parseKey(raw.key);
    if (!stored || !sameKey(stored, key)) return undefined;
    const registrations: Registration[] = [];
    for (const item of raw.registrations) {
      const reg = parseRegistration(item);
      if (!reg) return undefined; // a partial replay would half-work silently
      registrations.push(reg);
    }
    const cachedKeys = isStringArray(raw.secretKeys) ? raw.secretKeys : undefined;
    if (!cachedKeys || cachedKeys.join('\0') !== sortedSecretKeys(secretKeys).join('\0')) {
      return undefined;
    }
    return {
      key: stored,
      registrations,
      holdsLongLived: raw.holdsLongLived === true,
      secretKeys: cachedKeys,
    };
  } catch {
    return undefined;
  }
}

/** Atomic write; returns false (never throws) when the cache could not be written. */
export async function writeRegistrationCache(
  storage: Storage,
  path: string,
  entry: RegistrationCacheEntry,
): Promise<boolean> {
  try {
    await storage.mkdir(join(path, '..'));
    await storage.writeAtomic(path, JSON.stringify(entry));
    return true;
  } catch {
    return false;
  }
}
