import { basename, join } from 'node:path';
import type { Storage, Tool, ToolContext, ToolResult } from '@ethosagent/types';

interface SkillReadArgs {
  filename: string;
}

export function createSkillReadTool(opts: {
  storage: Storage;
  skillsDirs: string[];
}): Tool<SkillReadArgs> {
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
    async execute(args: SkillReadArgs, _ctx: ToolContext): Promise<ToolResult> {
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
