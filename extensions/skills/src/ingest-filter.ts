import type { IngestMode, PersonalityConfig, Skill } from '@ethosagent/types';
import { checkSkillEnv, type EnvResolverOptions } from './env-resolver';

export interface FilterResult {
  include: boolean;
  reason: string;
}

/**
 * E2 — module-level test seam for env resolution. Production passes
 * `undefined` (uses `process.env` + real `which`); tests inject deterministic
 * env/which by setting this with `setEnvResolverOptions`.
 */
let envResolverOpts: EnvResolverOptions | undefined;
export function setEnvResolverOptions(opts: EnvResolverOptions | undefined): void {
  envResolverOpts = opts;
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
    const fallback = checkFallbackForTools(skill, toolNames);
    if (fallback) return fallback;
    const envCheck = checkEnv(skill, onWarn, personality.id);
    if (envCheck) return envCheck;
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
      const fallback = checkFallbackForTools(skill, toolNames);
      if (fallback) return fallback;
      const envCheck = checkEnv(skill, onWarn, personality.id);
      if (envCheck) return envCheck;
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
    const fallbackCheck = checkFallbackForTools(skill, toolNames);
    if (fallbackCheck) return fallbackCheck;
    const envCheck = checkEnv(skill, onWarn, personality.id);
    if (envCheck) return envCheck;
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
  const fallbackCheck = checkFallbackForTools(skill, toolNames);
  if (fallbackCheck) return fallbackCheck;
  const envCheck = checkEnv(skill, onWarn, personality.id);
  if (envCheck) return envCheck;
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
 * E2 — `ethos.env_required` + `ethos.external_cli_alternatives` gate.
 *
 * Hard requirement: when env vars are unset OR no CLI alternative resolves,
 * the skill is filtered out and a warning is emitted so the operator can fix
 * it. Skills declaring neither field skip the check entirely.
 *
 * Returns null when the env is satisfied (or the skill declares no env
 * dependencies). Returns a FilterResult when the skill should be excluded.
 */
function checkEnv(
  skill: Skill,
  onWarn: ((msg: string) => void) | undefined,
  personalityId: string,
): FilterResult | null {
  const hasEnvDecl = (skill.env_required?.length ?? 0) > 0;
  const hasCliDecl = (skill.external_cli_alternatives?.length ?? 0) > 0;
  if (!hasEnvDecl && !hasCliDecl) return null;
  const result = checkSkillEnv(skill, envResolverOpts);
  if (result.ok) return null;
  const parts: string[] = [];
  if (result.missingEnv.length > 0) parts.push(`env unset: ${result.missingEnv.join(', ')}`);
  if (result.missingCli.length > 0) {
    parts.push(`no CLI on PATH from: ${result.missingCli.join(' / ')}`);
  }
  const reason = `env_required not satisfied — ${parts.join('; ')}`;
  onWarn?.(`[boot] ${personalityId}: skill '${skill.qualifiedName}' filtered — ${reason}`);
  return { include: false, reason };
}

/**
 * E1 — `ethos.fallback_for_tools` activation gate. The skill is intended as
 * a graceful-degradation fallback: it activates ONLY when ALL listed tools
 * are absent from the personality's effective tool reach. If any one of
 * them is present, the skill is filtered out so the primary (tool-using)
 * skill takes precedence.
 *
 * Returns null when the skill does not declare `fallback_for_tools`, or
 * when every listed tool is absent (skill should be included).
 */
function checkFallbackForTools(skill: Skill, toolNames: Set<string>): FilterResult | null {
  const fallbackFor = skill.fallback_for_tools ?? [];
  if (fallbackFor.length === 0) return null;
  const present = fallbackFor.filter((t) => toolNames.has(t));
  if (present.length > 0) {
    return {
      include: false,
      reason: `fallback_for_tools active: tool(s) present (${present.join(', ')})`,
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
