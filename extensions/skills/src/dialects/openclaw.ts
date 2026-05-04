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

const META_KEYS = ['openclaw', 'clawdbot', 'clawdis'] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Detect OpenClaw format: `metadata.{openclaw|clawdbot|clawdis}` block present. */
export function canParse(data: Record<string, unknown>): boolean {
  if (!isRecord(data.metadata)) return false;
  return META_KEYS.some((k) => isRecord((data.metadata as Record<string, unknown>)[k]));
}

/**
 * Parse an OpenClaw / ClawHub skill file.
 * Returns null if the content is empty or the OpenClaw block is absent.
 */
export function parseOpenClaw(
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
    : undefined;

  return {
    name: displayName,
    source,
    filePath,
    body: content.trim() || raw,
    tags: tags && tags.length > 0 ? tags : undefined,
    rawFrontmatter: data as Record<string, unknown>,
    dialect: 'openclaw',
    mtimeMs,
    permissions: parseEthosPermissions(data),
  };
}
