import matter from 'gray-matter';
import {
  parseEthosEnvOptional,
  parseEthosEnvRequired,
  parseEthosExternalCliAlternatives,
  parseEthosFallbackForTools,
  parseEthosPermissions,
} from './ethos-namespace';

const META_KEYS = ['openclaw', 'clawdbot', 'clawdis'];
function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
/** Detect OpenClaw format: `metadata.{openclaw|clawdbot|clawdis}` block present. */
export function canParse(data) {
  if (!isRecord(data.metadata)) return false;
  return META_KEYS.some((k) => isRecord(data.metadata[k]));
}
/**
 * Parse an OpenClaw / ClawHub skill file.
 * Returns null if the content is empty or the OpenClaw block is absent.
 */
export function parseOpenClaw(raw, filePath, source, name, mtimeMs) {
  const { data, content } = matter(raw);
  if (Object.keys(data).length === 0) return null;
  const displayName = typeof data.name === 'string' ? data.name : name;
  const tags = Array.isArray(data.tags)
    ? data.tags.filter((t) => typeof t === 'string')
    : undefined;
  return {
    name: displayName,
    source,
    filePath,
    body: content.trim() || raw,
    tags: tags && tags.length > 0 ? tags : undefined,
    fallback_for_tools: parseEthosFallbackForTools(data),
    env_required: parseEthosEnvRequired(data),
    env_optional: parseEthosEnvOptional(data),
    external_cli_alternatives: parseEthosExternalCliAlternatives(data),
    rawFrontmatter: data,
    dialect: 'openclaw',
    mtimeMs,
    permissions: parseEthosPermissions(data),
  };
}
