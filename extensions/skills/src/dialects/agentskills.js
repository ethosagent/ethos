import matter from 'gray-matter';
import {
  parseEthosEnvOptional,
  parseEthosEnvRequired,
  parseEthosExternalCliAlternatives,
  parseEthosFallbackForTools,
  parseEthosPermissions,
} from './ethos-namespace';
/** Detect agentskills.io standard: `required_tools` or `tags` at the top level. */
export function canParse(data) {
  return (
    Array.isArray(data.required_tools) ||
    Array.isArray(data.tags) ||
    typeof data.description === 'string'
  );
}
/**
 * Parse an agentskills.io skill file.
 * Returns null when frontmatter is absent or the file is empty.
 */
export function parseAgentSkills(raw, filePath, source, name, mtimeMs) {
  const { data, content } = matter(raw);
  const body = content.trim();
  if (Object.keys(data).length === 0 && body.length === 0) return null;
  const displayName = typeof data.name === 'string' ? data.name : name;
  const tags = Array.isArray(data.tags)
    ? data.tags.filter((t) => typeof t === 'string')
    : undefined;
  const required_tools = Array.isArray(data.required_tools)
    ? data.required_tools.filter((t) => typeof t === 'string')
    : undefined;
  return {
    name: displayName,
    source,
    filePath,
    body: body || raw,
    tags: tags && tags.length > 0 ? tags : undefined,
    required_tools: required_tools && required_tools.length > 0 ? required_tools : undefined,
    fallback_for_tools: parseEthosFallbackForTools(data),
    env_required: parseEthosEnvRequired(data),
    env_optional: parseEthosEnvOptional(data),
    external_cli_alternatives: parseEthosExternalCliAlternatives(data),
    rawFrontmatter: data,
    dialect: 'agentskills',
    mtimeMs,
    permissions: parseEthosPermissions(data),
  };
}
