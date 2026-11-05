// Data-free search over catalog entries, shared by the web and the CLI (D7).
// Imports no entry data, so it is safe in a browser bundle. Pinned by
// packages/catalog/src/__tests__/filter.test.ts.

import type { CatalogEntry, CatalogKind, CatalogTier } from '@ethosagent/types';

// Re-exported so apps can build a pinned argv without loading the entry data.
export { launcherArgs, type PackagePin, pinSpec } from './pin';

export interface CatalogFilter {
  kind?: CatalogKind;
  tier?: CatalogTier;
  /** Case-insensitive substring over id, name, description and publisher. */
  query?: string;
}

export function filterCatalog(
  entries: readonly CatalogEntry[],
  filter: CatalogFilter = {},
): CatalogEntry[] {
  const q = filter.query?.trim().toLowerCase() ?? '';
  return entries.filter((e) => {
    if (filter.kind !== undefined && e.kind !== filter.kind) return false;
    if (filter.tier !== undefined && e.tier !== filter.tier) return false;
    if (q === '') return true;
    return [e.id, e.name, e.description, e.publisher].some((f) => f.toLowerCase().includes(q));
  });
}
