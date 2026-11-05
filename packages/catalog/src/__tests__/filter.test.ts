import type { CatalogEntry } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { filterCatalog } from '../filter';
import { CATALOG_ENTRIES } from '../index';

const base: Omit<CatalogEntry, 'id' | 'name' | 'description' | 'publisher' | 'kind' | 'tier'> = {
  category: 'Utilities',
  pin: { type: 'remote', url: 'https://example.test/mcp', transport: 'streamable-http' },
  capabilities: { network: [], auth: 'none', env: [], filesystem: 'none', shell: false },
  license: null,
  reviewedAt: '2026-11-05',
};
const entry = (over: Partial<CatalogEntry> & Pick<CatalogEntry, 'id'>): CatalogEntry => ({
  ...base,
  name: over.id,
  description: '',
  publisher: '',
  kind: 'mcp',
  tier: 'verified',
  ...over,
});

const ENTRIES = [
  entry({ id: 'alpha', name: 'Alpha Tool', description: 'reads calendars', publisher: 'Acme' }),
  entry({
    id: 'beta',
    name: 'Beta',
    description: 'writes notes',
    publisher: 'Initech',
    tier: 'community',
  }),
  entry({
    id: 'gamma',
    name: 'Gamma',
    description: 'plugin thing',
    publisher: 'Ethos',
    kind: 'plugin',
    tier: 'official',
  }),
];
const ids = (xs: CatalogEntry[]) => xs.map((e) => e.id);

describe('filterCatalog', () => {
  it('matches id, name, description and publisher, case-insensitively', () => {
    expect(ids(filterCatalog(ENTRIES, { query: 'BETA' }))).toEqual(['beta']);
    expect(ids(filterCatalog(ENTRIES, { query: 'alpha tool' }))).toEqual(['alpha']);
    expect(ids(filterCatalog(ENTRIES, { query: 'CALENDARS' }))).toEqual(['alpha']);
    expect(ids(filterCatalog(ENTRIES, { query: 'initech' }))).toEqual(['beta']);
  });

  it('filters by kind and by tier', () => {
    expect(ids(filterCatalog(ENTRIES, { kind: 'plugin' }))).toEqual(['gamma']);
    expect(ids(filterCatalog(ENTRIES, { tier: 'community' }))).toEqual(['beta']);
    expect(ids(filterCatalog(ENTRIES, { kind: 'mcp', tier: 'official' }))).toEqual([]);
  });

  it('an empty or blank query, or no filter, returns everything in order', () => {
    expect(ids(filterCatalog(ENTRIES))).toEqual(['alpha', 'beta', 'gamma']);
    expect(ids(filterCatalog(ENTRIES, { query: '' }))).toEqual(['alpha', 'beta', 'gamma']);
    expect(ids(filterCatalog(ENTRIES, { query: '   ' }))).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('does not mutate its input', () => {
    const copy = [...ENTRIES];
    filterCatalog(ENTRIES, { query: 'beta' });
    expect(ENTRIES).toEqual(copy);
  });

  it('finds real seed entries by publisher', () => {
    const hits = filterCatalog(CATALOG_ENTRIES, { query: 'model context protocol' });
    expect(ids(hits).sort()).toEqual(['fetch', 'filesystem', 'git', 'memory']);
  });
});
