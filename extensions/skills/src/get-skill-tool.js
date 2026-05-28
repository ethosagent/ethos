import { dirname } from 'node:path';
import { sanitize } from './prompt-injection-guard';
import { applySubstitutions } from './skill-compat';
/**
 * Framework tool that loads a skill's full body on demand.
 * Registered alongside SkillsInjector so the LLM can fetch instructions
 * for any skill listed in the index without bloating the system prompt.
 *
 * Always included regardless of personality toolset (alwaysInclude: true).
 */
export class GetSkillTool {
    scanner;
    name = 'get_skill';
    description = 'Load the full instructions for a named skill. ' +
        'Skills are listed in the ## Available Skills section of the system prompt. ' +
        'Always call this before executing a skill to get the complete instructions.';
    schema = {
        type: 'object',
        properties: {
            name: {
                type: 'string',
                description: 'Qualified skill name as shown in the Available Skills index, e.g. "ethos/summarize-doc".',
            },
        },
        required: ['name'],
        additionalProperties: false,
    };
    alwaysInclude = true;
    capabilities = {};
    constructor(scanner) {
        this.scanner = scanner;
    }
    async execute({ name }, ctx) {
        const pool = await this.scanner.scan();
        const skill = pool.get(name);
        if (!skill) {
            const available = [...pool.keys()].slice(0, 8).join(', ');
            const suffix = pool.size > 8 ? ` … (${pool.size} total)` : '';
            return {
                ok: false,
                error: `Skill "${name}" not found in the available pool. Known names: ${available}${suffix}`,
                code: 'not_available',
            };
        }
        const body = applySubstitutions(skill.body, dirname(skill.filePath), ctx.sessionId);
        const content = sanitize(body.trim());
        return { ok: true, value: content || '(skill body is empty)' };
    }
}
