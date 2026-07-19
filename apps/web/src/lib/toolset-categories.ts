// Presentation-only category logic for the categorized toolset UI (Phase 2a,
// lane E3). The catalog RPC (`tools.catalog`) returns tools grouped by their
// `toolset` field, capitalized (first char upper). This module folds those
// groups into four user-facing categories and supplies the HONEST per-category
// boundary chip + details-drawer copy.
//
// The Execution category is deliberately special: it has NO static boundary
// label here. Its chip comes from the live, resolved posture
// (`postureBadge` in `execution-posture.ts`) so it never overclaims sandboxing
// — on a host with no Docker it reads "Un-sandboxed · runs on host", never a
// static "Sandboxed". Every other category is host-side and labelled honestly.
//
// Kept framework-free so it unit-tests as a plain `.test.ts` (apps/web has no
// DOM test harness).

export type ToolCategory = 'execution' | 'files-memory' | 'web-network' | 'other';

/** Display order for the categories in the UI. */
export const CATEGORY_ORDER: ToolCategory[] = ['execution', 'files-memory', 'web-network', 'other'];

/**
 * Every toolset group the catalog can emit (lowercase). The catalog capitalizes
 * the first char only; `categorizeGroup` lowercases before lookup. `other` is
 * the server's fallback group name for tools with no `toolset`.
 */
export const ALL_TOOLSET_GROUPS: readonly string[] = [
  'terminal',
  'process',
  'code',
  'test',
  'web',
  'browser',
  'file',
  'memory',
  'team_memory',
  'image',
  'vision',
  'voice',
  'meeting',
  'messaging',
  'delegation',
  'kanban',
  'goals',
  'dashboard',
  'cron',
  'skills',
  'skill_evolution',
  'todo',
  'ui',
  'interactive',
  'tier',
  'debug',
  'personality_design',
  'other',
];

/**
 * The presentation map: every group in `ALL_TOOLSET_GROUPS` has an entry. The
 * exhaustiveness test fails if a group is missing — a new toolset must declare
 * its category here (no silent miscategorization).
 */
export const GROUP_TO_CATEGORY: Record<string, ToolCategory> = {
  // Execution — routes through the execution backend; boundary is the live posture.
  terminal: 'execution',
  process: 'execution',
  code: 'execution',
  test: 'execution',
  // Files & Memory — confined to the personality's declared fs_reach.
  file: 'files-memory',
  memory: 'files-memory',
  team_memory: 'files-memory',
  // Web & Network — host-side egress via SafeFetch (not container-sandboxed).
  web: 'web-network',
  browser: 'web-network',
  // Other — host-side app integrations; each enforces its own limits.
  image: 'other',
  vision: 'other',
  voice: 'other',
  meeting: 'other',
  messaging: 'other',
  delegation: 'other',
  kanban: 'other',
  goals: 'other',
  dashboard: 'other',
  cron: 'other',
  skills: 'other',
  skill_evolution: 'other',
  todo: 'other',
  ui: 'other',
  interactive: 'other',
  tier: 'other',
  debug: 'other',
  personality_design: 'other',
  other: 'other',
};

/**
 * Fold a catalog group name onto its category. Case-insensitive (the catalog
 * capitalizes the first char). Unknown groups fall back to `other` rather than
 * throwing — the UI must render a tool even if its toolset is unrecognized.
 */
export function categorizeGroup(group: string): ToolCategory {
  return GROUP_TO_CATEGORY[group.toLowerCase()] ?? 'other';
}

/** A static boundary chip — icon paired with text (never colour-alone). */
export interface BoundaryChip {
  icon: string;
  label: string;
}

export interface CategoryMeta {
  id: ToolCategory;
  title: string;
  /**
   * Static boundary chip for the category. INTENTIONALLY undefined for
   * `execution` — its chip is the live posture badge, never a static string.
   */
  staticBoundary?: BoundaryChip;
}

export const CATEGORY_META: Record<ToolCategory, CategoryMeta> = {
  execution: {
    id: 'execution',
    title: 'Execution',
    // No staticBoundary — the live posture badge supplies the chip.
  },
  'files-memory': {
    id: 'files-memory',
    title: 'Files & Memory',
    staticBoundary: { icon: '▣', label: 'app-confined (fs_reach)' },
  },
  'web-network': {
    id: 'web-network',
    title: 'Web & Network',
    staticBoundary: { icon: '△', label: 'host · SafeFetch' },
  },
  other: {
    id: 'other',
    title: 'Other',
    staticBoundary: { icon: '○', label: 'host-side (app-confined)' },
  },
};

/** Details-drawer content for a category — what the tools touch + who enforces. */
export interface CategoryDetail {
  whatTheyTouch: string;
  enforcedBy: string;
  /** Extra honesty note (execution explains the no-Docker / consent path). */
  note?: string;
}

export function categoryDetail(id: ToolCategory): CategoryDetail {
  switch (id) {
    case 'execution':
      return {
        whatTheyTouch: 'Shell, code execution, processes, and tests.',
        enforcedBy:
          'OS-level container mounts when sandboxed; otherwise in-app limits on the host.',
        note: 'With no Docker, execution runs on the host only with explicit consent. The operator constitution can forbid host execution entirely. See the Execution tab for the live, resolved posture.',
      };
    case 'files-memory':
      return {
        whatTheyTouch: 'Reads and writes files and agent memory.',
        enforcedBy:
          "ScopedStorage — confined to the personality's declared filesystem reach (fs_reach).",
      };
    case 'web-network':
      return {
        whatTheyTouch: 'Fetches web pages and drives a headless browser.',
        enforcedBy: 'SafeFetch on the host — egress is filtered, not sandboxed in a container.',
      };
    case 'other':
      return {
        whatTheyTouch: 'Messaging, delegation, dashboards, skills, and other app integrations.',
        enforcedBy:
          'Run host-side within the app process; each integration enforces its own limits.',
      };
  }
}
