import { basename, join } from 'node:path';
export function createSkillProposeTool(opts) {
    const now = opts.now ?? (() => Date.now());
    return {
        name: 'skill_propose',
        description: 'Propose a new skill or a rewrite of an existing skill. The proposal goes to a human review queue.',
        toolset: 'skill_evolution',
        capabilities: {},
        schema: {
            type: 'object',
            properties: {
                content: { type: 'string', description: 'Full markdown body of the proposed skill' },
                reason: {
                    type: 'string',
                    description: 'One sentence explaining why this skill is worth proposing',
                },
                targetFile: {
                    type: 'string',
                    description: 'Existing skill filename to rewrite. Omit for a new skill.',
                },
            },
            required: ['content', 'reason'],
        },
        async execute(args, _ctx) {
            if (args.targetFile) {
                const safeTarget = basename(args.targetFile);
                if (safeTarget !== args.targetFile || args.targetFile.includes('..')) {
                    return {
                        ok: false,
                        error: 'Invalid targetFile: path separators not allowed',
                        code: 'input_invalid',
                    };
                }
            }
            const ts = now();
            const suffix = Math.random().toString(36).slice(2, 8);
            const id = args.targetFile
                ? `rewrite-${args.targetFile.replace(/\.md$/, '')}-${ts}`
                : `new-${ts}-${suffix}`;
            const filename = `${id}.md`;
            const header = [
                '---',
                `name: ${id}`,
                `description: "${args.reason.replace(/["\\]/g, '\\$&').replace(/\n/g, ' ')}"`,
                'ethos:',
                '  evolution:',
                '    auto_proposed: true',
                ...(args.targetFile ? [`    target_file: ${args.targetFile}`] : []),
                '---',
                '',
            ].join('\n');
            await opts.storage.mkdir(opts.pendingDir);
            await opts.storage.write(join(opts.pendingDir, filename), header + args.content);
            opts.onProposed?.();
            return { ok: true, value: `Skill candidate "${id}" written to pending queue for review.` };
        },
    };
}
