import { renderCharacterSheet, SYSTEM_PERSONALITY_IDS, } from '@ethosagent/personalities';
import { mcpTokenSecretRef } from '@ethosagent/tools-mcp';
import { EthosError } from '@ethosagent/types';
export class PersonalitiesService {
    opts;
    constructor(opts) {
        this.opts = opts;
    }
    list() {
        return {
            items: this.opts.personalities.describeAll().map(toWire),
            nextCursor: null,
            defaultId: this.opts.personalities.getDefault().id,
        };
    }
    async get(id) {
        const described = this.opts.personalities.describe(id);
        if (!described)
            throw notFound(id);
        const soulMd = await this.opts.personalities.readSoulMd(id);
        return { personality: toWire(described), soulMd, mcpPolicy: described.mcpPolicy ?? null };
    }
    /** Generated Markdown character sheet — the same artifact `ethos personality
     *  show` prints, rendered for the Web Personalities tab. */
    async characterSheet(id) {
        const described = this.opts.personalities.describe(id);
        if (!described)
            throw notFound(id);
        const soulMd = await this.opts.personalities.readSoulMd(id);
        return { markdown: renderCharacterSheet(described.config, soulMd) };
    }
    async create(input) {
        const created = await this.opts.personalities.create(input);
        return { personality: toWire(created) };
    }
    async update(id, patch) {
        const updated = await this.opts.personalities.update(id, patch);
        return { personality: toWire(updated) };
    }
    /**
     * Write per-server MCP tool subsets into the personality's `mcp.yaml`.
     * `subsets` maps a server name to either an explicit bare-tool-name list
     * (a strict subset) or `null` to clear any prior subset (all tools
     * allowed). Delegates to the registry, which preserves `reject_args`.
     */
    async writeMcpToolSubsets(id, subsets) {
        await this.opts.personalities.writeMcpToolSubsets(id, subsets);
    }
    async delete(id) {
        await this.opts.personalities.deletePersonality(id);
    }
    async duplicate(id, newId) {
        const created = await this.opts.personalities.duplicate(id, newId);
        return { personality: toWire(created) };
    }
    // ---------------------------------------------------------------------------
    // Per-personality skills (gate 19)
    // ---------------------------------------------------------------------------
    async skillsList(personalityId) {
        this.requirePersonality(personalityId);
        const records = await this.opts.library.listPersonalitySkills(personalityId);
        return { skills: records.map(toWirePersonalitySkill) };
    }
    async skillsGet(personalityId, skillId) {
        this.requirePersonality(personalityId);
        const skill = await this.opts.library.getPersonalitySkill(personalityId, skillId);
        if (!skill) {
            throw new EthosError({
                code: 'SKILL_NOT_FOUND',
                cause: `Skill "${skillId}" not found for personality "${personalityId}".`,
                action: 'Use personalities.skillsList to see installed skills.',
            });
        }
        return { skill: toWirePersonalitySkill(skill) };
    }
    async skillsCreate(personalityId, skillId, body) {
        this.requirePersonality(personalityId);
        const skill = await this.opts.library.createPersonalitySkill(personalityId, skillId, body);
        return { skill: toWirePersonalitySkill(skill) };
    }
    async skillsUpdate(personalityId, skillId, body) {
        this.requirePersonality(personalityId);
        const skill = await this.opts.library.updatePersonalitySkill(personalityId, skillId, body);
        return { skill: toWirePersonalitySkill(skill) };
    }
    async skillsDelete(personalityId, skillId) {
        this.requirePersonality(personalityId);
        await this.opts.library.deletePersonalitySkill(personalityId, skillId);
    }
    async skillsImportGlobal(personalityId, skillIds) {
        this.requirePersonality(personalityId);
        const records = await this.opts.library.importGlobalIntoPersonality(personalityId, skillIds);
        return { imported: records.map(toWirePersonalitySkill) };
    }
    async mcpSetToken(personalityId, server, token) {
        this.requirePersonality(personalityId);
        const described = this.opts.personalities.describe(personalityId);
        if (!described || !(described.config.mcp_servers ?? []).includes(server)) {
            throw new EthosError({
                code: 'MCP_SERVER_NOT_FOUND',
                cause: `Server "${server}" is not attached to personality "${personalityId}".`,
                action: 'Attach the server first via personalities.update, then set the token.',
            });
        }
        if (!this.opts.secrets) {
            throw new EthosError({
                code: 'SECRETS_UNAVAILABLE',
                cause: 'No secrets resolver configured',
                action: 'Configure secrets in web-api startup.',
            });
        }
        const { PersonalityScopedSecrets } = await import('@ethosagent/storage-fs');
        const scoped = new PersonalityScopedSecrets(this.opts.secrets, personalityId);
        await scoped.set(mcpTokenSecretRef(server), token);
    }
    async mcpDeleteToken(personalityId, server) {
        this.requirePersonality(personalityId);
        const described = this.opts.personalities.describe(personalityId);
        if (!described || !(described.config.mcp_servers ?? []).includes(server)) {
            throw new EthosError({
                code: 'MCP_SERVER_NOT_FOUND',
                cause: `Server "${server}" is not attached to personality "${personalityId}".`,
                action: 'Attach the server first via personalities.update, then set the token.',
            });
        }
        if (!this.opts.secrets) {
            throw new EthosError({
                code: 'SECRETS_UNAVAILABLE',
                cause: 'No secrets resolver configured',
                action: 'Configure secrets in web-api startup.',
            });
        }
        const { PersonalityScopedSecrets } = await import('@ethosagent/storage-fs');
        const scoped = new PersonalityScopedSecrets(this.opts.secrets, personalityId);
        await scoped.delete(mcpTokenSecretRef(server));
    }
    requirePersonality(id) {
        if (!this.opts.personalities.describe(id)) {
            throw new EthosError({
                code: 'PERSONALITY_NOT_FOUND',
                cause: `Personality "${id}" not found.`,
                action: 'Use personalities.list to see available ids.',
            });
        }
    }
}
function toWirePersonalitySkill(record) {
    return {
        id: record.id,
        name: record.name,
        description: record.description,
        body: record.body,
        modifiedAt: record.modifiedAt,
    };
}
function toWire(d) {
    const c = d.config;
    return {
        id: c.id,
        name: c.name,
        description: c.description ?? null,
        model: c.model ?? null,
        provider: c.provider ?? null,
        toolset: c.toolset ?? null,
        capabilities: c.capabilities ?? null,
        streamingTimeoutMs: c.streamingTimeoutMs ?? null,
        mcp_servers: c.mcp_servers ?? null,
        plugins: c.plugins ?? null,
        fs_reach: c.fs_reach
            ? { read: c.fs_reach.read ?? null, write: c.fs_reach.write ?? null }
            : null,
        system: d.builtin && SYSTEM_PERSONALITY_IDS.has(c.id),
        builtin: d.builtin,
        version: 1,
    };
}
function notFound(id) {
    return new EthosError({
        code: 'PERSONALITY_NOT_FOUND',
        cause: `Personality "${id}" not found`,
        action: 'Call `personalities.list` to see available IDs.',
    });
}
