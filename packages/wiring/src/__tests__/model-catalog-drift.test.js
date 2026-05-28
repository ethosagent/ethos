import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODEL_CATALOG } from '../model-catalog';
function readRemoteCatalog() {
    const catalogPath = join(import.meta.dirname, '..', '..', '..', '..', 'docs', 'static', 'api', 'model-catalog.json');
    return JSON.parse(readFileSync(catalogPath, 'utf-8'));
}
describe('model catalog drift guard', () => {
    it('bundled MODEL_CATALOG covers all remote catalog entries', () => {
        const manifest = readRemoteCatalog();
        // Map bundled entries by modelId for fast lookup
        const bundledIds = new Set(MODEL_CATALOG.map((e) => e.modelId));
        for (const [providerId, catalog] of Object.entries(manifest.providers)) {
            for (const model of catalog.models) {
                // OpenRouter entries (with (OR) suffix) in openai-compat may not be in bundled
                // since they're live-fetched. Only check non-OR entries.
                if (model.label.endsWith('(OR)'))
                    continue;
                expect(bundledIds.has(model.id), `Remote model "${model.id}" (provider: ${providerId}) missing from bundled MODEL_CATALOG`).toBe(true);
            }
        }
    });
    it('remote catalog has exactly 3 providers', () => {
        const manifest = readRemoteCatalog();
        expect(Object.keys(manifest.providers).sort()).toEqual(['anthropic', 'azure', 'openai-compat']);
    });
    it('remote catalog version is 1', () => {
        const manifest = readRemoteCatalog();
        expect(manifest.version).toBe(1);
    });
});
