import { join } from 'node:path';

export function bundledSkillsSource() {
  return {
    label: 'ethos-bundled',
    dir: join(import.meta.dirname, '..', '..', '..', 'skills'),
  };
}

export const BUNDLED_SKILL_IDS = [
  'software-development/plan',
  'software-development/writing-plans',
  'software-development/spike',
  'software-development/tdd',
  'software-development/code-review',
  'software-development/systematic-debugging',
  'software-development/coding-agent',
  'software-development/subagent-driven-development',
  'software-development/requesting-code-review',
  'github/github-auth',
  'github/github-code-review',
  'github/github-pr-workflow',
  'github/github-issues',
  'github/github-repo-management',
  'research/arxiv',
  'research/research-paper-writing',
  'autonomous-ai-agents/claude-code',
  'autonomous-ai-agents/codex',
  'autonomous-ai-agents/opencode',
  'framework/ethos-skill-authoring',
  'framework/native-mcp',
  'framework/codebase-inspection',
];
