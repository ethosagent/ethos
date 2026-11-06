// Where catalog skills live under the data dir (unified-catalog D16). Defined
// once so the web-api's installed check and Phase 3's installer agree. Pinned
// by packages/catalog/src/__tests__/install-args.test.ts.

import { join } from 'node:path';

export const CATALOG_SKILLS_DIR = 'catalog-skills';

/** `<dataDir>/catalog-skills`: the directory the `catalog` skill source scans (extensions/skills/src/compose.ts). */
export function catalogSkillsRoot(dataDir: string): string {
  return join(dataDir, CATALOG_SKILLS_DIR);
}

export function catalogSkillPath(dataDir: string, id: string): string {
  return join(catalogSkillsRoot(dataDir), id);
}
