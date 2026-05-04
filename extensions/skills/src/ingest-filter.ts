import type { IngestMode, PersonalityConfig, Skill } from '@ethosagent/types';

export interface FilterResult {
  include: boolean;
  reason: string;
}

/**
 * Decide whether a skill from the global pool should be visible to a
 * personality. Returns `{ include, reason }`.
 *
 * Mode resolution (when `skills.global_ingest.mode` is absent): `capability`.
 */
export function filterSkill(
  skill: Skill,
  personality: PersonalityConfig,
  toolNames: Set<string>,
  onWarn?: (msg: string) => void,
): FilterResult {
  const cfg = personality.skills?.global_ingest;
  const mode: IngestMode = cfg?.mode ?? 'capability';

  const allow = cfg?.allow ?? [];
  const deny = cfg?.deny ?? [];

  // Explicit deny always wins
  if (deny.includes(skill.qualifiedName)) {
    return { include: false, reason: 'explicit deny' };
  }
  // Explicit allow always wins (even in non-explicit mode)
  if (allow.includes(skill.qualifiedName)) {
    const reach = checkToolReach(skill, toolNames, onWarn, personality.id);
    if (reach) return reach;
    const permCheck = checkSkillPermissions(skill, personality, onWarn);
    if (permCheck) return permCheck;
    return { include: true, reason: 'explicit allow' };
  }

  switch (mode) {
    case 'none':
      return { include: false, reason: 'mode: none' };

    case 'explicit':
      return { include: false, reason: 'not in allow list (mode: explicit)' };

    case 'tags': {
      const acceptTags = cfg?.accept_tags ?? [];
      const rejectTags = cfg?.reject_tags ?? [];
      const skillTags = skill.tags ?? [];

      if (rejectTags.length > 0 && skillTags.some((t) => rejectTags.includes(t))) {
        return {
          include: false,
          reason: `tag rejected (${skillTags.filter((t) => rejectTags.includes(t)).join(', ')})`,
        };
      }
      if (acceptTags.length > 0 && !skillTags.some((t) => acceptTags.includes(t))) {
        return { include: false, reason: 'no accepted tags' };
      }
      const reach = checkToolReach(skill, toolNames, onWarn, personality.id);
      if (reach) return reach;
      const permCheck = checkSkillPermissions(skill, personality, onWarn);
      if (permCheck) return permCheck;
      return { include: true, reason: 'tags match' };
    }
    default:
      return capabilityCheck(
        skill,
        toolNames,
        cfg?.fallback_unknown ?? 'allow',
        onWarn,
        personality,
      );
  }
}

function capabilityCheck(
  skill: Skill,
  toolNames: Set<string>,
  fallback: string,
  onWarn: ((msg: string) => void) | undefined,
  personality: PersonalityConfig,
): FilterResult {
  // Merge top-level required_tools with permissions.tools_required
  const required = [...(skill.required_tools ?? []), ...(skill.permissions?.tools_required ?? [])];

  if (required.length === 0) {
    // Pure prose — no tool requirements declared
    if (fallback === 'deny') {
      return { include: false, reason: 'no required_tools declared (fallback: deny)' };
    }
    if (fallback === 'warn') {
      onWarn?.(
        `[boot] ${personality.id}: skill '${skill.qualifiedName}' has no required_tools — loading (fallback: warn)`,
      );
    }
    const permCheck = checkSkillPermissions(skill, personality, onWarn);
    if (permCheck) return permCheck;
    return { include: true, reason: 'no required_tools (pure prose)' };
  }

  const missing = required.filter((t) => !toolNames.has(t));
  if (missing.length > 0) {
    return {
      include: false,
      reason: `required_tools not in effective reach: ${missing.join(', ')}`,
    };
  }
  const permCheck = checkSkillPermissions(skill, personality, onWarn);
  if (permCheck) return permCheck;
  return { include: true, reason: 'capability match' };
}

/** When a skill is in the explicit allow list, still check tool reachability. */
function checkToolReach(
  skill: Skill,
  toolNames: Set<string>,
  onWarn: ((msg: string) => void) | undefined,
  personalityId: string,
): FilterResult | null {
  // Merge top-level required_tools with permissions.tools_required
  const required = [...(skill.required_tools ?? []), ...(skill.permissions?.tools_required ?? [])];
  if (required.length === 0) return null;

  const missing = required.filter((t) => !toolNames.has(t));
  if (missing.length > 0) {
    onWarn?.(
      `[boot] ${personalityId}: skill '${skill.qualifiedName}' allowed but requires tool '${missing[0]}' ` +
        `which is not reachable (not in toolset; not provided by any attached MCP server or plugin) — rejecting`,
    );
    return {
      include: false,
      reason: `required_tools not reachable: ${missing.join(', ')}`,
    };
  }
  return null;
}

/**
 * Returns the subset of `declared` values that are not covered by `policy`.
 *   policy === undefined/false → all declared values are disallowed
 *   policy === true            → all declared values are allowed
 *   policy === string[]        → only values in the list are allowed
 */
function disallowedValues(declared: string[], policy: string[] | boolean | undefined): string[] {
  if (!policy) return [...declared];
  if (policy === true) return [];
  return declared.filter((v) => !(policy as string[]).includes(v));
}

/**
 * Check declared skill permissions against the personality's safety policy.
 * Returns a FilterResult to reject the skill when a policy is configured and
 * the skill declares a value not covered by that policy. When no policy is
 * configured, warns only (backward compat).
 *
 * Enforcement is value-scoped: a policy of network: ['github.com'] blocks a
 * skill that also declares 'evil.com', rather than just blocking the whole
 * network category.
 */
function checkSkillPermissions(
  skill: Skill,
  personality: PersonalityConfig,
  onWarn?: (msg: string) => void,
): FilterResult | null {
  const perms = skill.permissions;
  if (!perms) return null;

  const personalityId = personality.id;
  const policy = personality.safety?.allowed_skill_permissions;
  const enforce = policy !== undefined;

  if (perms.fs_read && perms.fs_read.length > 0) {
    if (enforce) {
      const bad = disallowedValues(perms.fs_read, policy.fs_read);
      if (bad.length > 0) {
        return {
          include: false,
          reason: `declares fs_read for disallowed path(s): ${bad.join(', ')}`,
        };
      }
    }
    onWarn?.(
      `[boot] ${personalityId}: skill '${skill.qualifiedName}' declares fs_read: [${perms.fs_read.join(', ')}]`,
    );
  }
  if (perms.fs_write && perms.fs_write.length > 0) {
    if (enforce) {
      const bad = disallowedValues(perms.fs_write, policy.fs_write);
      if (bad.length > 0) {
        return {
          include: false,
          reason: `declares fs_write for disallowed path(s): ${bad.join(', ')}`,
        };
      }
    }
    onWarn?.(
      `[boot] ${personalityId}: skill '${skill.qualifiedName}' declares fs_write: [${perms.fs_write.join(', ')}]`,
    );
  }
  if (perms.network && perms.network.length > 0) {
    if (enforce) {
      const bad = disallowedValues(perms.network, policy.network);
      if (bad.length > 0) {
        return {
          include: false,
          reason: `declares network access to disallowed host(s): ${bad.join(', ')}`,
        };
      }
    }
    onWarn?.(
      `[boot] ${personalityId}: skill '${skill.qualifiedName}' declares network access: [${perms.network.join(', ')}]`,
    );
  }
  if (perms.mcp_env_passthrough && perms.mcp_env_passthrough.length > 0) {
    if (enforce) {
      const bad = disallowedValues(perms.mcp_env_passthrough, policy.mcp_env_passthrough);
      if (bad.length > 0) {
        return {
          include: false,
          reason: `declares mcp_env_passthrough for disallowed var(s): ${bad.join(', ')}`,
        };
      }
    }
    onWarn?.(
      `[boot] ${personalityId}: skill '${skill.qualifiedName}' requests MCP env passthrough: [${perms.mcp_env_passthrough.join(', ')}]`,
    );
  }
  return null;
}

/**
 * Validate a personality's allow list against the global pool.
 * Emits a warning for each listed name that doesn't exist in the pool.
 */
export function warnMissingAllowList(
  personalityId: string,
  allow: string[],
  pool: Map<string, unknown>,
  onWarn: (msg: string) => void,
): void {
  for (const name of allow) {
    if (!pool.has(name)) {
      onWarn(
        `[boot] ${personalityId}: skill '${name}' referenced but not found in any source — skipping`,
      );
    }
  }
}
