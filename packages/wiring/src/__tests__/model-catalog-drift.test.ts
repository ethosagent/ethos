import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelCatalogManifest } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { MODEL_CATALOG } from '../model-catalog';

describe('model catalog drift guard', () => {
  it('bundled MODEL_CATALOG covers all remote catalog entries', () => {
    const catalogPath = join(
      import.meta.dirname,
      '..',
      '..',
      '..',
      '..',
      'docs',
      'static',
      'api',
      'model-catalog.json',
    );
    const raw = readFileSync(catalogPath, 'utf-8');
    const manifest = JSON.parse(raw) as ModelCatalogManifest;

    // Map bundled entries by modelId for fast lookup
    const bundledIds = new Set(MODEL_CATALOG.map((e) => e.modelId));

    for (const [providerId, catalog] of Object.entries(manifest.providers)) {
      for (const model of catalog.models) {
        // OpenRouter entries (with (OR) suffix) in openai-compat may not be in bundled
        // since they're live-fetched. Only check non-OR entries.
        if (model.label.endsWith('(OR)')) continue;

        expect(
          bundledIds.has(model.id),
          `Remote model "${model.id}" (provider: ${providerId}) missing from bundled MODEL_CATALOG`,
        ).toBe(true);
      }
    }
  });

  it('remote catalog has exactly 3 providers', () => {
    const catalogPath = join(
      import.meta.dirname,
      '..',
      '..',
      '..',
      '..',
      'docs',
      'static',
      'api',
      'model-catalog.json',
    );
    const raw = readFileSync(catalogPath, 'utf-8');
    const manifest = JSON.parse(raw) as ModelCatalogManifest;

    expect(Object.keys(manifest.providers).sort()).toEqual(['anthropic', 'azure', 'openai-compat']);
  });

  it('remote catalog version is 1', () => {
    const catalogPath = join(
      import.meta.dirname,
      '..',
      '..',
      '..',
      '..',
      'docs',
      'static',
      'api',
      'model-catalog.json',
    );
    const raw = readFileSync(catalogPath, 'utf-8');
    const manifest = JSON.parse(raw) as ModelCatalogManifest;

    expect(manifest.version).toBe(1);
  });
});
