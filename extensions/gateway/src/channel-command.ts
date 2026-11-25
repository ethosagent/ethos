import type { ResolvedRoomPolicy, RoomIdentity } from './room-policy';
import type { RoomTurnPolicy } from './room-turn';

// Pure formatting for the gateway's `/channel` command (plan channel-prompts
// §3.12, D17). The summary is open to the room (it names keys and counts, never
// prompt text); `show` appends the rendered prompt and is gated by
// `channelShowAccess`, which `Gateway.handleMessage` enforces before it ever
// calls `formatChannelShow`. Pinned by `__tests__/channel-command.test.ts`.

export type ChannelModeSource = 'runtime' | 'room' | 'platform' | 'default';

const MODE_SOURCES: readonly string[] = ['runtime', 'room', 'platform', 'default'];

/** Narrow an adapter-stamped, possibly absent value; anything unknown reads as absent. */
export function parseChannelModeSource(v: unknown): ChannelModeSource | undefined {
  return typeof v === 'string' && MODE_SOURCES.includes(v) ? (v as ChannelModeSource) : undefined;
}

export interface ChannelSummaryInput {
  platform: string;
  chatId: string;
  threadId?: string;
  isDm: boolean;
  /** False when the gateway has no room-policy table at all. */
  configured: boolean;
  /** Absent when the table has no entry for this platform. */
  resolved?: ResolvedRoomPolicy;
  turn?: RoomTurnPolicy;
  /** The adapter's identity for this room, when it reports one. */
  identity?: RoomIdentity;
  /** `InboundMessage.channelMode` / `channelModeSource` when the adapter stamped them. */
  channelMode?: string;
  channelModeSource?: ChannelModeSource;
}

function roomLine(i: ChannelSummaryInput): string {
  const parts = `Room: ${i.platform} · ${i.chatId}`;
  if (i.isDm) return `${parts} · DM`;
  if (!i.threadId) return parts;
  return `${parts} · ${i.platform === 'telegram' ? 'topic' : 'thread'} ${i.threadId}`;
}

function matchedLine(r: ResolvedRoomPolicy): string {
  const wildcard = r.layers.filter((k) => k === '*' || k === '*dm');
  const chain = r.layers.filter((k) => k !== '*' && k !== '*dm');
  const wild = wildcard.length > 0 ? `wildcard ${wildcard[0]} used` : 'wildcard not used';
  if (chain.length === 0) return `Matched: ${r.matchKey} (wildcard) · ${wild}`;
  const [head, ...rest] = chain;
  return `Matched: ${[`${head} (${r.matchSource})`, ...rest.map((k) => `${k} (parent)`)].join(' → ')} · ${wild}`;
}

function modeLine(i: ChannelSummaryInput, r: ResolvedRoomPolicy): string {
  const mode = i.channelMode ?? r.mode;
  if (mode === undefined) return 'Mode: not set by this room';
  const roomCfg = r.modeKey !== undefined ? `room config: ${r.modeKey}` : 'room config';
  const src = i.channelModeSource;
  const label =
    src === 'room'
      ? roomCfg
      : src === 'runtime'
        ? 'runtime override'
        : src === 'platform'
          ? 'platform default'
          : src === 'default'
            ? 'built-in default'
            : i.channelMode === undefined
              ? roomCfg
              : 'source not reported';
  return `Mode: ${mode} (${label})`;
}

function identityText(i: ChannelSummaryInput, r: ResolvedRoomPolicy): string {
  if (!r.identity) return 'off';
  if (i.isDm) return 'off (DM)';
  return i.identity?.handle ? `on (@${i.identity.handle})` : 'on (adapter reports no handle)';
}

/** The summary text. Never contains prompt text. */
export function formatChannelSummary(i: ChannelSummaryInput): string {
  const room = roomLine(i);
  if (!i.configured) return `Room policies are not configured.\n${room}`;
  const r = i.resolved;
  if (!r || r.matchSource === 'none') return `No room policy for this room.\n${room}`;

  const turn = i.turn;
  const layerCount = Math.max(0, r.promptLayers.length - (turn?.trimmed.length ?? 0));
  const prompt =
    turn?.prompt === undefined
      ? 'Prompt: none'
      : `Prompt: ${layerCount} ${layerCount === 1 ? 'layer' : 'layers'} · ${turn.prompt.length} chars · sha ${turn.digest ?? 'n/a'}` +
        (turn.trimmed.length > 0 ? ` · over cap, dropped: ${turn.trimmed.join(', ')}` : '');
  const skills = r.skills && r.skills.length > 0 ? r.skills.join(', ') : 'none';
  const modelParts = [r.model ? `model ${r.model}` : '', r.tier ? `tier ${r.tier}` : ''].filter(
    Boolean,
  );
  const model = modelParts.length > 0 ? modelParts.join(', ') : 'default';
  return [
    room,
    matchedLine(r),
    prompt,
    `Skills: ${skills} · Model: ${model} · Identity: ${identityText(i, r)} · Metadata: ${turn?.metadata ? 'on' : 'off'} · Silent: ${r.silent ? 'on' : 'off'} · ${modeLine(i, r)}`,
  ].join('\n');
}

export type ChannelShowAccess = 'allow' | 'not_owner' | 'group';

/** `show` reveals operator prompt text: owner only, and only in a DM lane. */
export function channelShowAccess(input: { isOwner: boolean; isDm: boolean }): ChannelShowAccess {
  if (!input.isOwner) return 'not_owner';
  return input.isDm ? 'allow' : 'group';
}

export const CHANNEL_SHOW_NOT_OWNER_TEXT = 'Only the owner can use /channel show.';
export const CHANNEL_SHOW_GROUP_TEXT =
  '/channel show prints this room’s full prompt, so it only runs in a DM with the owner. ' +
  'Run it in a DM, or use `ethos channels resolve <platform> <chatId> [threadId]` on the host.';

/** The full rendered room block, for `/channel show` after `channelShowAccess` allowed it. */
export function formatChannelShow(turn: RoomTurnPolicy | undefined): string {
  return turn?.prompt === undefined
    ? 'Rendered room block: (none)'
    : `Rendered room block:\n---\n${turn.prompt}\n---`;
}

export function isChannelShowArg(text: string): boolean {
  return (text.trim().split(/\s+/)[1] ?? '').toLowerCase() === 'show';
}
