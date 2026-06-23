import { describe, expect, it } from 'vitest';

/**
 * Mirrors the toolset-narrowing logic in turn-setup.ts (line ~112).
 * Kept in sync manually — the source of truth is the stage function.
 */
function computeAllowedTools(
  toolsetOverride: string[] | undefined,
  personalityToolset: string[] | undefined,
  toolsetNarrow: string[] | undefined,
): string[] | undefined {
  const baseToolset = toolsetOverride ?? personalityToolset ?? undefined;
  const narrow = toolsetNarrow;
  return narrow && baseToolset
    ? baseToolset.filter(t => narrow.includes(t))
    : narrow ?? baseToolset;
}

describe('toolsetNarrow intersection', () => {
  it('intersects narrow with personality toolset', () => {
    const result = computeAllowedTools(undefined, ['a', 'b', 'c'], ['b', 'c', 'd']);
    expect(result).toEqual(['b', 'c']);
  });

  it('returns narrow when no personality toolset', () => {
    const result = computeAllowedTools(undefined, undefined, ['x', 'y']);
    expect(result).toEqual(['x', 'y']);
  });

  it('returns personality toolset when no narrow', () => {
    const result = computeAllowedTools(undefined, ['a', 'b'], undefined);
    expect(result).toEqual(['a', 'b']);
  });

  it('returns undefined when neither set', () => {
    const result = computeAllowedTools(undefined, undefined, undefined);
    expect(result).toBeUndefined();
  });

  it('intersects narrow with toolsetOverride (override replaces personality)', () => {
    const result = computeAllowedTools(['x', 'y', 'z'], ['a', 'b'], ['y', 'z', 'w']);
    expect(result).toEqual(['y', 'z']);
  });

  it('returns empty array when intersection is empty', () => {
    const result = computeAllowedTools(undefined, ['a', 'b'], ['c', 'd']);
    expect(result).toEqual([]);
  });
});
