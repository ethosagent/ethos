import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mcpCatalogPresetIds } from '../../services/recipes.service';

// The unified catalog derives the presets from the index.
// mcp-catalog-golden.test.ts (frozen) pins the byte-level `mcp.catalog`
// output; this pins the id list RecipesService reads against the same golden.
const golden = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'fixtures', 'mcp-catalog-golden.json'), 'utf8'),
) as { remote: Array<{ name: string }>; local: Array<{ name: string }> };

describe('mcp.catalog compat (recipes preset ids)', () => {
  it('mcpCatalogPresetIds equals the golden ids, remote then local, sorted', () => {
    const byName = (a: string, b: string) => a.localeCompare(b);
    expect(mcpCatalogPresetIds()).toEqual([
      ...golden.remote.map((p) => p.name).sort(byName),
      ...golden.local.map((p) => p.name).sort(byName),
    ]);
    expect(mcpCatalogPresetIds()).toHaveLength(16);
  });
});
