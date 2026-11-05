import { describe, expect, it } from 'vitest';
import { McpService } from '../../services/mcp.service';
import { catalogPresetIds } from '../../services/recipes.service';

// Phase 1 of the unified catalog derives the presets from the catalog index.
// mcp-catalog-golden.test.ts (frozen) pins the byte-level output; this file
// pins the id set that RecipesService reads, through the real
// `catalogPresetIds`.
const SIXTEEN = [
  'aws-knowledge',
  'asana',
  'context7',
  'deepwiki',
  'fetch',
  'filesystem',
  'git',
  'google-calendar',
  'granola',
  'linear',
  'memory',
  'microsoft-learn',
  'notion',
  'sentry',
  'vercel',
  'wolfram',
];

describe('mcp.catalog compat (recipes preset ids)', () => {
  it('catalogPresetIds returns the same 16 ids', () => {
    const ids = catalogPresetIds(McpService.prototype.catalog.call({}));
    expect(ids.sort()).toEqual([...SIXTEEN].sort());
  });
});
