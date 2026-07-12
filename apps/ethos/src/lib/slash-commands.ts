// FW-14 — shared slash command registry. Both the executor in chat.ts and
// the autocomplete surface share this single source, so descriptions and
// names never drift.
//
// The built-in command SET now lives in `@ethosagent/surface-kit` (the
// cross-surface source of truth); `builtInCommands` below is the CLI-advertised
// subset, derived from it. This registry class remains CLI-local — it also
// holds plugin/skill/quick commands that are not surface-shared.

import { slashCommandsForSurface } from '@ethosagent/surface-kit';

export interface SlashCommand {
  name: string;
  /** One-line description shown in the autocomplete dropdown. */
  description: string;
  usage: string;
  /** Display prefix for non-built-in commands: '[skill]' or '[quick]'. */
  prefix?: string;
}

export class SlashCommandRegistry {
  private readonly commands = new Map<string, SlashCommand>();
  private readonly builtIns = new Set<string>();

  registerBuiltIn(cmd: SlashCommand): void {
    this.builtIns.add(cmd.name);
    this.commands.set(cmd.name, cmd);
  }

  register(cmd: SlashCommand): void {
    if (this.builtIns.has(cmd.name)) return;
    this.commands.set(cmd.name, cmd);
  }

  unregister(name: string): void {
    this.commands.delete(name);
  }

  getAll(): SlashCommand[] {
    return [...this.commands.values()];
  }

  filter(prefix: string): SlashCommand[] {
    const lower = prefix.toLowerCase();
    return this.getAll().filter((cmd) => cmd.name.startsWith(lower));
  }

  get(name: string): SlashCommand | undefined {
    return this.commands.get(name);
  }
}

export const builtInCommands: SlashCommand[] = slashCommandsForSurface('cli').map((cmd) => ({
  name: cmd.name,
  description: cmd.description,
  usage: cmd.usage,
}));

export function buildBaseRegistry(): SlashCommandRegistry {
  const registry = new SlashCommandRegistry();
  for (const cmd of builtInCommands) {
    registry.registerBuiltIn(cmd);
  }
  return registry;
}
