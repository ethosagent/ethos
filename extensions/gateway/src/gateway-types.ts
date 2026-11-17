// Gateway contract types beside GatewayConfig: bot config, publication,
// held notices, observability and the inbound/lane result types. Split from
// gateway-config.ts (Context Budget 3, Task 2) to keep each file under the
// size gate; gateway-config.ts and index.ts re-export every one.

import type { AgentLoop } from '@ethosagent/core';
import type { JobControl } from '@ethosagent/job-runner';
import type { PlatformAdapter } from '@ethosagent/types';
import type { McpLoginPort } from './mcp-login-port';

/**
 * Minimal observability surface the gateway needs. Defined locally so this
 * package depends only on `@ethosagent/types` + `@ethosagent/core`'s AgentLoop;
 * any adapter exposing this method shape (e.g. wiring's GatewayObservability)
 * is a fit.
 */
/**
 * What an in-app notifications feed answers when handed a digest.
 *
 * One field, and it is a COUNT rather than a boolean, because the honest
 * answer to "did this land" for a fan-out sink is "with how many". The digest
 * treats `0` as an undelivered digest and leaves its cursor where it was.
 */
export interface ChannelDigestFeedResult {
  /** Live listeners this digest was actually written to. Zero means nobody. */
  recipients: number;
}

export interface GatewayObservability {
  recordSafetyBlock(opts: {
    code?: string;
    cause?: string;
    details?: Record<string, unknown>;
  }): void;
  recordInjectionFlag?(opts: {
    code?: string;
    cause?: string;
    details?: Record<string, unknown>;
  }): void;
  recordChannelAllow(opts: {
    code?: string;
    cause?: string;
    details?: Record<string, unknown>;
  }): void;
  recordChannelDeny(opts: {
    code?: string;
    cause?: string;
    details?: Record<string, unknown>;
  }): void;
  /** `channel.pairing` rows — see `Gateway.recordPairing`. */
  recordChannelPairing?(opts: {
    code?: string;
    cause?: string;
    details?: Record<string, unknown>;
  }): void;
}

/**
 * One bot's spend since a point, split by who caused it (plan
 * background-usage-accounting §7.1) — what `GatewayConfig.botSpendSince`
 * answers. `repliesUsd` is the bot's turns plus the utility calls they made
 * (message rows + `turn_utility` ledger rows); `backgroundUsd` its background
 * work (`background` ledger rows). Disjoint (§5.5), so the two add.
 */
export interface BotSpend {
  repliesUsd: number;
  backgroundUsd: number;
}

/**
 * What {@link Gateway.acceptInbound} decided for one inbound message: the
 * synchronous dedup + spool step, split out of `handleMessage` so the inbound
 * wiring can run it before the platform's webhook is acknowledged.
 */
export interface InboundAcceptance {
  /** `false` → a duplicate (dedup, or a key already spooled): drop it. */
  fresh: boolean;
  /** The spool row, when a spool is wired and the write succeeded. */
  spoolId?: string;
  /** Whether this process claimed the row at accept. `false` only mid-replay,
   *  when the replay loop — not this call — runs it, in lane order. */
  claimed?: boolean;
}

/** Options for {@link Gateway.handleMessage}. All optional; adapters pass none. */
export interface HandleMessageOptions {
  /** The inbound wiring already ran {@link Gateway.acceptInbound} for this message. */
  accepted?: InboundAcceptance;
  /** Replay re-entry: skip dedup and the spool write and run as this spool row. */
  replaySpoolId?: string;
  /** Called once the message is queued on its lane or consumed without a turn.
   *  The replay uses it to queue one lane's rows strictly in order. */
  onQueued?: () => void;
}

/** What {@link Gateway.onLaneStop} listeners are told about a `/stop` (UBP-046). */
export interface LaneStop {
  /** The stopped turn's session id — the one its hook payloads carry. */
  sessionId: string;
  sessionKey: string;
}

// ---------------------------------------------------------------------------
// Gateway config
// ---------------------------------------------------------------------------

/**
 * Per-bot routing entry. The Gateway maintains one `AgentLoop` per bot;
 * inbound messages carrying `InboundMessage.botKey` route to the entry
 * with the matching `botKey`. Each bot is statically bound to a single
 * destination (a personality or a team's coordinator).
 *
 * `binding.type === 'team'` means the supplied `loop` is the team's
 * coordinator loop (constructed via `createTeamAgentLoop`). The Gateway
 * does not override the personality on team turns — the coordinator's
 * personality is baked into the loop. `binding.type === 'personality'`
 * means the loop is the shared CLI loop and the Gateway passes
 * `binding.name` as the per-turn personality id.
 *
 * `binding.allowSlashSwitch` defaults to false: the `/personality`
 * command is soft-rejected for identity-bound bots so the bot's
 * external identity remains a stable contract with the user.
 */
export interface GatewayBotConfig {
  botKey: string;
  loop: AgentLoop;
  /**
   * This bot's `/mcp login` port (built by `createMcpLoginPort` in
   * packages/wiring). Read when `GatewayConfig.mcpLoginFor` is unset or returns
   * nothing, so a bot hot-added or retired live carries its own port with it.
   * Absent for a team bot and in tests.
   */
  mcpLogin?: McpLoginPort;
  binding: {
    type: 'personality' | 'team';
    name: string;
    allowSlashSwitch?: boolean;
  };
  /** When true, PII (email, phone, card, SSN) is redacted from inbound message
   *  text before it reaches AgentLoop. Default false. */
  piiRedaction?: boolean;
  /** Durable background executor for this bot's loop — present when the background
   *  subsystem is enabled. The gateway subscribes to it for completion wakes and
   *  creates /background jobs through it. */
  backgroundExecutor?: import('@ethosagent/job-runner').BackgroundExecutor;
  /** This bot's job store — present when background is enabled. */
  jobStore?: import('@ethosagent/types').JobStore;
  /** Steer / stop / tail policy for this bot's jobs (`CreateAgentLoopResult.jobControl`) —
   *  absent when background is disabled; `/background steer|stop|tail` then refuse. */
  jobControl?: JobControl;
  /** `<bot entry>.budget` (plan openclaw-2026.9.6-gaps D5): `dailyUsd` caps this
   *  bot's spend per UTC day, enforced by `Gateway.enqueueTurn` (replies) and
   *  `Gateway.backgroundGate` when `GatewayConfig.botSpendSince` is wired;
   *  `backgroundBlocksReplies` (background-usage-accounting D14) makes
   *  background spend count toward the reply gate too. Absent = no daily cap. */
  budget?: { dailyUsd: number; backgroundBlocksReplies?: boolean };
  /**
   * Reply-prefix template (`telegram.bots.N.replyPrefix`,
   * `slack.apps.N.replyPrefix`, `discord.replyPrefix`; plan
   * personality-presence-and-initiative §3). Placeholders `{name}` and
   * `{emoji}` resolve to the personality bound to the lane. Applied by
   * `applyReplyPrefix` (./reply-prefix.ts) before dedup and the ledger.
   * Absent = replies are byte-identical to a bot without the key.
   */
  replyPrefix?: string;
}

/**
 * "Does bot `botKey` still speak for `personalityId`?"
 *
 * The botKey-level generalisation of `buildChannelSpeakers`
 * (`apps/ethos/src/commands/gateway-voice.ts`), which answers the same question for a
 * whole platform. Injected rather than computed here because resolving a TEAM
 * binding means reading that team's manifest, which is config-layer knowledge
 * the gateway does not carry.
 */
export type PublicationSpeaksFor = (botKey: string, personalityId: string) => boolean;

/**
 * One approved outbox item, as {@link Gateway.deliverPublication} needs it.
 *
 * Structural on purpose: `OutboxItem` (`@ethosagent/outbox`) plus its approved
 * revision's text satisfies it, and the gateway takes no dependency on the
 * outbox package to deliver for it.
 */
export interface PublicationRequest {
  /** The outbox item id. Becomes the ledger session `outbox:<id>` and the
   *  dedup key, so one item is one conversation as far as both are concerned. */
  itemId: string;
  /** The personality that drafted it — re-checked against `botKey`. */
  personalityId: string;
  /** The bot that will speak. Fixed at propose, approved by a human. */
  botKey: string;
  platform: string;
  chatId: string;
  threadId?: string;
  /**
   * The approved revision's text, BYTE-EXACT. It is handed to the adapter
   * unchanged — no trimming, no normalisation — because the content hash the
   * human approved binds these exact bytes.
   */
  text: string;
}

/**
 * Why nothing was sent. The code is what the dispatcher branches on, because
 * the two failures are not the same fact about the item:
 *
 * - `bot_not_served` / `no_adapter` / `no_binding_check` — this PROCESS cannot
 *   publish it. The item goes back to `approved` and another process (or this
 *   one, once its bot is up) delivers it. Nothing about the approval is stale.
 * - `not_bound` — the bot no longer speaks for the personality. The approval
 *   itself is void: a human approved a post from a bot that would now be
 *   speaking out of turn. The item goes to `failed` for a person to look at.
 * - `deduplicated` — the identical bytes passed the outbound chokepoint under
 *   this item's own key inside the dedup TTL. Either a peer is publishing this
 *   item right now, or a failed attempt is being retried seconds later. Keep
 *   the item `approved`: a later tick gets through once the TTL lapses, and
 *   until then a second copy is the thing worth not sending. Reporting it as
 *   sent would be a claim this call cannot support — the cache remembers that
 *   the bytes reached the chokepoint, not that the platform took them.
 */
export type PublicationRefusalCode =
  | 'bot_not_served'
  | 'no_adapter'
  | 'no_binding_check'
  | 'not_bound'
  | 'deduplicated';

/** The outcome of one {@link Gateway.deliverPublication} call. */
export interface PublicationResult {
  /**
   * The platform CONFIRMED (`DeliveryResult.ok === true`). "Resolved without
   * throwing" is not confirmation — every shipped adapter catches platform
   * failures and returns `{ ok: false }`.
   */
  confirmed: boolean;
  /**
   * The ledger obligation this send is filed under, or `null` when no ledger is
   * wired (and on a refusal, where nothing was written). `confirmed: false`
   * with an id means the row is `pending` and `sweepPendingDeliveries()` owns
   * the retry from here — the outbox must never resend it itself.
   */
  obligationId: string | null;
  /** Present only when NOTHING was sent. */
  refusal?: { code: PublicationRefusalCode; message: string };
}

/**
 * One unprompted notice held for quiet hours or a lane mute (U11). Everything
 * `sendTracked` needs to deliver it later on the same bot, lane and thread.
 */
export interface HeldNotice {
  id: number;
  botKey: string;
  platform: string;
  chatId: string;
  threadId?: string;
  laneKey: string;
  /** Ledger session id the release files the obligation under. */
  sessionKey: string;
  text: string;
  heldAt: number;
}

/**
 * Durable store for held notices (`GatewayConfig.heldNotices`). Structural so
 * the gateway takes no dependency on a concrete store: production wires
 * `SQLiteNotifyQueue` (`@ethosagent/notify-queue`, its `held_notices` table).
 */
export interface HeldNoticeStore {
  hold(notice: Omit<HeldNotice, 'id' | 'heldAt'>): Promise<void>;
  /** Every notice not yet released, oldest first. */
  listHeld(): Promise<HeldNotice[]>;
  markReleased(id: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

/**
 * Where an in-flight turn originated — the adapter/chat/thread plus the user
 * who triggered it. The `before_tool_call` approval flow resolves a
 * `sessionId` to this so it can surface a prompt on the right conversation
 * and bind the decision to the rightful approver.
 */
export interface SessionRouting {
  adapter: PlatformAdapter;
  chatId: string;
  threadId?: string;
  /** Platform user id of whoever's message triggered the turn. Absent when
   *  the adapter didn't stamp one — the approval is then left unbound. */
  requesterUserId?: string;
  /** Whether the triggering message was a DM. In a group the approval flow
   *  binds the decision to the platform owner instead of the requester
   *  (`resolveApprovalTarget` in apps/ethos/src/commands/gateway.ts). */
  isDm: boolean;
  /** Platform name of the triggering message (`InboundMessage.platform`) —
   *  the `channel_filter` key the owner is looked up under. `adapter.id` is
   *  an adapter id, not a platform name. */
  platform: string;
}
