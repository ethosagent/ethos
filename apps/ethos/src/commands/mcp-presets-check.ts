// `ethos mcp presets --check` — read-only report of mcp.json entries that
// still launch a preset's package without a version.
//
// Lives beside `mcp.ts` for the reason `mcp-preset-args.ts` does: `mcp.ts`
// cannot be imported in a unit test. This module never writes: rewriting a
// user's mcp.json would be a second writer of user config
// (plan/phases/unified-catalog.md, D4), so it prints the argv to paste. The
// plan's §3.3 item 7 form, `ethos mcp remove <n> && ethos mcp add <n> --preset
// <p>`, was replaced because no `mcp remove` subcommand exists (the `runMcp`
// switch in mcp.ts) and remove-then-add would drop the entry's env secret refs
// and auth block. Pinned by apps/ethos/src/__tests__/mcp-presets-check.test.ts.

import type { McpServerConfig } from '@ethosagent/tools-mcp';
import type { McpPreset } from '@ethosagent/tools-mcp/presets';

export interface UnpinnedEntry {
  /** Server name in mcp.json. */
  name: string;
  preset: string;
  command: string;
  /** The entry's current args. */
  args: string[];
  /** What the args should be: the pinned preset args plus the entry's own trailing values. */
  pinnedArgs: string[];
}

/**
 * Entries in the preset's UNPINNED shape: same command, and some arg is the
 * bare package name (no `@version`). An entry already pinned, at any version,
 * is left alone — a user may have chosen it.
 */
export function findUnpinnedEntries(
  servers: readonly McpServerConfig[],
  presets: readonly McpPreset[],
): UnpinnedEntry[] {
  const found: UnpinnedEntry[] = [];
  for (const server of servers) {
    if (server.transport !== 'stdio' || !server.command) continue;
    const args = server.args ?? [];
    for (const preset of presets) {
      if (server.command !== preset.command) continue;
      const at = args.indexOf(preset.pin.package);
      if (at < 0) continue;
      // Keep the user's own values (path, repo) that follow the preset's fixed args.
      const fixedAfterSpec =
        preset.args.length - preset.args.indexOf(`${preset.pin.package}@${preset.pin.version}`) - 1;
      found.push({
        name: server.name,
        preset: preset.name,
        command: preset.command,
        args,
        pinnedArgs: [...preset.args, ...args.slice(at + 1 + fixedAfterSpec)],
      });
      break;
    }
  }
  return found;
}

export function formatUnpinnedReport(entries: readonly UnpinnedEntry[]): string {
  if (entries.length === 0) return 'All stdio servers in mcp.json that match a preset are pinned.';
  const lines = ['These mcp.json entries launch a preset package without a version:\n'];
  for (const e of entries) {
    lines.push(`  ${e.name} (preset: ${e.preset})`);
    lines.push(`    now:    ${e.command} ${e.args.join(' ')}`);
    lines.push(`    pinned: ${e.command} ${e.pinnedArgs.join(' ')}`);
  }
  lines.push(
    '\nEdit the entry\'s "args" in ~/.ethos/mcp.json to the pinned line. This command changes nothing.',
  );
  return lines.join('\n');
}
