// N1 (plan ux-feedback-and-config-clarity §4) — the grouped `--help` layout and
// the nearest-command suggestion for `Unknown command`. Hand-maintained per
// UD8; `__tests__/usage-help.test.ts` derives the registered command set from
// the dispatch switch in index.ts and fails when this table drifts from it.

import { nearestKey } from '@ethosagent/config';

export const COMMAND_GROUPS = [
  'Start',
  'Diagnose',
  'Agents',
  'Channels',
  'Automate',
  'Data',
  'Other',
] as const;

export type CommandGroup = (typeof COMMAND_GROUPS)[number];

export interface CommandTableEntry {
  name: string;
  group: CommandGroup;
  description: string;
}

export const COMMAND_TABLE: readonly CommandTableEntry[] = [
  // Start
  {
    name: 'setup',
    group: 'Start',
    description: 'Interactive first-run wizard (provider, model, key, channels)',
  },
  {
    name: 'chat',
    group: 'Start',
    description: 'Interactive chat REPL (default when no command is given)',
  },
  { name: 'serve', group: 'Start', description: 'Run the web UI + API server' },
  { name: 'boot', group: 'Start', description: 'Run gateway + serve in one process' },
  {
    name: 'run-all',
    group: 'Start',
    description: 'Supervise gateway and serve as child processes',
  },
  { name: 'dashboard', group: 'Start', description: 'Terminal dashboard of live agent activity' },
  { name: 'upgrade', group: 'Start', description: 'Upgrade the ethos CLI to the latest release' },
  // Diagnose
  {
    name: 'status',
    group: 'Diagnose',
    description: 'One-screen health summary: config, adapters, stores, pending work',
  },
  {
    name: 'doctor',
    group: 'Diagnose',
    description: 'Deep health check with fixes (--fix, --check-provider)',
  },
  {
    name: 'trace',
    group: 'Diagnose',
    description: 'Inspect a turn trace by id, or list recent traces',
  },
  {
    name: 'errors',
    group: 'Diagnose',
    description: 'Read the local error log (~/.ethos/logs/errors.jsonl)',
  },
  { name: 'logs', group: 'Diagnose', description: 'Show recent activity logs' },
  { name: 'tail', group: 'Diagnose', description: 'Follow live observability events' },
  { name: 'perf', group: 'Diagnose', description: 'Performance report over recorded turns' },
  { name: 'why', group: 'Diagnose', description: 'Explain what the agent did in a turn and why' },
  {
    name: 'audit',
    group: 'Diagnose',
    description: 'Audit trail of approvals and safety decisions',
  },
  {
    name: 'security',
    group: 'Diagnose',
    description: 'Security audit of the local deployment (security audit)',
  },
  { name: 'bench', group: 'Diagnose', description: 'Benchmark context assembly and providers' },
  { name: 'support', group: 'Diagnose', description: 'Build a redacted support bundle' },
  {
    name: 'request-dump',
    group: 'Diagnose',
    description: 'Dump the exact provider request for a turn',
  },
  // Agents
  {
    name: 'personality',
    group: 'Agents',
    description: 'List, create, show, evolve and manage personalities',
  },
  { name: 'set', group: 'Agents', description: 'Set the default personality or the active team' },
  { name: 'team', group: 'Agents', description: 'Start, stop and inspect agent teams' },
  { name: 'mesh', group: 'Agents', description: 'Manage the local agent mesh registry' },
  { name: 'skills', group: 'Agents', description: 'Install and manage skills' },
  { name: 'plugin', group: 'Agents', description: 'Install, remove and grant plugins' },
  { name: 'plugins', group: 'Agents', description: 'Plugin × personality attachment matrix' },
  { name: 'commands', group: 'Agents', description: 'List plugin-registered slash commands' },
  { name: 'evolve', group: 'Agents', description: 'Run a personality evolution cycle' },
  { name: 'learn', group: 'Agents', description: 'Record a learning for future turns' },
  { name: 'learning', group: 'Agents', description: 'Review and replay the learning inbox' },
  { name: 'eval', group: 'Agents', description: 'Run evaluation suites against the agent' },
  { name: 'claw', group: 'Agents', description: 'Clawrium playbook integration' },
  { name: 'acp', group: 'Agents', description: 'Serve the agent over the Agent Client Protocol' },
  { name: 'a2a', group: 'Agents', description: 'Agent-to-agent (A2A) peering and tasks' },
  {
    name: 'mcp',
    group: 'Agents',
    description: 'Manage MCP servers (~/.ethos/mcp.json), serve an MCP export',
  },
  { name: 'process', group: 'Agents', description: 'List and manage background agent processes' },
  // Channels
  {
    name: 'gateway',
    group: 'Channels',
    description: 'Run the channel gateway (Telegram, Slack, Discord, email…)',
  },
  { name: 'listen', group: 'Channels', description: 'Run a voice wake-word satellite' },
  { name: 'slack', group: 'Channels', description: 'Generate a Slack app manifest' },
  {
    name: 'outbox',
    group: 'Channels',
    description: 'Approve or reject queued outbound publications',
  },
  // Automate
  { name: 'cron', group: 'Automate', description: 'Schedule and manage recurring jobs' },
  { name: 'batch', group: 'Automate', description: 'Run a batch of prompts non-interactively' },
  { name: 'nightly', group: 'Automate', description: 'Run a nightly maintenance job' },
  { name: 'digest', group: 'Automate', description: 'Produce an activity digest' },
  // Data
  { name: 'sessions', group: 'Data', description: 'List, search, rename and delete chat sessions' },
  {
    name: 'memory',
    group: 'Data',
    description: 'Show and edit agent memory; approve pending captures',
  },
  { name: 'backup', group: 'Data', description: 'Create a state backup archive' },
  { name: 'import', group: 'Data', description: 'Restore state from a backup archive' },
  { name: 'retention', group: 'Data', description: 'Show and apply data retention policies' },
  { name: 'archive', group: 'Data', description: 'List and inspect archived data' },
  { name: 'cas', group: 'Data', description: 'Content-addressed blob store maintenance' },
  { name: 'data', group: 'Data', description: 'Data directory statistics' },
  { name: 'models', group: 'Data', description: 'List and test configured models' },
  { name: 'migrate', group: 'Data', description: 'Migrate model names in config and stores' },
  { name: 'usage', group: 'Data', description: 'Token and cost usage report' },
  // Other
  { name: 'keys', group: 'Other', description: 'Manage the API-key rotation pool' },
  { name: 'secrets', group: 'Other', description: 'Manage the local secrets vault' },
  { name: 'api-key', group: 'Other', description: 'Manage web API keys' },
  { name: 'fallback', group: 'Other', description: 'Manage the provider fallback chain' },
  {
    name: 'systemd-unit',
    group: 'Other',
    description: 'Print a systemd unit for production deployment',
  },
];

/** The grouped `--help` body. One line per command, ending with the
 *  per-command help pointer the plan's §4 N1 layout specifies. */
export function renderGroupedHelp(): string {
  const width = Math.max(...COMMAND_TABLE.map((e) => e.name.length)) + 2;
  const lines: string[] = ['Usage: ethos <command> [options]'];
  for (const group of COMMAND_GROUPS) {
    const entries = COMMAND_TABLE.filter((e) => e.group === group);
    if (entries.length === 0) continue;
    lines.push('', `${group}:`);
    for (const e of entries) {
      lines.push(`  ${e.name.padEnd(width)}${e.description}`);
    }
  }
  lines.push('', 'ethos <command> --help for details');
  return lines.join('\n');
}

/** Nearest registered command within 2 edits, or undefined. Same
 *  Damerau-Levenshtein helper as B2's unknown-config-key suggestion. */
export function suggestCommand(input: string): string | undefined {
  return nearestKey(
    input,
    COMMAND_TABLE.map((e) => e.name),
  );
}
