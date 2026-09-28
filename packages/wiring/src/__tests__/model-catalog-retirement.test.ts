// A deprecated model stays in MODEL_CATALOG with `retiresOn`, labelled
// `deprecated — retires <date>`. Listings (`getModelsForProvider`,
// `listedModels`, `getDefaultModel`) drop it from that date on, evaluated
// against the clock at call time; lookups keep answering so a config that names
// it still resolves. Every clock here is fixed.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { ModelCatalogManifest } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  getDefaultModel,
  getModelsForProvider,
  isModelRetired,
  listedModels,
  lookupCatalogModel,
  lookupContextWindow,
  MODEL_CATALOG,
} from '../model-catalog';
import { bundledToManifest, loadCachedManifest, manifestToEntries } from '../model-catalog-loader';

const BEFORE = new Date('2026-10-13T23:59:59.999Z');
const ON = new Date('2026-10-14T00:00:00.000Z');
const AFTER = new Date('2027-01-01T12:00:00.000Z');

describe('catalog rows with retiresOn', () => {
  const retiring = MODEL_CATALOG.filter((m) => m.retiresOn !== undefined);

  it('carries at least the Codex gpt-5.5 and OpenRouter gemini-2.5-pro rows', () => {
    const ids = retiring.map((m) => `${m.providerId}/${m.modelId}`);
    expect(ids).toContain('codex/gpt-5.5');
    expect(ids).toContain('openrouter/google/gemini-2.5-pro');
  });

  it('uses an ISO date and says so in the label', () => {
    for (const m of retiring) {
      expect(m.retiresOn, m.modelId).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(m.label, m.modelId).toContain(`deprecated — retires ${m.retiresOn}`);
    }
  });

  it('labels no row deprecated without a retiresOn to hide it by', () => {
    for (const m of MODEL_CATALOG) {
      if (m.label.includes('deprecated')) expect(m.retiresOn, m.modelId).toBeDefined();
    }
  });

  it('never makes a retiring row a provider default', () => {
    for (const m of retiring) expect(m.default, m.modelId).toBeUndefined();
  });
});

describe('isModelRetired', () => {
  it('is false before the date, true from the first instant of it (UTC)', () => {
    const row = { retiresOn: '2026-10-14' };
    expect(isModelRetired(row, BEFORE)).toBe(false);
    expect(isModelRetired(row, ON)).toBe(true);
    expect(isModelRetired(row, AFTER)).toBe(true);
  });

  it('never retires a row without retiresOn', () => {
    expect(isModelRetired({}, AFTER)).toBe(false);
  });
});

describe('listings hide a model once its retirement date is reached', () => {
  it('getModelsForProvider lists codex gpt-5.5 before 2026-10-14 and not from then on', () => {
    const ids = (now: Date) => getModelsForProvider('codex', now).map((m) => m.modelId);
    expect(ids(BEFORE)).toContain('gpt-5.5');
    expect(ids(ON)).not.toContain('gpt-5.5');
    expect(ids(AFTER)).not.toContain('gpt-5.5');
    expect(ids(AFTER)).toContain('gpt-6-sol');
  });

  it('listedModels filters any row list the same way', () => {
    expect(listedModels(MODEL_CATALOG, BEFORE).length).toBe(MODEL_CATALOG.length);
    const after = listedModels(MODEL_CATALOG, AFTER);
    expect(after.some((m) => m.retiresOn !== undefined)).toBe(false);
    expect(after.length).toBe(MODEL_CATALOG.length - 2);
  });

  it('the provider default does not move when a sibling row retires', () => {
    expect(getDefaultModel('codex', BEFORE)?.modelId).toBe('gpt-6-sol');
    expect(getDefaultModel('codex', AFTER)?.modelId).toBe('gpt-6-sol');
  });
});

describe('a config naming a retired row still resolves', () => {
  it('lookups ignore the retirement date', () => {
    expect(lookupContextWindow('codex', 'gpt-5.5')).toBe(1_050_000);
    expect(lookupCatalogModel('openrouter', 'google/gemini-2.5-pro')?.contextWindow).toBe(
      1_048_576,
    );
  });
});

describe('retiresOn through the manifest', () => {
  it('survives bundledToManifest → manifestToEntries', () => {
    const entries = manifestToEntries(bundledToManifest());
    const gemini = entries.find((e) => e.modelId === 'google/gemini-2.5-pro');
    expect(gemini?.retiresOn).toBe('2026-10-20');
  });

  it('rejects a cached manifest whose retiresOn is not an ISO date', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir('/cache');
    const bad: ModelCatalogManifest = {
      version: 1,
      updatedAt: '2026-09-28T00:00:00.000Z',
      providers: {
        anthropic: {
          models: [{ id: 'm', label: 'x', contextWindow: 1000, retiresOn: 'Oct 14 2026' }],
        },
      },
    };
    await storage.write('/cache/catalog.json', JSON.stringify(bad));
    expect(await loadCachedManifest(storage, '/cache/catalog.json')).toBeNull();

    const good = structuredClone(bad);
    const model = good.providers.anthropic?.models[0];
    if (model) model.retiresOn = '2026-10-14';
    await storage.write('/cache/catalog.json', JSON.stringify(good));
    expect(await loadCachedManifest(storage, '/cache/catalog.json')).not.toBeNull();
  });
});

describe('rows whose vendor shutdown date has already passed are removed, not labelled', () => {
  it('drops both Groq Llama rows shut down on 2026-08-16 (console.groq.com/docs/deprecations)', () => {
    const groq = MODEL_CATALOG.filter((m) => m.providerId === 'groq').map((m) => m.modelId);
    expect(groq).not.toContain('llama-3.1-8b-instant');
    expect(groq).not.toContain('llama-3.3-70b-versatile');
    expect(groq).toContain('openai/gpt-oss-120b');
  });
});
