import { sensitiveDenyPaths } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { ARGV_FS_DENY_PATTERNS } from '../guard';

// Parity: the argv floor is a pattern-matched subset of the canonical
// manifest. It cannot safely cover every manifest path in an arbitrary shell
// string, so we assert the honest invariant — every path it references is a
// manifest member (no orphan/drifted deny path), and no entry is empty. Fails
// if the terminal guard invents a deny path the manifest does not list.
describe('deny-manifest parity — terminal argv floor', () => {
  const manifest = new Set(sensitiveDenyPaths());

  it('every argv deny entry references at least one manifest path', () => {
    for (const entry of ARGV_FS_DENY_PATTERNS) {
      expect(entry.paths.length).toBeGreaterThan(0);
    }
  });

  it('every argv-referenced path is a member of the canonical manifest', () => {
    for (const entry of ARGV_FS_DENY_PATTERNS) {
      for (const path of entry.paths) {
        expect(manifest.has(path)).toBe(true);
      }
    }
  });
});
