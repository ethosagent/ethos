import { basename, join } from 'node:path';
export function createSkillReadTool(opts) {
  return {
    name: 'skill_read',
    description: 'Read the full content of an active skill file by filename.',
    toolset: 'skill_evolution',
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'The skill filename to read (e.g. "tool-usage.md")',
        },
      },
      required: ['filename'],
    },
    async execute(args, _ctx) {
      const safe = basename(args.filename);
      if (safe !== args.filename || args.filename.includes('..')) {
        return {
          ok: false,
          error: 'Invalid filename: path separators not allowed',
          code: 'input_invalid',
        };
      }
      for (const dir of opts.skillsDirs) {
        const content = await opts.storage.read(join(dir, safe));
        if (content !== null) {
          return { ok: true, value: content };
        }
      }
      return { ok: false, error: `Skill file "${args.filename}" not found`, code: 'not_available' };
    },
  };
}
