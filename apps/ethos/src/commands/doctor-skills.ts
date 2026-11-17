import type { Skill } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Skill prerequisite check — reads `ethos.prerequisites.external_cli` from
// each bundled skill's frontmatter and verifies the binary is on PATH.
// `coding-agent` lists multiple CLI alternatives — at least one must be
// present (it routes to whichever is installed).
// ---------------------------------------------------------------------------

export interface SkillPrereqIssue {
  skill: string;
  cli: string;
}

export function readExternalCliRequirements(skill: Skill): { all: string[]; anyOf: string[] } {
  const ethos = skill.rawFrontmatter.ethos as
    | { prerequisites?: { external_cli?: unknown } }
    | undefined;
  const raw = ethos?.prerequisites?.external_cli;
  if (!Array.isArray(raw)) return { all: [], anyOf: [] };
  const all: string[] = [];
  const anyOf: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      all.push(item);
    } else if (item && typeof item === 'object' && 'any_of' in item) {
      const list = (item as { any_of: unknown }).any_of;
      if (Array.isArray(list)) {
        for (const candidate of list) {
          if (typeof candidate === 'string') anyOf.push(candidate);
        }
      }
    }
  }
  return { all, anyOf };
}
