// Per-room prompt/policy collaborator for `Gateway` (plan channel-prompts):
// room-policy resolution, lane notes, digest/trim audit, `/channel`, and the
// silent-reply audit. Moved out of index.ts to keep it under the size limit.
// Owns the policy table and lane notes; every other input is read live through
// `deps` accessors from the fields `Gateway` owns.

import type { PrivateChatSet } from '@ethosagent/core';
import type { InboundMessage, PlatformAdapter, SessionStore } from '@ethosagent/types';
import {
  CHANNEL_SHOW_GROUP_TEXT,
  CHANNEL_SHOW_NOT_OWNER_TEXT,
  channelShowAccess,
  formatChannelShow,
  formatChannelSummary,
  isChannelShowArg,
  parseChannelModeSource,
} from './channel-command';
import type { GatewayBotConfig, GatewayObservability } from './gateway-config';
import type { WakeReview } from './gateway-pure';
import type { RoomIdentity } from './room-policy';
import {
  buildRoomMetadataBlock,
  ROOM_POLICY_DIGEST_KEY,
  ROOM_POLICY_IS_DM_KEY,
  RoomLaneNotes,
  RoomTurnPolicies,
  type RoomTurnPolicy,
} from './room-turn';
import { isPrivateDm } from './silent-reply';

/** What `RoomGateway` reads from `Gateway`; getters, so every read is live. */
export interface RoomGatewayDeps {
  observability(): GatewayObservability | undefined;
  sessionStoreFor(): (() => SessionStore) | undefined;
  privateChats(): PrivateChatSet | undefined;
  isOwner(message: InboundMessage): boolean;
}

export class RoomGateway {
  /** Per-room prompt and policy, resolved every turn; pure over a static table, no memo (room-turn.ts `forTurn`). */
  readonly policies: RoomTurnPolicies;
  /** Bounded per-session notes (digest, lane DM-ness, trim warned): the D8 fallback while the session has no stored row. */
  private readonly notes = new RoomLaneNotes();

  constructor(
    roomPolicies: ConstructorParameters<typeof RoomTurnPolicies>[0],
    private readonly deps: RoomGatewayDeps,
  ) {
    this.policies = new RoomTurnPolicies(roomPolicies);
  }

  /**
   * Per-room prompt and policy for one turn (plan channel-prompts D1), resolved
   * at `runTurn`'s one choke point: message, wake review, spool replay, voice
   * note and Slack /ethos ask all reach it with their room's coordinates. Pure
   * over a static table, so the block is byte-stable per lane. A wake review's
   * synthetic message is always `isDm: false`, so its real DM-ness comes from
   * `reviewIsDm`. `metaText` is the untrusted room metadata (D14) for the USER
   * message, never the system prompt, on a lane's first turn and on change.
   */
  async resolveTurn(input: {
    message: InboundMessage;
    adapter: PlatformAdapter;
    threadId: string | undefined;
    review: WakeReview | undefined;
    sessionKey: string;
    laneSessionKey: string;
  }): Promise<{ room: RoomTurnPolicy | undefined; metaText: string | undefined }> {
    const { message, adapter, threadId, review, sessionKey, laneSessionKey } = input;
    if (!this.policies.appliesTo(message.platform)) return { room: undefined, metaText: undefined };
    const isDm = review ? await this.reviewIsDm(review, message, laneSessionKey) : message.isDm;
    const room = this.policies.forTurn(
      {
        platform: message.platform,
        chatId: message.chatId,
        ...(threadId ? { threadId } : {}),
        isDm,
      },
      this.identityFor(adapter, isDm),
    );
    if (room && room.trimmed.length > 0) this.noteTrim(sessionKey, message, room);
    const metaText =
      room?.metadata && !review && !isDm ? this.metadataFor(sessionKey, message) : undefined;
    return { room, metaText };
  }

  /** The AgentLoop run options a resolved room contributes besides `roomPrompt` (which `runTurn` passes inline for the census). */
  loopOptions(room: RoomTurnPolicy | undefined) {
    return {
      ...(room?.skills ? { roomSkills: room.skills } : {}),
      // model/tier are mutually exclusive (the loader keeps `model`).
      ...(room?.model
        ? { modelOverride: room.model, modelOverrideSource: 'room' as const }
        : room?.tier
          ? { tierOverride: room.tier }
          : {}),
    };
  }

  /**
   * A silent room's turn ended with a marker (plan channel-prompts L11, D20):
   * audit it and tell the adapter the turn ended without a reply so it can
   * retract a transient "thinking" placeholder (Discord). Fail open: the
   * silence stands whether or not the adapter could tidy up.
   */
  async endSilentTurn(
    adapter: PlatformAdapter,
    message: InboundMessage,
    bot: GatewayBotConfig,
    threadId: string | undefined,
    reviewJobId: string | undefined,
  ): Promise<void> {
    this.recordSilentReply(message, bot, reviewJobId);
    try {
      await adapter.endTurn?.(message.chatId, { ...(threadId ? { threadId } : {}) });
    } catch {
      // best effort
    }
  }

  /**
   * Whether this message's room is `silent: true`. A silent room never gets a
   * visible gateway ack (steer, queued), since the turn itself posts nothing.
   * Same `RoomTurnPolicies.forTurn` the turn uses; no identity, which cannot
   * change `silent`. Pinned by 'silent room — acks' in room-silence.test.ts.
   */
  isSilent(message: InboundMessage, threadId: string | undefined): boolean {
    if (!this.policies.appliesTo(message.platform)) return false;
    return (
      this.policies.forTurn(
        {
          platform: message.platform,
          chatId: message.chatId,
          ...(threadId ? { threadId } : {}),
          isDm: message.isDm,
        },
        undefined,
      )?.silent === true
    );
  }

  /**
   * The bot's identity for the room prompt's identity line (plan channel-prompts
   * §3.8, D10), from the adapter's own platform auth. Static per bot, so the
   * rendered line is byte-stable across a lane's turns. `isDm` lets the renderer
   * keep it out of DMs. `undefined` while the adapter does not know itself yet.
   * Limitation: an identity that arrives after a lane's first turn changes the
   * rendered block once (a one-time prefix-cache miss); nothing pins it.
   */
  identityFor(adapter: PlatformAdapter, isDm: boolean): RoomIdentity | undefined {
    const self = adapter.selfIdentity?.();
    if (!self) return undefined;
    return {
      handle: self.handle,
      ...(self.platformUserId ? { platformUserId: self.platformUserId } : {}),
      isDm,
    };
  }

  /**
   * The wrapped metadata block to prepend to this turn's text, or undefined
   * when there is none to send: no metadata on the message, the lane already
   * saw this exact block (`RoomLaneNote.metaDigest`), or `shortPatternCheck`
   * dropped it (recorded once per change as `gateway.room_metadata_blocked`).
   * Pinned by `__tests__/room-metadata.test.ts`.
   */
  metadataFor(sessionKey: string, message: InboundMessage): string | undefined {
    const block = buildRoomMetadataBlock(message.roomMetadata);
    if (!block.digest) return undefined;
    const note = this.notes.get(sessionKey) ?? {};
    if (note.metaDigest === block.digest) return undefined;
    this.notes.set(sessionKey, { ...note, metaDigest: block.digest });
    if (block.blockedRules.length > 0) {
      this.deps.observability()?.recordSafetyBlock({
        code: 'gateway.room_metadata_blocked',
        cause: 'room metadata looked like instructions; it was not sent to the model',
        details: {
          platform: message.platform,
          chatId: message.chatId,
          sessionKey,
          rules: block.blockedRules,
        },
      });
      return undefined;
    }
    return block.text;
  }

  /**
   * Whether a wake review's lane is a DM. The review's synthetic message is
   * always `isDm: false` (wake-review.ts), so the answer comes from what the
   * lane's last real-message turn stored (`noteRoomPolicyDigest`): the session
   * row, else the in-process note. With nothing stored (a cold restart before
   * any message) a private job audience on a chat NOT listed in `private_chats`
   * reads as a DM; a listed chat is a group the operator trusts, never a DM.
   * Limitation: a DM whose job was stamped shared reads as a room until its
   * first real message. Pinned by 'wake review isDm' in room-policy-gateway.test.ts.
   */
  async reviewIsDm(
    review: WakeReview,
    message: InboundMessage,
    sessionKey: string,
  ): Promise<boolean> {
    try {
      const store = this.deps.sessionStoreFor()?.();
      const session = store ? await store.getSessionByKey(sessionKey) : null;
      const stored = session?.metadata?.[ROOM_POLICY_IS_DM_KEY];
      if (typeof stored === 'boolean') return stored;
    } catch {
      // Fail-open to the note / inference below.
    }
    const noted = this.notes.get(sessionKey)?.isDm;
    if (noted !== undefined) return noted;
    return (
      review.roomAudience === 'private' &&
      !this.deps.privateChats()?.has(message.platform, message.chatId)
    );
  }

  /** Once per session: the room block was cut to fit the whole-block cap (D16). */
  noteTrim(sessionKey: string, message: InboundMessage, room: RoomTurnPolicy): void {
    const note = this.notes.get(sessionKey) ?? {};
    if (note.trimWarned) return;
    this.notes.set(sessionKey, { ...note, trimWarned: true });
    this.deps.observability()?.recordSafetyBlock({
      code: 'gateway.room_prompt_trimmed',
      cause:
        'the room prompt chain is over the whole-block cap; the most specific layers were dropped, not truncated',
      details: {
        platform: message.platform,
        chatId: message.chatId,
        sessionKey,
        dropped: room.trimmed,
      },
    });
  }

  /**
   * D8 — record the room-policy digest and the lane's DM-ness this session ran
   * under, and emit `gateway.room_policy_changed` once when the digest differs
   * from the last one seen (an operator edited `channels.*` and restarted: the
   * next turn re-caches). Called only for real-message (authoritative) turns,
   * never a wake review, whose `isDm` is synthetic. Stored in
   * `Session.metadata` once the session row exists (after its first turn); the
   * bounded in-process note covers a store-less gateway. The write MERGES into
   * metadata (`updateSession` replaces it wholesale) and runs only after the
   * turn's iterator is drained, when core no longer writes the row. Fail-open.
   */
  async notePolicyDigest(
    sessionKey: string,
    message: InboundMessage,
    room: RoomTurnPolicy | undefined,
  ): Promise<void> {
    if (!this.policies.appliesTo(message.platform)) return;
    const current = room?.digest;
    try {
      const store = this.deps.sessionStoreFor()?.();
      const session = store ? await store.getSessionByKey(sessionKey) : null;
      const note = this.notes.get(sessionKey);
      const storedDigest = session?.metadata?.[ROOM_POLICY_DIGEST_KEY];
      const storedIsDm = session?.metadata?.[ROOM_POLICY_IS_DM_KEY];
      const seen =
        typeof storedDigest === 'string' ? storedDigest : session ? undefined : note?.digest;
      const seenIsDm = session ? storedIsDm : note?.isDm;
      const digestChanged = seen !== current;
      if (!digestChanged && seenIsDm === message.isDm) return;
      if (digestChanged && seen !== undefined) {
        this.deps.observability()?.recordSafetyBlock({
          code: 'gateway.room_policy_changed',
          cause:
            'the room prompt for this session changed since its last turn; the next turn re-caches',
          details: {
            platform: message.platform,
            chatId: message.chatId,
            sessionKey,
            previousDigest: seen,
            digest: current ?? null,
          },
        });
      }
      const { digest: _prev, ...noteRest } = note ?? {};
      this.notes.set(sessionKey, {
        ...noteRest,
        isDm: message.isDm,
        ...(current === undefined ? {} : { digest: current }),
      });
      if (store && session) {
        const {
          [ROOM_POLICY_DIGEST_KEY]: _d,
          [ROOM_POLICY_IS_DM_KEY]: _i,
          ...rest
        } = session.metadata ?? {};
        await store.updateSession(session.id, {
          metadata: {
            ...rest,
            ...(current === undefined ? {} : { [ROOM_POLICY_DIGEST_KEY]: current }),
            [ROOM_POLICY_IS_DM_KEY]: message.isDm,
          },
        });
      }
    } catch {
      // Fail-open: an audit note must never fail a turn whose answer is out.
    }
  }

  /**
   * `/channel` (plan channel-prompts §3.12, D17): a gateway command, never sent
   * to the model. The summary is open to the room and carries no prompt text;
   * `show` appends the rendered block only for the owner in a DM lane
   * (`channelShowAccess`). Pinned by `__tests__/channel-command.test.ts`.
   */
  async handleChannelCommand(
    text: string,
    message: InboundMessage,
    adapter: PlatformAdapter,
    threadId: string | undefined,
  ): Promise<void> {
    const reply = (body: string): Promise<void> =>
      adapter.send(message.chatId, { text: body, threadId }).then(
        () => {},
        () => {},
      );
    const wantsShow = isChannelShowArg(text);
    if (wantsShow) {
      const access = channelShowAccess({
        isOwner: this.deps.isOwner(message),
        isDm: isPrivateDm(message),
      });
      if (access === 'not_owner') return reply(CHANNEL_SHOW_NOT_OWNER_TEXT);
      if (access === 'group') return reply(CHANNEL_SHOW_GROUP_TEXT);
    }
    const input = {
      platform: message.platform,
      chatId: message.chatId,
      ...(threadId ? { threadId } : {}),
      isDm: message.isDm,
    };
    const identity = this.identityFor(adapter, message.isDm);
    const view = this.policies.inspect(input, identity);
    const modeSource =
      'channelModeSource' in message
        ? parseChannelModeSource(message.channelModeSource)
        : undefined;
    const summary = formatChannelSummary({
      ...input,
      configured: view.configured,
      ...(view.resolved ? { resolved: view.resolved } : {}),
      ...(view.turn ? { turn: view.turn } : {}),
      ...(identity ? { identity } : {}),
      ...(message.channelMode !== undefined ? { channelMode: message.channelMode } : {}),
      ...(modeSource ? { channelModeSource: modeSource } : {}),
    });
    return reply(wantsShow ? `${summary}\n\n${formatChannelShow(view.turn)}` : summary);
  }

  /** Plan channel-prompts L11 — a silent room's turn ended with a marker; nothing was sent. */
  recordSilentReply(
    message: InboundMessage,
    bot: GatewayBotConfig,
    reviewJobId: string | undefined,
  ): void {
    this.deps.observability()?.recordSafetyBlock({
      code: 'gateway.silent_reply',
      cause: 'the room is silent and the reply was a silence marker: nothing sent',
      details: {
        platform: message.platform,
        chatId: message.chatId,
        botKey: bot.botKey,
        ...(message.threadId ? { threadId: message.threadId } : {}),
        ...(reviewJobId ? { jobId: reviewJobId } : {}),
      },
    });
  }
}
