import { shortPatternCheck, wrapUntrusted } from '@ethosagent/safety-injection';
import type { InboundMessage, ModelTierName } from '@ethosagent/types';
import {
  type ResolvedRoomPolicy,
  ROOM_BLOCK_MAX_CHARS,
  type RoomIdentity,
  type RoomPolicyInput,
  type RoomPolicyTable,
  renderRoomPrompt,
  resolveRoomPolicy,
  roomPolicyDigest,
} from './room-policy';

// The per-turn face of the room policy table (plan channel-prompts D1, D8, D9):
// resolve for a lane, hand `Gateway.runTurn` the already-rendered block.
// Resolution is pure over a table that is static per process, so the same
// inputs always give the same bytes and nothing is memoised.

/** `Session.metadata` key holding the last room-policy digest (plan channel-prompts D8). */
export const ROOM_POLICY_DIGEST_KEY = 'roomPolicyDigest';
/** `Session.metadata` key holding whether the lane's real inbound messages are DMs. */
export const ROOM_POLICY_IS_DM_KEY = 'roomPolicyIsDm';

export interface RoomTurnPolicy {
  /** The rendered `## This room` text; absent when the room has nothing to say. */
  prompt: string | undefined;
  skills: readonly string[] | undefined;
  model: string | undefined;
  tier: ModelTierName | undefined;
  /** The room opted in to `NO_REPLY` / `[SILENT]` sending nothing (plan L11, D20). */
  silent: boolean;
  /** `roomPolicyDigest(prompt)`; undefined when there is no prompt. */
  digest: string | undefined;
  /**
   * Untrusted room metadata may ride on the user message: the resolved entry has
   * `metadata: true` AND the platform has `fetch_metadata: true` (plan D14).
   */
  metadata: boolean;
  /** Selectors whose prompt was dropped to fit `ROOM_BLOCK_MAX_CHARS`, most specific first. */
  trimmed: string[];
}

/** What the gateway remembers per session between turns. */
export interface RoomLaneNote {
  /** DM-ness of the lane's last real inbound message. */
  isDm?: boolean;
  digest?: string;
  /** The block-cap trim was already reported for this session. */
  trimWarned?: boolean;
  /** `roomMetadataDigest` of the metadata block last offered on this lane. */
  metaDigest?: string;
}

/** Insertion-ordered LRU: the oldest session is evicted past `max`. */
export class RoomLaneNotes {
  private readonly map = new Map<string, RoomLaneNote>();
  constructor(private readonly max = 2000) {}

  get(key: string): RoomLaneNote | undefined {
    const v = this.map.get(key);
    if (v) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, note: RoomLaneNote): void {
    this.map.delete(key);
    this.map.set(key, note);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
  }
}

export class RoomTurnPolicies {
  private readonly table: RoomPolicyTable | undefined;

  /** An empty table is no table: unconfigured deployments do no per-turn work. */
  constructor(table: RoomPolicyTable | undefined) {
    this.table = table && Object.keys(table).length > 0 ? table : undefined;
  }

  get enabled(): boolean {
    return this.table !== undefined;
  }

  /** Whether `platform` has a table entry; a platform without one gets no room options. */
  appliesTo(platform: string): boolean {
    return this.table !== undefined && Object.hasOwn(this.table, platform);
  }

  /**
   * What `/channel` reports (plan channel-prompts §3.12): the resolution and the
   * rendered turn policy for a room, from the same functions `runTurn` uses.
   * `configured` is false when there is no table at all; `resolved` is absent
   * when the table has nothing for this platform.
   */
  inspect(
    input: RoomPolicyInput,
    identity: RoomIdentity | undefined,
  ): { configured: boolean; resolved?: ResolvedRoomPolicy; turn?: RoomTurnPolicy } {
    if (!this.table) return { configured: false };
    if (!this.appliesTo(input.platform)) return { configured: true };
    return {
      configured: true,
      resolved: resolveRoomPolicy(this.table, input),
      turn: this.forTurn(input, identity),
    };
  }

  forTurn(input: RoomPolicyInput, identity: RoomIdentity | undefined): RoomTurnPolicy | undefined {
    if (!this.table) return undefined;
    const resolved = resolveRoomPolicy(this.table, input);
    // Whole-block cap (plan D16, never truncate): drop the most specific layer's
    // prompt until the rendered block fits. Enforced here because only the
    // gateway knows the chain AND the identity line that share the budget.
    const layers = [...resolved.promptLayers];
    const trimmed: string[] = [];
    const render = (): string | undefined =>
      renderRoomPrompt(
        {
          prompt: layers.map((l) => l.prompt).join('\n\n'),
          identity: resolved.identity,
          silent: resolved.silent,
        },
        identity,
      );
    let prompt = render();
    while (prompt !== undefined && prompt.length > ROOM_BLOCK_MAX_CHARS && layers.length > 0) {
      const dropped = layers.pop();
      if (dropped) trimmed.push(dropped.key);
      prompt = render();
    }
    return {
      prompt,
      skills: resolved.skills && resolved.skills.length > 0 ? resolved.skills : undefined,
      model: resolved.model,
      tier: resolved.tier,
      silent: resolved.silent,
      metadata: resolved.metadata && this.table[input.platform]?.fetchMetadata === true,
      digest: prompt === undefined ? undefined : roomPolicyDigest(prompt),
      trimmed,
    };
  }
}

/** Per-field caps for untrusted room metadata (plan channel-prompts §5). */
export const ROOM_METADATA_TOPIC_MAX = 800;
export const ROOM_METADATA_PURPOSE_MAX = 800;
export const ROOM_METADATA_NAME_MAX = 400;
const TRUNCATION_MARK = '…[truncated]';

export interface RoomMetadataBlock {
  /** `wrapUntrusted` text (`channel_metadata`), absent when blocked or empty. */
  text: string | undefined;
  /** sha8 of the capped plain text; the change detector. Absent when empty. */
  digest: string | undefined;
  /** `shortPatternCheck` rules that fired; the block was dropped. */
  blockedRules: string[];
  truncated: boolean;
}

function capField(value: string, max: number): { text: string; truncated: boolean } {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max
    ? { text: `${flat.slice(0, max)}${TRUNCATION_MARK}`, truncated: true }
    : { text: flat, truncated: false };
}

/**
 * Build the untrusted metadata block for a turn's USER message (plan
 * channel-prompts D14). Metadata is member-editable, so it is truncated (it is
 * context, not policy: unlike room prompts it is capped, not dropped), scanned
 * with `shortPatternCheck` (a hit drops the whole block), and fenced by
 * `wrapUntrusted` with source `channel_metadata`. It never enters the system
 * prompt: the caller prepends it to the turn text. Pinned by
 * `__tests__/room-metadata.test.ts`.
 */
export function buildRoomMetadataBlock(
  meta: InboundMessage['roomMetadata'] | undefined,
): RoomMetadataBlock {
  const lines: string[] = [];
  let truncated = false;
  const add = (label: string, value: string | undefined, max: number): void => {
    if (!value) return;
    const c = capField(value, max);
    if (!c.text) return;
    truncated ||= c.truncated;
    lines.push(`${label}: ${c.text}`);
  };
  add('name', meta?.name, ROOM_METADATA_NAME_MAX);
  add('topic', meta?.topic, ROOM_METADATA_TOPIC_MAX);
  add('purpose', meta?.purpose, ROOM_METADATA_PURPOSE_MAX);
  if (lines.length === 0)
    return { text: undefined, digest: undefined, blockedRules: [], truncated };
  const plain = lines.join('\n');
  const digest = roomPolicyDigest(plain);
  const check = shortPatternCheck(plain);
  if (check.containsInstructions) {
    return { text: undefined, digest, blockedRules: check.hits.map((h) => h.rule), truncated };
  }
  const wrapped = wrapUntrusted({ content: plain, toolName: 'channel_metadata' });
  return { text: wrapped.content, digest, blockedRules: [], truncated };
}
