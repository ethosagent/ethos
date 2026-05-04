import type { Skill, SkillPermissions } from '@ethosagent/types';
import matter from 'gray-matter';

function parseEthosPermissions(data: Record<string, unknown>): SkillPermissions | undefined {
  const ethos = data.ethos;
  if (typeof ethos !== 'object' || ethos === null || Array.isArray(ethos)) return undefined;
  const perms = (ethos as Record<string, unknown>).permissions;
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

/** Detect Hermes format: top-level `agent`, `category`, or `version` key. */
export function canParse(data: Record<string, unknown>): boolean {
  return (
    typeof data.agent === 'string' ||
    typeof data.category === 'string' ||
    (typeof data.version === 'string' && Object.keys(data).length > 1)
  );
}

/**
 * Parse a Hermes Skills Hub skill file.
 */
export function parseHermes(
  raw: string,
  filePath: string,
  source: string,
  name: string,
  mtimeMs: number,
): Omit<Skill, 'qualifiedName'> | null {
  const { data, content } = matter(raw);
  if (Object.keys(data).length === 0) return null;

  const displayName = typeof data.name === 'string' ? data.name : (name as string);

  const tags = Array.isArray(data.tags)
    ? data.tags.filter((t): t is string => typeof t === 'string')
    : typeof data.category === 'string'
      ? [data.category]
      : undefined;

  const required_tools = Array.isArray(data.required_tools)
    ? data.required_tools.filter((t): t is string => typeof t === 'string')
    : undefined;

  return {
    name: displayName,
    source,
    filePath,
    body: content.trim() || raw,
    tags: tags && tags.length > 0 ? tags : undefined,
    required_tools: required_tools && required_tools.length > 0 ? required_tools : undefined,
    rawFrontmatter: data as Record<string, unknown>,
    dialect: 'hermes',
    mtimeMs,
    permissions: parseEthosPermissions(data),
  };
}
