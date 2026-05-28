import { homedir } from 'node:os';
import { join } from 'node:path';
// ---------------------------------------------------------------------------
// Factory: personality-only tools (tools 1–4)
// ---------------------------------------------------------------------------
export function createPersonalityDesignTools(deps) {
  return [
    listAvailableToolsTool(deps.toolRegistry),
    listAvailableModelsTool(deps.modelCatalog),
    listAvailableSkillsTool(deps.skills),
    scaffoldPersonalityTool(deps.storage, deps.toolRegistry),
  ];
}
// ---------------------------------------------------------------------------
// Factory: team-only tools (tools 5–7)
// ---------------------------------------------------------------------------
export function createTeamDesignTools(deps) {
  return [
    listPersonalitiesTool(deps.personalityRegistry),
    listTeamPatternsTool(),
    scaffoldTeamTool(deps.storage),
  ];
}
// ---------------------------------------------------------------------------
// Factory: combined (all 7)
// ---------------------------------------------------------------------------
export function createAllDesignTools(deps) {
  return [...createPersonalityDesignTools(deps), ...createTeamDesignTools(deps)];
}
// ===========================================================================
// Tool 1: list_available_tools
// ===========================================================================
function listAvailableToolsTool(toolRegistry) {
  return {
    name: 'list_available_tools',
    description:
      'List all registered tools with their name, description, toolset, and capabilities. Use to understand what tools are available for inclusion in a personality toolset.',
    toolset: 'personality_design',
    capabilities: {},
    schema: { type: 'object', properties: {} },
    async execute(_args, _ctx) {
      const tools = toolRegistry.getAvailable();
      if (tools.length === 0) {
        return { ok: true, value: 'No tools currently registered.' };
      }
      const lines = [`# Available Tools (${tools.length})\n`];
      for (const t of tools) {
        lines.push(`## ${t.name}`);
        lines.push(`- **Description:** ${t.description}`);
        if (t.toolset) lines.push(`- **Toolset:** ${t.toolset}`);
        const caps = Object.keys(t.capabilities);
        if (caps.length > 0) lines.push(`- **Capabilities:** ${caps.join(', ')}`);
        lines.push('');
      }
      return { ok: true, value: lines.join('\n') };
    },
  };
}
// ===========================================================================
// Tool 2: list_available_models
// ===========================================================================
function listAvailableModelsTool(modelCatalog) {
  return {
    name: 'list_available_models',
    description:
      'List available LLM models from the model catalog with provider, model ID, label, context window, and default flag.',
    toolset: 'personality_design',
    capabilities: {},
    schema: { type: 'object', properties: {} },
    async execute(_args, _ctx) {
      if (modelCatalog.length === 0) {
        return { ok: true, value: 'No models in the catalog.' };
      }
      const lines = [`# Available Models (${modelCatalog.length})\n`];
      for (const m of modelCatalog) {
        const defaultTag = m.default ? ' **(default)**' : '';
        lines.push(`- **${m.label}**${defaultTag}`);
        lines.push(`  - Provider: ${m.providerId}`);
        lines.push(`  - Model ID: ${m.modelId}`);
        lines.push(`  - Context window: ${m.contextWindow.toLocaleString()} tokens`);
      }
      return { ok: true, value: lines.join('\n') };
    },
  };
}
// ===========================================================================
// Tool 3: list_available_skills
// ===========================================================================
function listAvailableSkillsTool(skills) {
  return {
    name: 'list_available_skills',
    description:
      'List available skills with name, summary (first 200 chars), required tools, and source. Use to understand what skills a personality might leverage.',
    toolset: 'personality_design',
    capabilities: {},
    schema: { type: 'object', properties: {} },
    async execute(_args, _ctx) {
      if (skills.length === 0) {
        return { ok: true, value: 'No skills available.' };
      }
      const lines = [`# Available Skills (${skills.length})\n`];
      for (const s of skills) {
        lines.push(`## ${s.name}`);
        lines.push(`- **Source:** ${s.source}`);
        const summary = s.body.length > 200 ? `${s.body.slice(0, 200)}...` : s.body;
        lines.push(`- **Summary:** ${summary.replace(/\n/g, ' ')}`);
        if (s.required_tools?.length) {
          lines.push(`- **Required tools:** ${s.required_tools.join(', ')}`);
        }
        lines.push('');
      }
      return { ok: true, value: lines.join('\n') };
    },
  };
}
function scaffoldPersonalityTool(storage, toolRegistry) {
  return {
    name: 'scaffold_personality',
    description:
      'Validate and write personality files (SOUL.md, config.yaml, toolset.yaml) atomically to ~/.ethos/personalities/<id>/. Creates a fully-formed custom personality.',
    toolset: 'personality_design',
    capabilities: { fs_reach: { write: ['~/.ethos/personalities/'] } },
    schema: {
      type: 'object',
      required: ['id', 'soul_md', 'config', 'toolset'],
      properties: {
        id: { type: 'string', description: 'Personality ID (kebab-case, e.g. my-researcher)' },
        soul_md: { type: 'string', description: 'Full SOUL.md content' },
        config: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            model: { type: 'string' },
            provider: { type: 'string' },
            capabilities: { type: 'string', description: 'Comma-separated capability labels' },
            fs_reach_read: { type: 'array', items: { type: 'string' } },
            fs_reach_write: { type: 'array', items: { type: 'string' } },
          },
        },
        toolset: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tool names to include',
        },
      },
    },
    async execute(raw, _ctx) {
      const args = raw;
      // Validation
      const kebabRe = /^[a-z][a-z0-9-]*$/;
      if (!kebabRe.test(args.id)) {
        return {
          ok: false,
          error: `Invalid personality ID "${args.id}": must be kebab-case (lowercase letters, digits, hyphens, starting with a letter).`,
          code: 'input_invalid',
        };
      }
      if (!args.soul_md.trim()) {
        return { ok: false, error: 'soul_md must be non-empty.', code: 'input_invalid' };
      }
      if (!args.config.name.trim()) {
        return { ok: false, error: 'config.name must be non-empty.', code: 'input_invalid' };
      }
      if (!Array.isArray(args.toolset) || args.toolset.length === 0) {
        return {
          ok: false,
          error: 'toolset must be a non-empty array of tool names.',
          code: 'input_invalid',
        };
      }
      const unknownTools = args.toolset.filter((t) => !toolRegistry.get(t));
      if (unknownTools.length > 0) {
        return {
          ok: false,
          error: `Unknown tool(s) in toolset: ${unknownTools.join(', ')}. Use list_available_tools to see valid names.`,
          code: 'input_invalid',
        };
      }
      const base = join(homedir(), '.ethos', 'personalities', args.id);
      // Serialize config.yaml — all values go through yamlScalar to
      // prevent newline injection that could add fs_reach or other keys.
      const configLines = [`name: ${yamlScalar(args.config.name)}`];
      if (args.config.description)
        configLines.push(`description: ${yamlScalar(args.config.description)}`);
      if (args.config.model) configLines.push(`model: ${yamlScalar(args.config.model)}`);
      if (args.config.provider) configLines.push(`provider: ${yamlScalar(args.config.provider)}`);
      if (args.config.capabilities)
        configLines.push(`capabilities: ${yamlScalar(args.config.capabilities)}`);
      const configYaml = `${configLines.join('\n')}\n`;
      // Serialize toolset.yaml
      const toolsetYaml = `${args.toolset.map((t) => `- ${yamlScalar(t)}`).join('\n')}\n`;
      // Write files atomically
      await storage.mkdir(base);
      await storage.writeAtomic(join(base, 'SOUL.md'), args.soul_md);
      await storage.writeAtomic(join(base, 'config.yaml'), configYaml);
      await storage.writeAtomic(join(base, 'toolset.yaml'), toolsetYaml);
      return {
        ok: true,
        value: `Personality "${args.id}" scaffolded successfully.\n\nFiles written:\n- ${base}/SOUL.md\n- ${base}/config.yaml\n- ${base}/toolset.yaml\n\nTest it: ethos chat --personality ${args.id}`,
      };
    },
  };
}
// ===========================================================================
// Tool 5: list_personalities
// ===========================================================================
function listPersonalitiesTool(personalityRegistry) {
  return {
    name: 'list_personalities',
    description:
      'List all registered personalities (built-in and custom) with their id, name, description, and toolset. Use to see available personalities for team composition.',
    toolset: 'personality_design',
    capabilities: {},
    schema: { type: 'object', properties: {} },
    async execute(_args, _ctx) {
      const personalities = personalityRegistry.list();
      if (personalities.length === 0) {
        return { ok: true, value: 'No personalities registered.' };
      }
      const lines = [`# Registered Personalities (${personalities.length})\n`];
      for (const p of personalities) {
        lines.push(`## ${p.id}`);
        lines.push(`- **Name:** ${p.name}`);
        if (p.description) lines.push(`- **Description:** ${p.description}`);
        if (p.toolset?.length) lines.push(`- **Toolset:** ${p.toolset.join(', ')}`);
        lines.push('');
      }
      return { ok: true, value: lines.join('\n') };
    },
  };
}
const TEAM_PATTERNS = [
  {
    name: 'engineer-reviewer-pair',
    description: 'Two-agent pair: one writes code, the other reviews it.',
    dispatch_mode: 'coordinator',
    roles: ['engineer (coordinator)', 'reviewer (member)'],
    when_to_use:
      'When you want every code change reviewed before completion. The engineer coordinates and delegates review tasks.',
  },
  {
    name: 'researcher-writer-pair',
    description: 'Two-agent pair: one researches topics, the other writes content.',
    dispatch_mode: 'coordinator',
    roles: ['researcher (coordinator)', 'writer (member)'],
    when_to_use: 'Content creation workflows where research and writing are distinct phases.',
  },
  {
    name: 'engineering-team',
    description:
      'Multi-agent team with a lead engineer coordinating specialists (frontend, backend, devops).',
    dispatch_mode: 'coordinator',
    roles: [
      'lead-engineer (coordinator)',
      'frontend (member)',
      'backend (member)',
      'devops (member)',
    ],
    when_to_use: 'Full-stack projects requiring multiple specializations working in parallel.',
  },
  {
    name: 'content-team',
    description: 'Content production team with an editor coordinating researchers and writers.',
    dispatch_mode: 'coordinator',
    roles: ['editor (coordinator)', 'researcher (member)', 'writer (member)'],
    when_to_use:
      'Multi-article or documentation projects where research, writing, and editing are separate concerns.',
  },
  {
    name: 'operator-team',
    description:
      'Self-routing team of equally-capable operators that pick up tasks based on availability.',
    dispatch_mode: 'self-routing',
    roles: ['operator (member)', 'operator (member)', 'operator (member)'],
    when_to_use:
      'High-throughput task queues where any agent can handle any task. No coordinator overhead.',
  },
];
function listTeamPatternsTool() {
  return {
    name: 'list_team_patterns',
    description:
      'List curated team shape patterns (e.g. engineer-reviewer-pair, engineering-team) with descriptions, dispatch modes, and usage guidance.',
    toolset: 'personality_design',
    capabilities: {},
    schema: { type: 'object', properties: {} },
    async execute(_args, _ctx) {
      const lines = [`# Team Patterns (${TEAM_PATTERNS.length})\n`];
      for (const p of TEAM_PATTERNS) {
        lines.push(`## ${p.name}`);
        lines.push(`- **Description:** ${p.description}`);
        lines.push(`- **Dispatch mode:** ${p.dispatch_mode}`);
        lines.push(`- **Roles:** ${p.roles.join(', ')}`);
        lines.push(`- **When to use:** ${p.when_to_use}`);
        lines.push('');
      }
      return { ok: true, value: lines.join('\n') };
    },
  };
}
/** Escape a value for safe YAML scalar emission. If the value contains
 *  characters that could alter YAML structure (colons, newlines, special
 *  chars, leading/trailing whitespace), wrap it in JSON-style double
 *  quotes. Prevents newline injection that could create new top-level
 *  keys (e.g. injecting `fs_reach` for privilege escalation). */
function yamlScalar(value) {
  if (/[:\n\r#[\]{}&*!|>'"%@`]/.test(value) || value.trim() !== value) {
    return JSON.stringify(value);
  }
  return value;
}
function serializeTeamYaml(args) {
  const lines = [`name: ${yamlScalar(args.name)}`, `description: ${yamlScalar(args.description)}`];
  const caps = args.domain_capabilities ?? [];
  if (caps.length === 0) {
    lines.push('domain_capabilities: []');
  } else {
    lines.push('domain_capabilities:');
    for (const cap of caps) lines.push(`  - ${yamlScalar(cap)}`);
  }
  if (args.dispatch_mode) lines.push(`dispatch_mode: ${yamlScalar(args.dispatch_mode)}`);
  if (args.coordinator) lines.push(`coordinator: ${yamlScalar(args.coordinator)}`);
  if (args.members.length === 0) {
    lines.push('members: []');
  } else {
    lines.push('members:');
    for (const m of args.members) {
      lines.push(`  - personality: ${yamlScalar(m.personality)}`);
      if (m.role) lines.push(`    role: ${yamlScalar(m.role)}`);
      if (m.capabilities?.length) {
        lines.push('    capabilities:');
        for (const cap of m.capabilities) lines.push(`      - ${yamlScalar(cap)}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}
function scaffoldTeamTool(storage) {
  return {
    name: 'scaffold_team',
    description:
      'Validate and write a team manifest YAML file to ~/.ethos/teams/<name>.yaml. Creates a team definition that can be started with `ethos team start`.',
    toolset: 'personality_design',
    capabilities: { fs_reach: { write: ['~/.ethos/teams/'] } },
    schema: {
      type: 'object',
      required: ['name', 'description', 'members'],
      properties: {
        name: {
          type: 'string',
          description: 'Team name (alphanumeric, dashes, dots, underscores)',
        },
        description: { type: 'string' },
        domain_capabilities: { type: 'array', items: { type: 'string' } },
        dispatch_mode: { type: 'string', enum: ['coordinator', 'self-routing', 'broadcast'] },
        coordinator: { type: 'string' },
        members: {
          type: 'array',
          items: {
            type: 'object',
            required: ['personality'],
            properties: {
              personality: { type: 'string' },
              role: { type: 'string', enum: ['coordinator', 'member'] },
              capabilities: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
    async execute(raw, _ctx) {
      const args = raw;
      // Validation
      const nameRe = /^[a-zA-Z0-9._-]+$/;
      if (!nameRe.test(args.name)) {
        return {
          ok: false,
          error: `Invalid team name "${args.name}": must contain only alphanumeric characters, dashes, dots, and underscores.`,
          code: 'input_invalid',
        };
      }
      if (!Array.isArray(args.members) || args.members.length === 0) {
        return {
          ok: false,
          error: 'members must be a non-empty array.',
          code: 'input_invalid',
        };
      }
      const yaml = serializeTeamYaml(args);
      const teamsBase = join(homedir(), '.ethos', 'teams');
      const dest = join(teamsBase, `${args.name}.yaml`);
      await storage.mkdir(teamsBase);
      await storage.writeAtomic(dest, yaml);
      return {
        ok: true,
        value: `Team "${args.name}" scaffolded successfully.\n\nFile written: ${dest}\n\nStart it with: ethos team start ${args.name}`,
      };
    },
  };
}
