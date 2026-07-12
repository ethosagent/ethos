import { sensitiveDenyPaths } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { ARGV_FS_DENY_PATTERNS } from '../guard';

// Parity: the process_start argv floor mirrors the terminal guard's and, like
// it, references a pattern-matched subset of the canonical manifest. Assert
// every referenced path is a manifest member and no entry is empty. Fails if
// this floor drifts a deny path off the manifest.
describe('deny-manifest parity — process argv floor', () => {
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
