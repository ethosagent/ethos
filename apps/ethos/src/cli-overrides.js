// FW-8 — CLI override flags: --model, --provider, --toolsets, -s
//
// Parses the four non-persistent override flags from process.argv and applies
// them to the loaded EthosConfig. Validation errors throw EthosError with
// registered codes so the top-level handler in index.ts renders them cleanly.
//
// None of these overrides are written back to ~/.ethos/config.yaml.
import { join } from 'node:path';
import { EthosError } from '@ethosagent/types';
import { ethosDir } from './config';
// ---------------------------------------------------------------------------
// Known toolsets (derived from extensions/tools-*/src/index.ts)
// ---------------------------------------------------------------------------
export const VALID_TOOLSETS = [
    'browser',
    'code',
    'cron',
    'delegation',
    'file',
    'image',
    'kanban',
    'mcp',
    'memory',
    'process',
    'terminal',
    'todo',
    'web',
];
// ---------------------------------------------------------------------------
// Known providers
// ---------------------------------------------------------------------------
export const VALID_PROVIDERS = [
    'anthropic',
    'openrouter',
    'openai-compat',
    'ollama',
    'gemini',
];
// ---------------------------------------------------------------------------
// argv parser
// ---------------------------------------------------------------------------
/**
 * Extract override flags from a raw argv array (process.argv.slice(2)).
 * Returns a CliOverrideFlags struct; absent flags have undefined values.
 * Does not validate values — call applyCliOverrides for that.
 */
export function parseCliOverrideFlags(argv) {
    const flags = {};
    const nextArg = (i) => {
        const v = argv[i + 1];
        return v && !v.startsWith('-') ? v : undefined;
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i] ?? '';
        if (a === '--model') {
            flags.model = nextArg(i);
            if (flags.model !== undefined)
                i++;
        }
        else if (a === '--provider') {
            flags.provider = nextArg(i);
            if (flags.provider !== undefined)
                i++;
        }
        else if (a === '--toolsets') {
            const val = nextArg(i);
            if (val) {
                flags.toolsets = val
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean);
                i++;
            }
        }
        else if (a === '-s') {
            const val = nextArg(i);
            if (val) {
                flags.skills = val
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean);
                i++;
            }
        }
    }
    return flags;
}
// ---------------------------------------------------------------------------
// Override application + validation
// ---------------------------------------------------------------------------
/**
 * Apply CLI override flags to a loaded config and validate their values.
 * Returns a new config object — never mutates the input.
 *
 * @throws {EthosError} INVALID_PROVIDER — unknown --provider value
 * @throws {EthosError} INVALID_TOOLSET  — unknown --toolsets item
 * @throws {EthosError} MISSING_SKILL    — skill file not found for -s item
 */
export async function applyCliOverrides(config, flags, storage) {
    const result = { ...config };
    // --model: pass-through, no validation
    if (flags.model !== undefined) {
        result.model = flags.model;
    }
    // --provider: validate against the known list
    if (flags.provider !== undefined) {
        const valid = VALID_PROVIDERS;
        if (!valid.includes(flags.provider)) {
            throw new EthosError({
                code: 'INVALID_PROVIDER',
                cause: `Unknown provider '${flags.provider}'. Valid options: ${VALID_PROVIDERS.join(', ')}`,
                action: `Use one of: ${VALID_PROVIDERS.join(', ')}`,
            });
        }
        result.provider = flags.provider;
    }
    // --toolsets: validate each item against the known toolset names
    if (flags.toolsets !== undefined) {
        const valid = VALID_TOOLSETS;
        for (const ts of flags.toolsets) {
            if (!valid.includes(ts)) {
                throw new EthosError({
                    code: 'INVALID_TOOLSET',
                    cause: `Unknown toolset '${ts}'. Valid options: ${VALID_TOOLSETS.join(', ')}`,
                    action: `Use one of: ${VALID_TOOLSETS.join(', ')}`,
                });
            }
        }
        result.cliToolsets = flags.toolsets;
    }
    // -s: resolve each skill name against ~/.ethos/skills/<name>.md
    if (flags.skills !== undefined && flags.skills.length > 0) {
        const skillsRoot = flags.skillsDir ?? join(ethosDir(), 'skills');
        const skillContents = [];
        for (const name of flags.skills) {
            // Reject path traversal attempts before joining into ~/.ethos/skills/
            if (name.includes('/') ||
                name.includes('\\') ||
                name.includes('..') ||
                name.startsWith('.')) {
                throw new EthosError({
                    code: 'MISSING_SKILL',
                    cause: `Invalid skill name '${name}': must be a plain filename with no path separators`,
                    action: `Use a simple skill name like 'my-skill', not a path`,
                });
            }
            const path = join(skillsRoot, `${name}.md`);
            const content = await storage.read(path);
            if (content === null) {
                throw new EthosError({
                    code: 'MISSING_SKILL',
                    cause: `Skill '${name}' not found at ${path}`,
                    action: `Place a ${name}.md file in ~/.ethos/skills/ or check the skill name spelling`,
                });
            }
            skillContents.push(content);
        }
        result.cliSkills = flags.skills;
        result.cliSkillContents = skillContents;
    }
    return result;
}
