import matter from 'gray-matter';
import { parseEthosEnvOptional, parseEthosEnvRequired, parseEthosExternalCliAlternatives, parseEthosFallbackForTools, parseEthosPermissions, } from './ethos-namespace';
/** Detect Hermes format: top-level `agent`, `category`, or `version` key. */
export function canParse(data) {
    return (typeof data.agent === 'string' ||
        typeof data.category === 'string' ||
        (typeof data.version === 'string' && Object.keys(data).length > 1));
}
/**
 * Parse a Hermes Skills Hub skill file.
 */
export function parseHermes(raw, filePath, source, name, mtimeMs) {
    const { data, content } = matter(raw);
    if (Object.keys(data).length === 0)
        return null;
    const displayName = typeof data.name === 'string' ? data.name : name;
    const tags = Array.isArray(data.tags)
        ? data.tags.filter((t) => typeof t === 'string')
        : typeof data.category === 'string'
            ? [data.category]
            : undefined;
    const required_tools = Array.isArray(data.required_tools)
        ? data.required_tools.filter((t) => typeof t === 'string')
        : undefined;
    return {
        name: displayName,
        source,
        filePath,
        body: content.trim() || raw,
        tags: tags && tags.length > 0 ? tags : undefined,
        required_tools: required_tools && required_tools.length > 0 ? required_tools : undefined,
        fallback_for_tools: parseEthosFallbackForTools(data),
        env_required: parseEthosEnvRequired(data),
        env_optional: parseEthosEnvOptional(data),
        external_cli_alternatives: parseEthosExternalCliAlternatives(data),
        rawFrontmatter: data,
        dialect: 'hermes',
        mtimeMs,
        permissions: parseEthosPermissions(data),
    };
}
