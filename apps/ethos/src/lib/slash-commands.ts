// FW-14 — shared slash command registry. Both the executor in chat.ts and
// the autocomplete surface share this single source, so descriptions and
// names never drift.

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

  register(cmd: SlashCommand): void {
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

export const builtInCommands: SlashCommand[] = [
  { name: 'help', description: 'Show all slash commands', usage: '/help' },
  { name: 'new', description: 'Start a fresh session', usage: '/new' },
  { name: 'reset', description: 'Alias for /new', usage: '/reset' },
  {
    name: 'personality',
    description: 'Show or switch personality',
    usage: '/personality [id|list]',
  },
  {
    name: 'model',
    description: 'Show current model (switch requires restart)',
    usage: '/model [name]',
  },
  {
    name: 'tier',
    description: 'Override LLM tier for next turn',
    usage: '/tier [trivial|default|deep|status]',
  },
  { name: 'memory', description: 'Show ~/.ethos/MEMORY.md and USER.md', usage: '/memory' },
  { name: 'usage', description: 'Show token and cost stats', usage: '/usage' },
  { name: 'budget', description: 'Show session spend against cap', usage: '/budget [reset]' },
  {
    name: 'verbose',
    description: 'Cycle or set output verbosity',
    usage: '/verbose [quiet|default|verbose|debug|status]',
  },
  {
    name: 'busy',
    description: 'Set busy-input mode',
    usage: '/busy [interrupt|queue|steer|status]',
  },
  { name: 'steer', description: 'Inject a user steer mid-turn', usage: '/steer <text>' },
  { name: 'allow', description: 'Approve a pending channel sender', usage: '/allow <code>' },
  {
    name: 'deny',
    description: 'Revoke an approved channel sender',
    usage: '/deny <platform> <id>',
  },
  {
    name: 'communications',
    description: 'List approved senders and pairing codes',
    usage: '/communications',
  },
  { name: 'undo', description: 'Undo last N turns (default 1)', usage: '/undo [N]' },
  { name: 'exit', description: 'Quit ethos', usage: '/exit' },
  { name: 'quit', description: 'Alias for /exit', usage: '/quit' },
];

export function buildBaseRegistry(): SlashCommandRegistry {
  const registry = new SlashCommandRegistry();
  for (const cmd of builtInCommands) {
    registry.register(cmd);
  }
  return registry;
}
