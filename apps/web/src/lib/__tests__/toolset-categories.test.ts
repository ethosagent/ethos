import { describe, expect, it } from 'vitest';
import {
  ALL_TOOLSET_GROUPS,
  CATEGORY_META,
  CATEGORY_ORDER,
  categorizeGroup,
  categoryDetail,
  GROUP_TO_CATEGORY,
  type ToolCategory,
} from '../toolset-categories';

// Lane E3 — the category map is the contract the create wizard renders against.
// These tests lock the honest-boundary rule (Execution has no static chip) and
// the exhaustiveness gate (a new toolset group must declare its category).

describe('toolset categories', () => {
  it('CATEGORY_ORDER lists all four categories exactly once', () => {
    const expected: ToolCategory[] = ['execution', 'files-memory', 'web-network', 'other'];
    expect([...CATEGORY_ORDER].sort()).toEqual([...expected].sort());
    expect(new Set(CATEGORY_ORDER).size).toBe(CATEGORY_ORDER.length);
  });

  it('every known toolset group declares a category (exhaustive — fails if a group is unmapped)', () => {
    for (const group of ALL_TOOLSET_GROUPS) {
      expect(GROUP_TO_CATEGORY[group], `group "${group}" is missing from GROUP_TO_CATEGORY`).toBeDefined();
    }
  });

  it('categorizeGroup is case-insensitive and folds onto a known category', () => {
    expect(categorizeGroup('terminal')).toBe('execution');
    expect(categorizeGroup('Terminal')).toBe('execution'); // catalog capitalizes the first char
    expect(categorizeGroup('Memory')).toBe('files-memory');
    expect(categorizeGroup('Web')).toBe('web-network');
    expect(categorizeGroup('Kanban')).toBe('other');
  });

  it('an unknown group falls back to "other" rather than throwing', () => {
    expect(categorizeGroup('some_future_group')).toBe('other');
  });

  it('the execution code group (run_tests/lint live here) folds to execution', () => {
    // run_tests/lint ship in the `test`/`code` toolset groups — both must be execution.
    expect(categorizeGroup('code')).toBe('execution');
    expect(categorizeGroup('test')).toBe('execution');
    expect(categorizeGroup('process')).toBe('execution');
  });

  it('Execution category has NO static boundary chip — it uses the live posture (honest)', () => {
    expect(CATEGORY_META.execution.staticBoundary).toBeUndefined();
  });

  it('host-side categories carry an honest static boundary chip (icon + text)', () => {
    for (const id of ['files-memory', 'web-network', 'other'] as ToolCategory[]) {
      const chip = CATEGORY_META[id].staticBoundary;
      expect(chip, `${id} should have a static boundary chip`).toBeDefined();
      expect(chip?.icon.length).toBeGreaterThan(0);
      expect(chip?.label.length).toBeGreaterThan(0);
    }
    expect(CATEGORY_META['files-memory'].staticBoundary?.label).toMatch(/fs_reach/);
    expect(CATEGORY_META['web-network'].staticBoundary?.label).toMatch(/SafeFetch/);
  });

  it('categoryDetail returns drawer copy for every category; execution explains the no-Docker path', () => {
    for (const id of CATEGORY_ORDER) {
      const detail = categoryDetail(id);
      expect(detail.whatTheyTouch.length).toBeGreaterThan(0);
      expect(detail.enforcedBy.length).toBeGreaterThan(0);
    }
    expect(categoryDetail('execution').note).toMatch(/consent|constitution|host/i);
  });
});
