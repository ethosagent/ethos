// B-T6 — `complementExclude`, the helper that turns an allowlist of tool names
// into the `toolsetExclude` denylist `ToolFilterOpts` enforces. Pure, so these
// are plain table assertions; the end-to-end proof that the exclusion reaches
// MCP, plugin and `alwaysInclude` tools lives at
// `apps/ethos/src/commands/__tests__/serve-a2a-runner.test.ts`.

import { describe, expect, it } from 'vitest';
import { complementExclude } from '../tool-scope';

describe('complementExclude', () => {
  it('returns every registered name outside the allowlist', () => {
    expect(complementExclude(['read_file', 'write_file', 'web_search'], ['read_file'])).toEqual([
      'web_search',
      'write_file',
    ]);
  });

  it('excludes MCP, plugin and alwaysInclude-style names like any other — it only knows names', () => {
    expect(
      complementExclude(['read_file', 'mcp__x__y', 'brand_lookup', 'clarify'], ['read_file']),
    ).toEqual(['brand_lookup', 'clarify', 'mcp__x__y']);
  });

  it('excludes everything when the allowlist is empty (an empty grant is not a wide one)', () => {
    expect(complementExclude(['a', 'b'], [])).toEqual(['a', 'b']);
  });

  it('excludes nothing when the allowlist covers every registered name', () => {
    expect(complementExclude(['a', 'b'], ['b', 'a', 'c'])).toEqual([]);
  });

  it('ignores allowed names that are not registered — it computes an exclusion, not a grant', () => {
    expect(complementExclude(['a'], ['ghost_tool'])).toEqual(['a']);
  });

  it('is sorted and deduplicated, so registration order cannot move the result', () => {
    expect(complementExclude(['c', 'a', 'c', 'b'], [])).toEqual(['a', 'b', 'c']);
    expect(complementExclude(['a', 'b', 'c'], [])).toEqual(complementExclude(['c', 'b', 'a'], []));
  });

  it('accepts any iterable (a Set from a registry reach computation)', () => {
    expect(complementExclude(new Set(['a', 'b']), new Set(['a']))).toEqual(['b']);
  });

  it('does not mutate its inputs', () => {
    const registered = ['a', 'b'];
    const allowed = ['a'];
    complementExclude(registered, allowed);
    expect(registered).toEqual(['a', 'b']);
    expect(allowed).toEqual(['a']);
  });
});
