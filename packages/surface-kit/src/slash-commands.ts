// ---------------------------------------------------------------------------
// Shared slash-command definitions
//
// The single source of truth for the built-in slash-command SET (names,
// aliases, descriptions, usage). Three surfaces historically kept their own
// lists — the CLI autocomplete registry (`apps/ethos/src/lib/slash-commands`),
// the gateway's `PLATFORM_COMMANDS`, and the web-api RPC router. Definitions
// live here; each surface keeps its own EXECUTION (CLI mutates REPL state,
// gateway posts to a channel, web-api answers an RPC) and its own subset via
// the `surfaces` tag.
//
// Command *meaning* is intentionally NOT encoded here beyond the description —
// where two surfaces execute the same-named command differently (e.g.
// `/personality` is a live switch in the CLI but soft-rejected for
// identity-bound gateway bots), that divergence is preserved in each surface's
// executor, not averaged away in this registry.
// ---------------------------------------------------------------------------

export type SlashSurface = 'cli' | 'gateway' | 'web';

export interface SlashCommandDef {
  name: string;
  /** One-line description shown in help / autocomplete. */
  description: string;
  usage: string;
  /** Surfaces that advertise this command in their command list. */
  surfaces: SlashSurface[];
  /** When set, this command is an alias that behaves like the named command. */
  aliasOf?: string;
}

/**
 * The reconciled union of every surface's built-in commands. The CLI-advertised
 * subset (`surfaces.includes('cli')`) appears first, in the CLI's historical
 * order, so a `filter(cli)` reproduces the legacy autocomplete list byte-for-byte.
 * Gateway-only commands follow.
 */
export const SLASH_COMMANDS: readonly SlashCommandDef[] = [
  {
    name: 'help',
    description: 'Show all slash commands',
    usage: '/help',
    surfaces: ['cli', 'gateway'],
  },
  {
    name: 'new',
    description: 'Start a fresh session',
    usage: '/new',
    surfaces: ['cli', 'gateway'],
  },
  {
    name: 'reset',
    description: 'Alias for /new',
    usage: '/reset',
    surfaces: ['cli', 'gateway'],
    aliasOf: 'new',
  },
  {
    name: 'personality',
    description: 'Show or switch personality',
    usage: '/personality [id|list]',
    surfaces: ['cli', 'gateway'],
  },
  {
    name: 'model',
    description: 'Show current model (switch requires restart)',
    usage: '/model [name]',
    surfaces: ['cli'],
  },
  {
    name: 'tier',
    description: 'Override LLM tier for next turn',
    usage: '/tier [trivial|default|deep|status]',
    surfaces: ['cli'],
  },
  {
    name: 'memory',
    description: 'Show ~/.ethos/MEMORY.md and USER.md',
    usage: '/memory',
    surfaces: ['cli'],
  },
  {
    name: 'usage',
    description: 'Show token and cost stats',
    usage: '/usage',
    surfaces: ['cli', 'gateway'],
  },
  {
    name: 'budget',
    description: 'Show session spend against cap',
    usage: '/budget [reset]',
    surfaces: ['cli'],
  },
  {
    name: 'verbose',
    description: 'Cycle or set output verbosity',
    usage: '/verbose [quiet|default|verbose|debug|status]',
    surfaces: ['cli'],
  },
  {
    name: 'busy',
    description: 'Set busy-input mode',
    usage: '/busy [interrupt|queue|steer|status]',
    surfaces: ['cli'],
  },
  {
    name: 'steer',
    description: 'Inject a user steer mid-turn',
    usage: '/steer <text>',
    surfaces: ['cli'],
  },
  {
    name: 'allow',
    description: 'Approve a pending channel sender',
    usage: '/allow <code>',
    surfaces: ['cli', 'gateway'],
  },
  {
    name: 'deny',
    description: 'Revoke an approved channel sender',
    usage: '/deny <platform> <id>',
    surfaces: ['cli', 'gateway'],
  },
  {
    name: 'communications',
    description: 'List approved senders and pairing codes',
    usage: '/communications',
    surfaces: ['cli', 'gateway'],
  },
  {
    name: 'commands',
    description: 'List available commands',
    usage: '/commands',
    surfaces: ['cli'],
  },
  {
    name: 'learn',
    description: 'Capture knowledge as memory or skill',
    usage: '/learn [remember:|skill:] <description>',
    surfaces: ['cli'],
  },
  {
    name: 'undo',
    description: 'Undo last N turns (default 1)',
    usage: '/undo [N]',
    surfaces: ['cli'],
  },
  { name: 'exit', description: 'Quit ethos', usage: '/exit', surfaces: ['cli'] },
  {
    name: 'quit',
    description: 'Alias for /exit',
    usage: '/quit',
    surfaces: ['cli'],
    aliasOf: 'exit',
  },
  // --- Gateway-only built-ins (channel surfaces) ---
  {
    name: 'stop',
    description: 'Abort the current response',
    usage: '/stop',
    surfaces: ['gateway'],
  },
  {
    name: 'start',
    description: 'Greeting / onboarding message',
    usage: '/start',
    surfaces: ['gateway'],
  },
  {
    name: 'queue',
    description: 'Show queued turns for this chat',
    usage: '/queue',
    surfaces: ['gateway'],
  },
  {
    name: 'background',
    description: 'Spawn a background agent task',
    usage: '/background <prompt>',
    surfaces: ['gateway'],
  },
  {
    name: 'voice',
    description: 'Set voice reply mode (off|mirror_inbound|all)',
    usage: '/voice [off|mirror_inbound|all]',
    surfaces: ['gateway'],
  },
];

/** A parsed slash-command invocation. */
export interface ParsedSlashCommand {
  /** Command name, lowercased, without the leading slash. */
  name: string;
  /** Remaining tokens after the name. */
  args: string[];
  /** `args` re-joined with single spaces — the CLI's argument string. */
  arg: string;
}

/**
 * Parse a raw slash-command line into `{ name, args, arg }`. Mirrors the
 * historical CLI parse: strip the leading slash, trim, split on whitespace,
 * lowercase the command name. An empty / whitespace-only body yields an empty
 * name. Does not validate the command against `SLASH_COMMANDS`.
 */
export function parseSlashCommand(raw: string): ParsedSlashCommand {
  const body = raw.startsWith('/') ? raw.slice(1) : raw;
  const parts = body.trim().split(/\s+/);
  const name = parts[0]?.toLowerCase() ?? '';
  const args = parts.slice(1);
  return { name, args, arg: args.join(' ') };
}

/** Look up a command definition by name (exact, case-sensitive on the stored
 *  lowercase names). Returns `undefined` for unknown names. */
export function getSlashCommand(name: string): SlashCommandDef | undefined {
  return SLASH_COMMANDS.find((cmd) => cmd.name === name);
}

/** Resolve a name to its canonical command, following one `aliasOf` hop.
 *  Returns `undefined` for unknown names. */
export function resolveSlashCommand(name: string): SlashCommandDef | undefined {
  const cmd = getSlashCommand(name);
  if (!cmd) return undefined;
  return cmd.aliasOf ? getSlashCommand(cmd.aliasOf) : cmd;
}

/** All commands advertised on a given surface, in registry order. */
export function slashCommandsForSurface(surface: SlashSurface): SlashCommandDef[] {
  return SLASH_COMMANDS.filter((cmd) => cmd.surfaces.includes(surface));
}
