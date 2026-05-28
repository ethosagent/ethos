import { InMemoryStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bundledToManifest,
  fetchManifest,
  loadCachedManifest,
  loadModelCatalog,
  mergeRemoteIntoBundled,
  writeCachedManifest,
} from '../model-catalog-loader';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const VALID_MANIFEST = {
  version: 2,
  updatedAt: '2026-05-10T00:00:00.000Z',
  providers: {
    anthropic: {
      models: [
        { id: 'claude-opus-4-7', label: 'most capable', contextWindow: 200_000, default: true },
        { id: 'claude-sonnet-4-6', label: 'fast, balanced', contextWindow: 200_000 },
      ],
    },
    'openai-compat': {
      models: [{ id: 'gpt-4o', label: 'most capable', contextWindow: 128_000, default: true }],
    },
  },
};
const CACHE_PATH = '/data/cache/model-catalog.json';
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function mockFetchOk(body) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  });
}
function mockFetchError() {
  return vi.fn().mockRejectedValue(new Error('network error'));
}
function mockFetchBadStatus(status) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => ({}),
  });
}
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('fetchManifest', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('returns manifest on 200 OK with valid JSON', async () => {
    vi.stubGlobal('fetch', mockFetchOk(VALID_MANIFEST));
    const result = await fetchManifest('https://example.com/catalog.json');
    expect(result).toEqual(VALID_MANIFEST);
  });
  it('throws on non-200 status', async () => {
    vi.stubGlobal('fetch', mockFetchBadStatus(500));
    await expect(fetchManifest('https://example.com/catalog.json')).rejects.toThrow(
      'model catalog fetch failed: HTTP 500',
    );
  });
  it('throws on invalid manifest shape (missing version)', async () => {
    vi.stubGlobal('fetch', mockFetchOk({ updatedAt: 'x', providers: {} }));
    await expect(fetchManifest('https://example.com/catalog.json')).rejects.toThrow(
      'model catalog: invalid manifest shape',
    );
  });
  it('throws on invalid manifest shape (providers is null)', async () => {
    vi.stubGlobal('fetch', mockFetchOk({ version: 1, updatedAt: 'x', providers: null }));
    await expect(fetchManifest('https://example.com/catalog.json')).rejects.toThrow(
      'model catalog: invalid manifest shape',
    );
  });
});
describe('loadCachedManifest', () => {
  let storage;
  beforeEach(() => {
    storage = new InMemoryStorage();
  });
  it('returns null when cache file does not exist', async () => {
    const result = await loadCachedManifest(storage, CACHE_PATH);
    expect(result).toBeNull();
  });
  it('returns null when cache file contains invalid JSON', async () => {
    await storage.mkdir('/data/cache');
    await storage.write(CACHE_PATH, 'not json {{{');
    const result = await loadCachedManifest(storage, CACHE_PATH);
    expect(result).toBeNull();
  });
  it('returns null when cache file has invalid manifest shape', async () => {
    await storage.mkdir('/data/cache');
    await storage.write(CACHE_PATH, JSON.stringify({ bad: 'data' }));
    const result = await loadCachedManifest(storage, CACHE_PATH);
    expect(result).toBeNull();
  });
  it('returns manifest and age when cache is valid', async () => {
    await storage.mkdir('/data/cache');
    await storage.write(CACHE_PATH, JSON.stringify(VALID_MANIFEST));
    const result = await loadCachedManifest(storage, CACHE_PATH);
    expect(result).not.toBeNull();
    expect(result?.manifest).toEqual(VALID_MANIFEST);
    expect(typeof result?.ageMs).toBe('number');
  });
});
describe('writeCachedManifest', () => {
  let storage;
  beforeEach(() => {
    storage = new InMemoryStorage();
  });
  it('creates parent directory and writes manifest', async () => {
    await writeCachedManifest(storage, CACHE_PATH, VALID_MANIFEST);
    const content = await storage.read(CACHE_PATH);
    expect(content).not.toBeNull();
    const parsed = JSON.parse(content ?? '');
    expect(parsed).toEqual(VALID_MANIFEST);
  });
});
describe('bundledToManifest', () => {
  it('returns a valid manifest with anthropic, azure, and openai-compat providers', () => {
    const manifest = bundledToManifest();
    expect(manifest.version).toBe(1);
    expect(typeof manifest.updatedAt).toBe('string');
    expect(manifest.providers.anthropic).toBeDefined();
    expect(manifest.providers.azure).toBeDefined();
    expect(manifest.providers['openai-compat']).toBeDefined();
    // Anthropic models should include claude entries
    expect(manifest.providers.anthropic.models.length).toBeGreaterThan(0);
    expect(manifest.providers.anthropic.models[0].id).toContain('claude');
  });
  it('collapses openai/openrouter/gemini/groq/deepseek/ollama into openai-compat', () => {
    const manifest = bundledToManifest();
    // Should NOT have separate keys for these providers
    expect(manifest.providers.openai).toBeUndefined();
    expect(manifest.providers.openrouter).toBeUndefined();
    expect(manifest.providers.gemini).toBeUndefined();
    expect(manifest.providers.groq).toBeUndefined();
    expect(manifest.providers.deepseek).toBeUndefined();
    expect(manifest.providers.ollama).toBeUndefined();
  });
});
describe('mergeRemoteIntoBundled', () => {
  it('remote providers override bundled providers with same key', () => {
    const remote = {
      version: 2,
      updatedAt: '2026-05-10T00:00:00.000Z',
      providers: {
        anthropic: {
          models: [{ id: 'claude-opus-5', label: 'newest', contextWindow: 500_000 }],
        },
      },
    };
    const bundled = {
      version: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
      providers: {
        anthropic: {
          models: [{ id: 'claude-opus-4-7', label: 'old', contextWindow: 200_000 }],
        },
        'openai-compat': {
          models: [{ id: 'gpt-4o', label: 'gpt', contextWindow: 128_000 }],
        },
      },
    };
    const merged = mergeRemoteIntoBundled(remote, bundled);
    // Remote anthropic wins
    expect(merged.providers.anthropic.models).toEqual([
      { id: 'claude-opus-5', label: 'newest', contextWindow: 500_000 },
    ]);
    // Bundled-only provider preserved
    expect(merged.providers['openai-compat']).toEqual(bundled.providers['openai-compat']);
  });
  it('bundled-only provider persists when remote drops it', () => {
    const remote = {
      version: 2,
      updatedAt: '2026-05-10T00:00:00.000Z',
      providers: {
        anthropic: {
          models: [{ id: 'claude-opus-5', label: 'newest', contextWindow: 500_000 }],
        },
      },
    };
    const bundled = {
      version: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
      providers: {
        anthropic: {
          models: [{ id: 'old', label: 'old', contextWindow: 100_000 }],
        },
        azure: {
          models: [{ id: 'gpt-5.4', label: 'frontier', contextWindow: 200_000 }],
        },
      },
    };
    const merged = mergeRemoteIntoBundled(remote, bundled);
    // Azure was only in bundled — must still be present
    expect(merged.providers.azure).toBeDefined();
    expect(merged.providers.azure.models[0].id).toBe('gpt-5.4');
  });
  it('preserves remote version and updatedAt', () => {
    const remote = {
      version: 3,
      updatedAt: '2026-06-01T00:00:00.000Z',
      providers: {},
    };
    const bundled = {
      version: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
      providers: { azure: { models: [] } },
    };
    const merged = mergeRemoteIntoBundled(remote, bundled);
    expect(merged.version).toBe(3);
    expect(merged.updatedAt).toBe('2026-06-01T00:00:00.000Z');
  });
});
describe('loadModelCatalog', () => {
  let storage;
  beforeEach(() => {
    storage = new InMemoryStorage();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('200 OK with valid JSON → caches + returns remote merged with bundled', async () => {
    vi.stubGlobal('fetch', mockFetchOk(VALID_MANIFEST));
    const logger = { info: vi.fn(), warn: vi.fn() };
    const result = await loadModelCatalog({
      url: 'https://example.com/catalog.json',
      ttlMs: 60_000,
      storage,
      cachePath: CACHE_PATH,
      logger,
    });
    // Remote providers present
    expect(result.providers.anthropic).toEqual(VALID_MANIFEST.providers.anthropic);
    expect(result.providers['openai-compat']).toEqual(VALID_MANIFEST.providers['openai-compat']);
    // Bundled-only providers merged in (azure from bundled)
    expect(result.providers.azure).toBeDefined();
    // Was cached
    const cached = await storage.read(CACHE_PATH);
    expect(cached).not.toBeNull();
    expect(JSON.parse(cached ?? '')).toEqual(VALID_MANIFEST);
    // Logger info called
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('model catalog: loaded'));
    expect(logger.warn).not.toHaveBeenCalled();
  });
  it('200 OK with malformed JSON → falls through to bundled, logs warning', async () => {
    vi.stubGlobal('fetch', mockFetchOk({ not: 'a manifest' }));
    const logger = { info: vi.fn(), warn: vi.fn() };
    const result = await loadModelCatalog({
      url: 'https://example.com/catalog.json',
      ttlMs: 60_000,
      storage,
      cachePath: CACHE_PATH,
      logger,
    });
    // Should fall back to bundled
    const bundled = bundledToManifest();
    expect(result.providers.anthropic.models.length).toBe(
      bundled.providers.anthropic.models.length,
    );
    expect(logger.warn).toHaveBeenCalledWith('model catalog fetch failed; using bundled snapshot');
  });
  it('network error with no cache → bundled fallback + warn log', async () => {
    vi.stubGlobal('fetch', mockFetchError());
    const logger = { info: vi.fn(), warn: vi.fn() };
    const result = await loadModelCatalog({
      url: 'https://example.com/catalog.json',
      ttlMs: 60_000,
      storage,
      cachePath: CACHE_PATH,
      logger,
    });
    const bundled = bundledToManifest();
    expect(result.version).toBe(bundled.version);
    expect(result.providers.anthropic.models.length).toBe(
      bundled.providers.anthropic.models.length,
    );
    expect(logger.warn).toHaveBeenCalledWith('model catalog fetch failed; using bundled snapshot');
  });
  it('fresh cache (age < TTL) → returns cache without fetching', async () => {
    // Pre-populate fresh cache
    await storage.mkdir('/data/cache');
    await storage.write(CACHE_PATH, JSON.stringify(VALID_MANIFEST));
    // Mock Date.now to make the cache appear fresh (mtime is a small clock
    // value from InMemoryStorage, so Date.now() - mtime will always be huge
    // unless we mock Date.now to be close to the mtime)
    const mtime = await storage.mtime(CACHE_PATH);
    expect(mtime).not.toBeNull();
    vi.spyOn(Date, 'now').mockReturnValue((mtime ?? 0) + 1_000); // 1 second old
    const fetchMock = mockFetchError();
    vi.stubGlobal('fetch', fetchMock);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const result = await loadModelCatalog({
      url: 'https://example.com/catalog.json',
      ttlMs: 60_000,
      storage,
      cachePath: CACHE_PATH,
      logger,
    });
    // Should return the cached manifest merged with bundled
    expect(result.providers.anthropic).toEqual(VALID_MANIFEST.providers.anthropic);
    // Fetch should not have been called (fresh cache short-circuits)
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
  it('cache present but stale, remote fails → stale cache + warn log', async () => {
    // Pre-populate stale cache
    await storage.mkdir('/data/cache');
    await storage.write(CACHE_PATH, JSON.stringify(VALID_MANIFEST));
    // Mock Date.now so age > TTL (stale)
    const mtime = await storage.mtime(CACHE_PATH);
    expect(mtime).not.toBeNull();
    vi.spyOn(Date, 'now').mockReturnValue((mtime ?? 0) + 7_200_000); // 2 hours old
    vi.stubGlobal('fetch', mockFetchError());
    const logger = { info: vi.fn(), warn: vi.fn() };
    const result = await loadModelCatalog({
      url: 'https://example.com/catalog.json',
      ttlMs: 60_000,
      storage,
      cachePath: CACHE_PATH,
      logger,
    });
    // Should use stale cache merged with bundled
    expect(result.providers.anthropic).toEqual(VALID_MANIFEST.providers.anthropic);
    expect(result.providers.azure).toBeDefined(); // bundled azure merged in
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('model catalog fetch failed; using cache'),
    );
  });
  it('remote drops a bundled-only provider → still present in returned manifest', async () => {
    // Remote has only anthropic — no azure, no openai-compat
    const remoteManifest = {
      version: 3,
      updatedAt: '2026-05-15T00:00:00.000Z',
      providers: {
        anthropic: {
          models: [
            {
              id: 'claude-opus-5',
              label: 'newest frontier',
              contextWindow: 500_000,
              default: true,
            },
          ],
        },
      },
    };
    vi.stubGlobal('fetch', mockFetchOk(remoteManifest));
    const logger = { info: vi.fn(), warn: vi.fn() };
    const result = await loadModelCatalog({
      url: 'https://example.com/catalog.json',
      ttlMs: 60_000,
      storage,
      cachePath: CACHE_PATH,
      logger,
    });
    // Remote anthropic is used
    expect(result.providers.anthropic.models[0].id).toBe('claude-opus-5');
    // Bundled azure and openai-compat still present
    expect(result.providers.azure).toBeDefined();
    expect(result.providers.azure.models.length).toBeGreaterThan(0);
    expect(result.providers['openai-compat']).toBeDefined();
    expect(result.providers['openai-compat'].models.length).toBeGreaterThan(0);
  });
});
