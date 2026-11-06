// Pure-logic coverage for `apps/web/src/features/mcp/catalog.ts` — relocated
// out of `AddMcpModal.tsx` (plan/phases/mcp-inline-catalog.md §2.1/§6 step 1)
// so both `AddMcpModal`'s Preset mode and the new `CatalogBrowser` can
// import the same functions without one depending on the other's component
// file. `authBadgeLabel` and `buildRemoteSubmission`'s coverage moved here
// from `components/mcp/__tests__/AddMcpModal.test.ts` unchanged; `groupByCategory`
// gets direct unit coverage for the first time (previously exercised only
// indirectly through `AddMcpModal`'s rendered Select grouping).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { catalogEntriesOfKind } from '@ethosagent/catalog';
import type { CatalogEntryInfo, McpRemotePresetInfo } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import {
  authBadgeLabel,
  buildRemoteSubmission,
  groupByCategory,
  presetsFromCatalog,
} from '../catalog';

const WOLFRAM: McpRemotePresetInfo = {
  name: 'wolfram',
  label: 'Wolfram',
  url: 'https://mcp.wolframalpha.com/mcp',
  transport: 'streamable-http',
  authType: 'bearer',
  description: 'Computational knowledge queries',
  category: 'Docs & knowledge',
};

describe('authBadgeLabel', () => {
  it('maps every authType to its badge copy', () => {
    expect(authBadgeLabel('oauth')).toBe('OAuth');
    expect(authBadgeLabel('none')).toBe('No auth');
    expect(authBadgeLabel('bearer')).toBe('API key');
  });
});

describe('groupByCategory', () => {
  it('buckets items by category, preserving first-seen category order', () => {
    const groups = groupByCategory([
      { category: 'B', name: '1' },
      { category: 'A', name: '2' },
      { category: 'B', name: '3' },
    ]);
    expect(groups.map((g) => g.category)).toEqual(['B', 'A']);
    expect(groups.find((g) => g.category === 'B')?.items.map((i) => i.name)).toEqual(['1', '3']);
    expect(groups.find((g) => g.category === 'A')?.items.map((i) => i.name)).toEqual(['2']);
  });

  it('returns an empty list for an empty input', () => {
    expect(groupByCategory([])).toEqual([]);
  });
});

describe('buildRemoteSubmission', () => {
  it('oauth preset submits { url } for mcp.start, no name', () => {
    const preset: McpRemotePresetInfo = { ...WOLFRAM, authType: 'oauth' };
    expect(buildRemoteSubmission(preset, '')).toEqual({
      kind: 'oauth',
      input: { url: preset.url },
    });
  });

  it('no-auth preset submits addServer with authType none and no token', () => {
    const preset: McpRemotePresetInfo = { ...WOLFRAM, authType: 'none' };
    expect(buildRemoteSubmission(preset, '')).toEqual({
      kind: 'addServer',
      input: {
        name: preset.name,
        url: preset.url,
        transport: 'streamable-http',
        authType: 'none',
      },
    });
  });

  it('bearer preset includes a typed, trimmed token', () => {
    expect(buildRemoteSubmission(WOLFRAM, '  sk-test  ')).toEqual({
      kind: 'addServer',
      input: {
        name: 'wolfram',
        url: 'https://mcp.wolframalpha.com/mcp',
        transport: 'streamable-http',
        authType: 'bearer',
        token: 'sk-test',
      },
    });
  });

  it('omits a bearer token that was left blank', () => {
    expect(buildRemoteSubmission(WOLFRAM, '   ')).toEqual({
      kind: 'addServer',
      input: {
        name: 'wolfram',
        url: 'https://mcp.wolframalpha.com/mcp',
        transport: 'streamable-http',
        authType: 'bearer',
      },
    });
  });
});

describe('presetsFromCatalog', () => {
  // The output `mcp.catalog` served at Phase 0, frozen by web-api's
  // mcp-catalog-golden.test.ts. The modal and Connectors step consumed exactly
  // these fields, so the adapter must reproduce them from the catalog entries.
  const golden = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(
          '../../../../../web-api/src/__tests__/fixtures/mcp-catalog-golden.json',
          import.meta.url,
        ),
      ),
      'utf8',
    ),
  ) as { remote: unknown[]; local: unknown[] };

  it('reproduces the 11 remote and 5 local presets of mcp.catalog, in the same order', () => {
    const out = presetsFromCatalog(catalogEntriesOfKind('mcp') as readonly CatalogEntryInfo[]);
    expect(out.remote).toHaveLength(11);
    expect(out.local).toHaveLength(5);
    expect(out.remote).toEqual(golden.remote);
    expect(out.local).toEqual(golden.local);
  });

  it('skips non-mcp kinds and env-auth remotes', () => {
    const [first] = catalogEntriesOfKind('mcp') as readonly CatalogEntryInfo[];
    if (!first) throw new Error('catalog has no mcp entry');
    const plugin = { ...first, kind: 'plugin' as const };
    const env = {
      ...first,
      pin: { type: 'remote' as const, url: 'https://x', transport: 'streamable-http' as const },
      capabilities: { ...first.capabilities, auth: 'env' as const },
    };
    expect(presetsFromCatalog([plugin, env])).toEqual({ remote: [], local: [] });
  });
});
