// /help body for the TUI — derived from surface-kit's SLASH_COMMANDS filtered
// to surface 'tui' (C5: one table, no hand-maintained list), then any
// externally injected commands (plugins, via TUIOptions.slashCommands) with a
// [plugin] tag. Aliases fold into their canonical command. Pure — extracted
// from App.tsx so the derivation is unit-testable (__tests__/help.test.ts).

import { slashCommandsForSurface } from '@ethosagent/surface-kit';

export interface ExternalSlashCommand {
  name: string;
  description: string;
  usage: string;
}

/** Live-state suffix for the two toggles whose current value the help shows. */
function stateSuffix(name: string, state: { readonlyMode: boolean; verbose: boolean }): string {
  if (name === 'readonly') return ` (now: ${state.readonlyMode ? 'on' : 'off'})`;
  if (name === 'verbose') return ` (now: ${state.verbose ? 'on' : 'off'})`;
  return '';
}

export function buildHelpText(
  state: { readonlyMode: boolean; verbose: boolean },
  external: ExternalSlashCommand[] = [],
): string {
  const lines: string[] = [];
  for (const cmd of slashCommandsForSurface('tui')) {
    if (cmd.aliasOf) continue;
    lines.push(`${cmd.usage.padEnd(30)}${cmd.description}${stateSuffix(cmd.name, state)}`);
  }
  for (const cmd of external) {
    lines.push(`/${cmd.name.padEnd(29)}${cmd.description} [plugin]`);
  }
  return lines.join('\n');
}
