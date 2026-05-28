import { EthosError } from '@ethosagent/types';
export class SkillsService {
    opts;
    constructor(opts) {
        this.opts = opts;
    }
    async list() {
        const [skills, pending] = await Promise.all([
            this.opts.library.listSkills(),
            this.opts.library.listPending(),
        ]);
        return { skills: skills.map(toWire), pendingCount: pending.length };
    }
    async get(id) {
        const skill = await this.opts.library.getSkill(id);
        if (!skill)
            throw notFound(id);
        return { skill: toWire(skill) };
    }
    async create(input) {
        const skill = await this.opts.library.createSkill(input.id, input.body);
        return { skill: toWire(skill) };
    }
    async update(input) {
        const existing = await this.opts.library.getSkill(input.id);
        if (existing?.source === 'system')
            throw readonlyError();
        const skill = await this.opts.library.updateSkill(input.id, input.body);
        return { skill: toWire(skill) };
    }
    async delete(id) {
        const existing = await this.opts.library.getSkill(id);
        if (existing?.source === 'system')
            throw readonlyError();
        await this.opts.library.deleteSkill(id);
    }
}
function toWire(record) {
    return {
        id: record.id,
        name: record.name,
        description: record.description,
        frontmatter: record.frontmatter,
        body: record.body,
        modifiedAt: record.modifiedAt,
        source: record.source,
        readonly: record.readonly,
    };
}
function notFound(id) {
    return new EthosError({
        code: 'SKILL_NOT_FOUND',
        cause: `Skill "${id}" not found.`,
        action: 'Use skills.list to see what is currently installed.',
    });
}
function readonlyError() {
    return new EthosError({
        code: 'SKILL_READONLY',
        cause: 'System skills are read-only.',
        action: 'Only user-created skills can be modified or deleted.',
    });
}
