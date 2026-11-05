// The unified catalog index. One TS file per entry under ./entries/<kind>/,
// listed by the hand-kept barrel ./entries/index.ts (the barrel-vs-directory
// match is pinned by __tests__/index.test.ts).

import type { CatalogEntry, CatalogKind } from '@ethosagent/types';
import { CATALOG_ENTRIES } from './entries';

export { launcherArgs, type PackagePin, pinSpec } from './pin';
export { CATALOG_ENTRIES };

export function getCatalogEntry(id: string): CatalogEntry | undefined {
  return CATALOG_ENTRIES.find((e) => e.id === id);
}

export function catalogEntriesOfKind(kind: CatalogKind): readonly CatalogEntry[] {
  return CATALOG_ENTRIES.filter((e) => e.kind === kind);
}
