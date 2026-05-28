import { join } from 'node:path';
/**
 * Locates the bundled coding-skills `data/` directory shipped with this
 * package. Returned as a `ScanSource` so the universal scanner picks it up
 * alongside `~/.ethos/skills/`, `~/.claude/skills/`, etc.
 *
 * The wiring layer is responsible for passing this through
 * `trustedFirstPartySources` (NOT `extraSources`) — that's how the scanner
 * knows it's safe to gate at `trusted-repo` rather than `community`. Trust
 * tier is bound to the option name in the scanner, not to the label, so
 * untrusted callers cannot escalate by claiming the `ethos-bundled` label
 * via `extraSources`.
 */
export function bundledCodingSkillsSource() {
  return {
    label: 'ethos-bundled',
    dir: join(import.meta.dirname, '..', 'data'),
  };
}
/** Stable list of skill ids shipped in this bundle. Useful for tests + docs. */
export const BUNDLED_CODING_SKILL_IDS = [
  'plan',
  'writing-plans',
  'spike',
  'tdd',
  'code-review',
  'systematic-debugging',
  'github-pr-workflow',
  'github-code-review',
  'coding-agent',
  'subagent-driven-development',
  'github-auth',
  'codebase-inspection',
  'requesting-code-review',
  'native-mcp',
  'ethos-skill-authoring',
];
