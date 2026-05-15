import type { Tool, ToolResult } from '@ethosagent/types';

export interface SkillEntry {
  name: string;
  description: string;
  kind?: string;
}

export interface SkillsToolsOptions {
  listSkills: (personalityId?: string) => SkillEntry[];
  getSkillContent: (name: string, personalityId?: string) => string | null;
}

export function createSkillsTools(opts: SkillsToolsOptions): Tool[] {
  const skillsListTool: Tool = {
    name: 'skills_list',
    description:
      'List all available skills the current personality has access to. Returns name, description, and kind for each.',
    toolset: 'skills',
    maxResultChars: 10_000,
    capabilities: {},
    schema: { type: 'object', properties: {}, required: [] },
    async execute(_, ctx): Promise<ToolResult> {
      const skills = opts.listSkills(ctx.personalityId);
      if (skills.length === 0) {
        return { ok: true, value: 'No skills available for this personality.' };
      }
      const formatted = skills
        .map((s) => `- **${s.name}**${s.kind ? ` [${s.kind}]` : ''}: ${s.description}`)
        .join('\n');
      return { ok: true, value: `${skills.length} skills available:\n\n${formatted}` };
    },
  };

  const skillViewTool: Tool = {
    name: 'skill_view',
    description:
      'View the full content of a skill by name. Use skills_list first to discover available skills.',
    toolset: 'skills',
    maxResultChars: 30_000,
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the skill to view' },
      },
      required: ['name'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { name } = args as { name: string };
      if (!name) return { ok: false, error: 'name is required', code: 'input_invalid' };

      const content = opts.getSkillContent(name, ctx.personalityId);
      if (content === null) {
        return {
          ok: false,
          error: `Skill "${name}" not found or not accessible.`,
          code: 'not_available',
        };
      }
      return { ok: true, value: content };
    },
  };

  return [skillsListTool, skillViewTool];
}
