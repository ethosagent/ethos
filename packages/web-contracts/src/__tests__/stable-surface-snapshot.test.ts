import { describe, expect, it } from 'vitest';
import { contract } from '../router';

// ---------------------------------------------------------------------------
// Stable-surface guard — these namespaces are tagged `@stable v1` in
// router.ts. This test fails if any stable procedure is removed or renamed.
// Adding new procedures is fine (the check uses `toContain`, not exact
// equality).
// ---------------------------------------------------------------------------

const STABLE_SURFACE: Record<string, string[]> = {
  sessions: ['list', 'get', 'fork', 'delete', 'update'],
  chat: ['send', 'abort'],
  personalities: ['list', 'get', 'characterSheet'],
  memory: ['list', 'get', 'write'],
  meta: ['capabilities'],
};

describe('stable surface', () => {
  for (const [ns, expectedProcedures] of Object.entries(STABLE_SURFACE)) {
    describe(ns, () => {
      const actualKeys = Object.keys(contract[ns as keyof typeof contract]);

      for (const proc of expectedProcedures) {
        it(`has procedure "${proc}"`, () => {
          expect(actualKeys).toContain(proc);
        });
      }
    });
  }
});
