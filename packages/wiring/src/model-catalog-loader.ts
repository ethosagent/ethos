import type { ModelCatalogManifest, Storage } from '@ethosagent/types';
import { MODEL_CATALOG } from './model-catalog';

export interface LoadModelCatalogOptions {
  url: string;
  ttlMs: number;
  storage: Storage;
  cachePath: string;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}

/**
 * Fetch manifest from URL with timeout + schema validation.
 * Throws on network error, non-200, or invalid shape.
 */
export async function fetchManifest(url: string): Promise<ModelCatalogManifest> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`model catalog fetch failed: HTTP ${res.status}`);
    const json = await res.json();
    if (!isValidManifest(json)) throw new Error('model catalog: invalid manifest shape');
    return json as ModelCatalogManifest;
  } finally {
    clearTimeout(timeout);
  }
}

function isValidManifest(obj: unknown): boolean {
  if (typeof obj !== 'object' || obj === null) return false;
  const m = obj as Record<string, unknown>;
  if (typeof m.version !== 'number') return false;
  if (typeof m.updatedAt !== 'string') return false;
  if (typeof m.providers !== 'object' || m.providers === null) return false;
  return true;
}

/**
 * Read cached manifest from Storage. Returns null if missing or unparseable.
 */
export async function loadCachedManifest(
  storage: Storage,
  cachePath: string,
): Promise<{ manifest: ModelCatalogManifest; ageMs: number } | null> {
  const content = await storage.read(cachePath);
  if (!content) return null;
  try {
    const manifest = JSON.parse(content);
    if (!isValidManifest(manifest)) return null;
    const mtime = await storage.mtime(cachePath);
    const ageMs = mtime ? Date.now() - mtime : Infinity;
    return { manifest: manifest as ModelCatalogManifest, ageMs };
  } catch {
    return null;
  }
}

/**
 * Write manifest to cache atomically via Storage.
 */
export async function writeCachedManifest(
  storage: Storage,
  cachePath: string,
  manifest: ModelCatalogManifest,
): Promise<void> {
  const dir = cachePath.substring(0, cachePath.lastIndexOf('/'));
  await storage.mkdir(dir);
  await storage.writeAtomic(cachePath, JSON.stringify(manifest, null, 2));
}

/**
 * Convert the bundled MODEL_CATALOG array to the manifest shape.
 */
export function bundledToManifest(): ModelCatalogManifest {
  const providers: Record<
    string,
    { models: Array<{ id: string; label: string; contextWindow: number; default?: boolean }> }
  > = {};
  for (const entry of MODEL_CATALOG) {
    const key =
      entry.providerId === 'anthropic'
        ? 'anthropic'
        : entry.providerId === 'azure'
          ? 'azure'
          : 'openai-compat';
    if (!providers[key]) providers[key] = { models: [] };
    const model: { id: string; label: string; contextWindow: number; default?: boolean } = {
      id: entry.modelId,
      label: entry.label,
      contextWindow: entry.contextWindow,
    };
    if (entry.default) model.default = true;
    providers[key].models.push(model);
  }
  return { version: 1, updatedAt: new Date().toISOString(), providers };
}

/**
 * Merge remote manifest into bundled, ensuring bundled-only providers persist.
 */
export function mergeRemoteIntoBundled(
  remote: ModelCatalogManifest,
  bundled: ModelCatalogManifest,
): ModelCatalogManifest {
  const merged = { ...remote, providers: { ...remote.providers } };
  for (const [key, catalog] of Object.entries(bundled.providers)) {
    if (!merged.providers[key]) {
      merged.providers[key] = catalog;
    }
  }
  return merged;
}

/**
 * Main loader: remote → cache → bundled fallback.
 */
export async function loadModelCatalog(
  opts: LoadModelCatalogOptions,
): Promise<ModelCatalogManifest> {
  const { url, ttlMs, storage, cachePath, logger } = opts;
  const bundled = bundledToManifest();

  // 1. Try cache first — if fresh, skip network
  const cached = await loadCachedManifest(storage, cachePath);
  if (cached && cached.ageMs < ttlMs) {
    return mergeRemoteIntoBundled(cached.manifest, bundled);
  }

  // 2. Fetch remote
  try {
    const remote = await fetchManifest(url);
    // Cache the fresh manifest
    await writeCachedManifest(storage, cachePath, remote).catch(() => {});
    logger?.info(
      `model catalog: loaded ${Object.values(remote.providers).reduce((sum, p) => sum + p.models.length, 0)} entries from remote (manifest v${remote.version}, updated ${remote.updatedAt})`,
    );
    return mergeRemoteIntoBundled(remote, bundled);
  } catch {
    // 3. Fallback: stale cache or bundled
    if (cached) {
      const hours = Math.round(cached.ageMs / 3_600_000);
      logger?.warn(`model catalog fetch failed; using cache (${hours}h old)`);
      return mergeRemoteIntoBundled(cached.manifest, bundled);
    }
    logger?.warn('model catalog fetch failed; using bundled snapshot');
    return bundled;
  }
}
