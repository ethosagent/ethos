// FW-§9.6 — `ethos commands` CLI subcommand: list and inspect file-drop commands.

import { join } from 'node:path';
import { ethosDir } from '@ethosagent/config';
import { FsStorage } from '@ethosagent/storage-fs';
import type { CommandMeta } from '../lib/command-loader';
import { scanCommandsIntoRegistry } from '../lib/command-loader';
import { SlashCommandRegistry } from '../lib/slash-commands';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
};

export async function runCommands(args: string[]): Promise<void> {
  const sub = args[0] ?? 'list';

  switch (sub) {
    case 'list': {
      await listCommands(args);
      break;
    }

    case 'show': {
      const name = args[1];
      if (!name) {
        console.log('Usage: ethos commands show <name>');
        process.exit(1);
      }
      await showCommand(name, args);
      break;
    }

    default:
      console.log('Usage: ethos commands [list | show <name>]');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildCommandDirs(
  personalityId?: string,
): { path: string; scope: 'global' | 'project' | 'personality' }[] {
  const dirs: { path: string; scope: 'global' | 'project' | 'personality' }[] = [
    { path: join(ethosDir(), 'commands'), scope: 'global' },
    { path: join(process.cwd(), '.ethos', 'commands'), scope: 'project' },
  ];
  if (personalityId) {
    dirs.push({
      path: join(ethosDir(), 'personalities', personalityId, 'commands'),
      scope: 'personality',
    });
  }
  return dirs;
}

async function scanCommands(args: string[]): Promise<Map<string, CommandMeta>> {
  const personalityIdx = args.indexOf('--personality');
  const personalityId = personalityIdx !== -1 ? args[personalityIdx + 1] : undefined;

  const storage = new FsStorage();
  const registry = new SlashCommandRegistry();
  const cache = new Map<string, CommandMeta>();

  await scanCommandsIntoRegistry(storage, buildCommandDirs(personalityId), registry, cache);

  return cache;
}

async function listCommands(args: string[]): Promise<void> {
  const cache = await scanCommands(args);

  if (cache.size === 0) {
    console.log(`\n${c.dim}No commands found.${c.reset}`);
    console.log(
      `${c.dim}Add .md files to ~/.ethos/commands/ or .ethos/commands/ to create commands.${c.reset}\n`,
    );
    return;
  }

  const byScope = new Map<string, CommandMeta[]>();
  for (const meta of cache.values()) {
    const list = byScope.get(meta.definition.scope) ?? [];
    list.push(meta);
    byScope.set(meta.definition.scope, list);
  }

  // Stable order: global, project, personality
  const scopeOrder = (scope: string): number => {
    if (scope === 'global') return 0;
    if (scope === 'project') return 1;
    if (scope === 'personality') return 2;
    return 3;
  };
  const sortedScopes = [...byScope.keys()].sort((a, b) => scopeOrder(a) - scopeOrder(b));

  console.log();
  for (const scope of sortedScopes) {
    const commands = (byScope.get(scope) ?? []).sort((a, b) =>
      a.definition.name.localeCompare(b.definition.name),
    );
    console.log(`${c.bold}${scope}${c.reset}`);
    for (const meta of commands) {
      const desc = meta.definition.description
        ? `  ${c.dim}${meta.definition.description}${c.reset}`
        : '';
      console.log(`  ${c.cyan}${meta.definition.name}${c.reset}${desc}`);
    }
    console.log();
  }
}

async function showCommand(name: string, args: string[]): Promise<void> {
  const cache = await scanCommands(args);
  const meta = cache.get(name);

  if (!meta) {
    console.error(`${c.red}Command not found: ${name}${c.reset}`);
    console.error(`${c.dim}Run 'ethos commands list' to see available commands.${c.reset}`);
    process.exit(1);
  }

  const def = meta.definition;

  console.log();
  console.log(`${c.bold}${def.name}${c.reset}`);
  console.log(`${c.dim}Scope:${c.reset}       ${def.scope}`);
  console.log(`${c.dim}File:${c.reset}        ${meta.filePath}`);
  console.log(`${c.dim}Description:${c.reset} ${def.description}`);

  if (def.allowedTools && def.allowedTools.length > 0) {
    console.log(`${c.dim}Tools:${c.reset}       ${def.allowedTools.join(', ')}`);
  }

  if (def.argumentHint) {
    console.log(`${c.dim}Arguments:${c.reset}   ${def.argumentHint}`);
  }

  // Show a prompt body preview (first 10 lines)
  const lines = def.prompt.split('\n');
  const previewLines = lines.slice(0, 10);
  const truncated = lines.length > 10;

  console.log();
  console.log(`${c.dim}--- prompt ---${c.reset}`);
  for (const line of previewLines) {
    console.log(`${c.dim}${line}${c.reset}`);
  }
  if (truncated) {
    console.log(`${c.dim}... (${lines.length - 10} more lines)${c.reset}`);
  }
  console.log();
}
