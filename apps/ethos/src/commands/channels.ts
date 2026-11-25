// `ethos channels` — an offline view of per-room prompts and policy
// (plan/phases/channel-prompts.md §7 L9).
//
//   ethos channels resolve <platform> <chatId> [threadId] [--dm] [--name <roomName>] [--json]
//   ethos channels list [--json]
//
// It builds the table through `loadRoomPolicies` (the one path both gateway
// hosts use, commands/gateway.ts) and resolves with the gateway's own
// `resolveRoomPolicy` / `renderRoomPrompt`, so the answer is what a live turn
// would get. Read-only: files are read through Storage, nothing is written.
// Only commands/gateway.ts may import @ethosagent/gateway (daemon-free-smoke.test.ts,
// archcheck l5), so the table comes through its `loadRoomPolicies` wrapper (which adds
// the lazily loaded platform mode enums) and everything else from
// `@ethosagent/wiring/room-policy`, the one implementation the web room editor also
// uses (plan channel-prompts-ui §3.1). index.ts loads this module lazily.

import { type EthosConfig, ethosDir } from '@ethosagent/config';
import { EthosError, type Storage } from '@ethosagent/types';
import {
  describeRoomEntries,
  previewRoomPolicy,
  previewRoomPolicyJson,
  readRoomPromptFiles,
} from '@ethosagent/wiring/room-policy';
import { loadRoomPolicies } from './gateway';

type RoomPolicyTable = NonNullable<Awaited<ReturnType<typeof loadRoomPolicies>>['table']>;

export interface ChannelsCliIo {
  /** One line; a newline is added. */
  out(line: string): void;
}

export interface ChannelsCliDeps {
  config: EthosConfig;
  storage: Storage;
  io?: ChannelsCliIo;
}

const CONSOLE_IO: ChannelsCliIo = { out: (line) => console.log(line) };

const USAGE =
  'ethos channels resolve <platform> <chatId> [threadId] [--dm] [--name <roomName>] [--json] | ethos channels list [--json]';

const usageError = (cause: string): EthosError =>
  new EthosError({ code: 'INVALID_INPUT', cause, action: `Usage: ${USAGE}` });

async function loadTable(
  storage: Storage,
  config: EthosConfig,
): Promise<{ table: RoomPolicyTable; warnings: string[] }> {
  const { table, warnings } = await loadRoomPolicies(storage, config);
  return { table: table ?? {}, warnings };
}

export async function runChannels(args: string[], config: EthosConfig, storage: Storage) {
  await runChannelsCommand(args, { config, storage });
}

export async function runChannelsCommand(
  args: readonly string[],
  deps: ChannelsCliDeps,
): Promise<void> {
  const io = deps.io ?? CONSOLE_IO;
  const json = args.includes('--json');
  const rest = args.filter((a) => a !== '--json');
  const [sub, ...tail] = rest;
  if (sub === 'resolve') return resolveCommand(tail, deps, io, json);
  if (sub === 'list') {
    if (tail.length > 0) throw usageError(`'list' takes no arguments (got '${tail.join(' ')}')`);
    return listCommand(deps, io, json);
  }
  throw usageError(sub ? `Unknown channels command '${sub}'` : 'Missing channels command');
}

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

interface ResolveArgs {
  platform: string;
  chatId: string;
  threadId?: string;
  isDm: boolean;
  roomName?: string;
}

/** Only `--dm` and `--name` are flags, so a Telegram id like `-100123` stays a positional. */
function parseResolveArgs(args: readonly string[]): ResolveArgs {
  const positional: string[] = [];
  let isDm = false;
  let roomName: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '--dm') isDm = true;
    else if (a === '--name') {
      const v = args[++i];
      if (v === undefined || v === '') throw usageError('--name needs a room name');
      roomName = v;
    } else if (a.startsWith('--')) throw usageError(`Unknown flag '${a}'`);
    else positional.push(a);
  }
  const [platform, chatId, threadId, ...extra] = positional;
  if (!platform) throw usageError('Missing <platform>');
  if (!chatId) throw usageError('Missing <chatId>');
  if (extra.length > 0) throw usageError(`Unexpected argument '${extra[0]}'`);
  return {
    platform,
    chatId,
    isDm,
    ...(threadId ? { threadId } : {}),
    ...(roomName ? { roomName } : {}),
  };
}

async function resolveCommand(
  args: readonly string[],
  deps: ChannelsCliDeps,
  io: ChannelsCliIo,
  json: boolean,
): Promise<void> {
  const input = parseResolveArgs(args);
  const { table, warnings } = await loadTable(deps.storage, deps.config);
  if (!Object.hasOwn(table, input.platform)) {
    const configured = Object.keys(table);
    throw new EthosError({
      code: 'INVALID_INPUT',
      cause: `No room entries for platform '${input.platform}' (configured: ${configured.length > 0 ? configured.join(', ') : 'none'})`,
      action: `Add channels.${input.platform}.<selector> entries to config.yaml or prompt files under ~/.ethos/channels/${input.platform}/, or run 'ethos channels list'.`,
    });
  }
  const { resolved, block, digest: rawDigest } = previewRoomPolicy(table, input);
  const digest = rawDigest ?? null;

  if (json) {
    io.out(JSON.stringify(previewRoomPolicyJson(table, input, warnings)));
    return;
  }

  const where = [
    `${input.platform} ${input.chatId}`,
    input.threadId ? `thread ${input.threadId}` : undefined,
    input.isDm ? 'DM' : undefined,
    input.roomName ? `name "${input.roomName}"` : undefined,
  ].filter(Boolean);
  io.out(`Room: ${where.join(', ')}`);
  io.out('');
  io.out(`match: ${resolved.matchKey ?? '(none)'} (${resolved.matchSource})`);
  io.out(`layers: ${resolved.layers.length > 0 ? resolved.layers.join(' -> ') : '(none)'}`);
  io.out('');
  io.out(`skills: ${resolved.skills ? resolved.skills.join(', ') : '(unset)'}`);
  io.out(`model: ${resolved.model ?? '(unset)'}`);
  io.out(`tier: ${resolved.tier ?? '(unset)'}`);
  io.out(`identity: ${resolved.identity}`);
  io.out(`metadata: ${resolved.metadata}`);
  io.out(`silent: ${resolved.silent}`);
  io.out(
    `mode: ${resolved.mode ?? '(unset)'}${resolved.modeKey ? ` (from ${resolved.modeKey})` : ''}`,
  );
  io.out(
    `prompt layers: ${resolved.promptLayers.length > 0 ? resolved.promptLayers.map((l) => `${l.key} (${l.prompt.length} chars)`).join(', ') : '(none)'}`,
  );
  io.out('');
  io.out(`digest: ${digest ?? '(no room block)'}`);
  io.out(
    'Rendered room block (the identity line is omitted: the bot handle is unknown offline, so a live digest differs when identity is on):',
  );
  io.out('-----');
  io.out(block ?? '(empty: this room adds nothing to the system prompt)');
  io.out('-----');
  if (warnings.length > 0) {
    io.out('');
    io.out('Boot warnings:');
    for (const w of warnings) io.out(`  - ${w}`);
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function listCommand(deps: ChannelsCliDeps, io: ChannelsCliIo, json: boolean): Promise<void> {
  const { table, warnings } = await loadTable(deps.storage, deps.config);
  const read = await readRoomPromptFiles(deps.storage, ethosDir());
  const platforms = describeRoomEntries(deps.config, read.files, table);

  if (json) {
    io.out(JSON.stringify({ ok: true, platforms, warnings }));
    return;
  }
  const names = Object.keys(platforms);
  if (names.length === 0) {
    io.out(
      'No room entries configured. Add channels.<platform>.<selector> to config.yaml or a prompt file under ~/.ethos/channels/<platform>/.',
    );
  }
  for (const name of names) {
    const rows = platforms[name]?.entries ?? [];
    const w = Math.max(...rows.map((r) => r.selector.length));
    const w2 = Math.max(...rows.map((r) => r.fields.join(', ').length));
    io.out(name);
    for (const r of rows) {
      io.out(
        `  ${r.selector.padEnd(w)}  ${r.fields.join(', ').padEnd(w2)}  ${r.sources.join(' + ')}`,
      );
    }
  }
  if (warnings.length > 0) {
    io.out('');
    io.out('Boot warnings:');
    for (const w of warnings) io.out(`  - ${w}`);
  }
}
