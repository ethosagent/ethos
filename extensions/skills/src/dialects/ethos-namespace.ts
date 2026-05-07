// Shared parsers for the `ethos:` frontmatter namespace. The dialect
// modules (agentskills / openclaw / hermes) call these so the namespace
// shape is identical regardless of which top-level dialect produced the
// rest of the frontmatter.

import type { SkillEnvRef, SkillPermissions } from '@ethosagent/types';

function getEthosBlock(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const ethos = data.ethos;
  if (typeof ethos !== 'object' || ethos === null || Array.isArray(ethos)) return undefined;
  return ethos as Record<string, unknown>;
}

export function parseEthosPermissions(data: Record<string, unknown>): SkillPermissions | undefined {
  const ethos = getEthosBlock(data);
  if (!ethos) return undefined;
  const perms = ethos.permissions;
  if (typeof perms !== 'object' || perms === null || Array.isArray(perms)) return undefined;
  const p = perms as Record<string, unknown>;
  const result: SkillPermissions = {};
  if (Array.isArray(p.fs_read))
    result.fs_read = p.fs_read.filter((x): x is string => typeof x === 'string');
  if (Array.isArray(p.fs_write))
    result.fs_write = p.fs_write.filter((x): x is string => typeof x === 'string');
  if (Array.isArray(p.network))
    result.network = p.network.filter((x): x is string => typeof x === 'string');
  if (Array.isArray(p.tools_required))
    result.tools_required = p.tools_required.filter((x): x is string => typeof x === 'string');
  if (Array.isArray(p.mcp_env_passthrough))
    result.mcp_env_passthrough = p.mcp_env_passthrough.filter(
      (x): x is string => typeof x === 'string',
    );
  return Object.keys(result).length > 0 ? result : undefined;
}

export function parseEthosFallbackForTools(data: Record<string, unknown>): string[] | undefined {
  const ethos = getEthosBlock(data);
  if (!ethos) return undefined;
  const raw = ethos.fallback_for_tools;
  if (!Array.isArray(raw)) return undefined;
  const list = raw.filter((x): x is string => typeof x === 'string');
  return list.length > 0 ? list : undefined;
}

function parseEnvRefList(raw: unknown): SkillEnvRef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: SkillEnvRef[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      out.push({ name: item });
    } else if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      const obj = item as Record<string, unknown>;
      const name = obj.name;
      if (typeof name !== 'string' || name.length === 0) continue;
      const description = typeof obj.description === 'string' ? obj.description : undefined;
      out.push(description !== undefined ? { name, description } : { name });
    }
  }
  return out.length > 0 ? out : undefined;
}

export function parseEthosEnvRequired(data: Record<string, unknown>): SkillEnvRef[] | undefined {
  const ethos = getEthosBlock(data);
  if (!ethos) return undefined;
  return parseEnvRefList(ethos.env_required);
}

export function parseEthosEnvOptional(data: Record<string, unknown>): SkillEnvRef[] | undefined {
  const ethos = getEthosBlock(data);
  if (!ethos) return undefined;
  return parseEnvRefList(ethos.env_optional);
}

export function parseEthosExternalCliAlternatives(
  data: Record<string, unknown>,
): string[] | undefined {
  const ethos = getEthosBlock(data);
  if (!ethos) return undefined;
  const raw = ethos.external_cli_alternatives;
  if (!Array.isArray(raw)) return undefined;
  const list = raw.filter((x): x is string => typeof x === 'string');
  return list.length > 0 ? list : undefined;
}
