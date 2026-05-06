import { filterSkill } from '@ethosagent/skills';
import type { PersonalityConfig, Skill } from '@ethosagent/types';

/**
 * Derive the set of env var names that skill-requested MCP passthrough adds.
 * Only skills admitted by filterSkill for the given personality contribute —
 * rejected skills cannot leak their declared passthrough vars.
 */
export function deriveSkillPassthrough(
  skillPool: Map<string, Skill>,
  personality: PersonalityConfig,
  bootToolNames: Set<string>,
): Set<string> {
  const result = new Set<string>();
  for (const skill of skillPool.values()) {
    const decision = filterSkill(skill, personality, bootToolNames);
    if (!decision.include) continue;
    for (const v of skill.permissions?.mcp_env_passthrough ?? []) {
      result.add(v);
    }
  }
  return result;
}

/**
 * Apply a skill passthrough set to an MCP server config list.
 * When attachedServers is non-empty, only servers in that set receive the
 * extra passthrough — a skill requesting GITHUB_TOKEN cannot inject it into
 * an unrelated server the personality hasn't attached.
 */
export function applySkillPassthrough(
  rawMcpConfig: Array<{ name: string; mcpEnvPassthrough?: string[] }>,
  skillPassthrough: Set<string>,
  attachedServers: Set<string>,
): Array<{ name: string; mcpEnvPassthrough?: string[] }> {
  if (skillPassthrough.size === 0) return rawMcpConfig;
  return rawMcpConfig.map((cfg) => {
    // attachedServers is a whitelist: an empty set means the active personality
    // has no MCP server allowlist (wiring.ts warns "0 servers attached") and no
    // server should receive skill-requested credentials.
    if (!attachedServers.has(cfg.name)) return cfg;
    return {
      ...cfg,
      mcpEnvPassthrough: [...new Set([...(cfg.mcpEnvPassthrough ?? []), ...skillPassthrough])],
    };
  });
}
