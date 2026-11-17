// A spooled turn's lifecycle (plan openclaw-9.5-adoption; rules
// gateway-inbound-spool.md): opening and closing its row, linking and folding
// absorbed steers, the tool-started stamp, the interrupted/dead-lettered
// notices, the wake-review fallback and the steers a turn never read. Moved out
// of index.ts (Context Budget 3, Task 2). `Gateway` constructs one `SpoolTurns`
// and keeps a delegating method under every cited name (`Gateway.linkAbsorbed`,
// `foldAbsorbed`, `markSpoolToolStarted`, `notifyDeadLettered`,
// `steerEntryFor`, `requeueUnreadSteers`, `settleUnreadSteers`).
//
// It owns no state. `spoolTurns`, `interruptedLanes`, the steer maps and the
// spool store stay `Gateway` fields, reached by reference through `deps`.

import type { DeliveryLedger } from '@ethosagent/delivery-ledger';
import type { InboundSpool, SpoolRow } from '@ethosagent/inbound-spool';
import type { SessionLane } from '@ethosagent/session-lane';
import type {
  AttachmentCache,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
  SteerEntry,
  Storage,
} from '@ethosagent/types';
import type { MessageDedupCache } from './dedup';
import type { GatewayBotConfig, GatewayObservability, HeldNotice } from './gateway-config';
import {
  deadLetteredNotice,
  INTERRUPTED_RETRY_NOTICE,
  laneKeyOf,
  RETRY_WINDOW_MS,
  type SpoolTurnState,
  type SpoolTurnTarget,
  type SteerOrigin,
  serializeInbound,
  type WakeReview,
} from './gateway-pure';
import { type GatewaySteerSink, steerAttachmentBlocks } from './steer-sink';
import { hasAudioAttachments } from './voice-pipeline';

/** What `SpoolTurns` reads and calls on `Gateway`: live getters (and setters for
 *  the fields it writes) over `Gateway`-owned state, closures for its methods. */
export interface SpoolTurnsDeps {
  adapterForBot(botKey: string, platform: string): PlatformAdapter | undefined;
  readonly attachmentCache: AttachmentCache | undefined;
  readonly closing: { notify?: string } | null;
  readonly deliveryLedger: DeliveryLedger | undefined;
  enqueueTurn(
    laneKey: string,
    lane: SessionLane,
    bot: GatewayBotConfig,
    message: InboundMessage,
    adapter: PlatformAdapter,
    text: string,
    threadId: string | undefined,
    spoolId?: string,
    review?: WakeReview,
  ): Promise<void>;
  holdNotice(notice: Omit<HeldNotice, 'id' | 'heldAt'>): Promise<boolean>;
  readonly inboundSpool: InboundSpool | undefined;
  readonly interruptedLanes: Set<string>;
  notifyTracked(
    target: {
      platform: string;
      chatId: string;
      botKey?: string;
      /** Ledger session id. Defaults to `<platform>:<chatId>`. */
      sessionKey?: string;
      threadId?: string;
      /**
       * The notice answers the user's own message (a dead-letter, interrupted
       * or missed-while-restarting notice). Never held for quiet hours or a
       * mute (U11): the user is there, waiting on it.
       */
      answersInbound?: boolean;
    },
    text: string,
  ): Promise<boolean | 'held'>;
  readonly observability: GatewayObservability | undefined;
  readonly outboundDedup: MessageDedupCache;
  readonly personalityIds: Map<string, string>;
  reviveSpooledMessage(row: SpoolRow): Promise<InboundMessage | null>;
  routedBotKey(message: InboundMessage): string;
  sendTracked(
    target: {
      adapter: PlatformAdapter;
      botKey: string;
      platform: string;
      chatId: string;
      sessionKey: string;
      /** Spool id of the inbound message this reply answers. */
      inboundRef?: string;
    },
    message: OutboundMessage,
  ): Promise<boolean>;
  readonly sessionKeys: Map<string, string>;
  readonly spoolMaxAttempts: number;
  readonly spoolOwner: string;
  readonly steerTranscribeTimeoutMs: number;
  readonly storage: Storage | undefined;
  transcribeVoiceNote(
    message: InboundMessage,
    text: string,
    personalityId: string | undefined,
    io: { attachmentCache: AttachmentCache; storage: Storage },
  ): Promise<{ text: string; providerId: string | undefined }>;
}

export class SpoolTurns {
  constructor(private readonly deps: SpoolTurnsDeps) {}

  // ---------------------------------------------------------------------------
  // Inbound spool bookkeeping (plan reach-and-containment §2.3–§2.4)
  // ---------------------------------------------------------------------------

  /** Close a row whose message was consumed without a turn. Fail-open. */
  closeSpool(spoolId: string): void {
    try {
      this.deps.inboundSpool?.markDone(spoolId);
    } catch (err) {
      this.recordSpoolUpdateFailed('markDone', err);
    }
  }

  recordSpoolUpdateFailed(stage: string, err: unknown): void {
    this.deps.observability?.recordSafetyBlock({
      code: 'gateway.spool_update_failed',
      cause: `inbound spool ${stage} failed`,
      details: { stage, error: err instanceof Error ? err.message : String(err) },
    });
  }

  /**
   * A queued turn that never started. During shutdown it is owed — the row
   * stays `received` (claimed by this dead-to-be process, so the next boot's
   * `recoverOrphans` releases it). Otherwise the lane was aborted by `/stop`,
   * `/new` or a bot removal: the user's own abort consumed it, so it closes
   * rather than coming back as a surprise answer after the next restart — and
   * a review turn that will now never run hands the user the plain result
   * instead (a completion is never swallowed).
   */
  async settleUnstartedSpool(
    spoolId: string,
    review: WakeReview | undefined,
    bot: GatewayBotConfig,
    message: InboundMessage,
    threadId: string | undefined,
  ): Promise<void> {
    if (this.deps.closing) return;
    if (review) {
      await this.deliverReviewFallback(
        spoolId,
        {
          botKey: bot.botKey,
          platform: message.platform,
          chatId: message.chatId,
          threadId,
          laneKey: laneKeyOf(message.platform, bot.botKey, message.chatId, threadId),
        },
        review.fallbackText,
        'review turn dropped before it started',
      );
      return;
    }
    this.closeSpool(spoolId);
  }

  /** `received` → `processing` (one attempt counted). Fail-open: a turn whose
   *  row cannot be marked still runs, just without spool bookkeeping. */
  beginSpoolTurn(spoolId: string | undefined, review?: WakeReview): SpoolTurnState {
    const state: SpoolTurnState = {
      id: undefined,
      answered: false,
      absorbed: [],
      toolStarted: false,
      ...(review ? { review } : {}),
    };
    const spool = this.deps.inboundSpool;
    if (!spool || !spoolId) return state;
    try {
      if (spool.markProcessing(spoolId, this.deps.spoolOwner)) state.id = spoolId;
    } catch (err) {
      this.recordSpoolUpdateFailed('markProcessing', err);
    }
    return state;
  }

  /**
   * Persist that steer row `spoolId` was folded into `state`'s turn
   * (`InboundSpool.markAbsorbed`, schema v3), so a crash, a shutdown or a
   * failure settles it WITH that turn instead of leaving it to replay as a
   * standalone message. A standalone replay in a lane whose primary had just
   * been interrupted would discard the very row the user was told to `retry`
   * (`settleInterrupted`), and on a retry or a replay the steer text would be
   * lost. The primary's replay and `retry` fold the text back in
   * (`foldAbsorbed`). One commit per steer message.
   *
   * Not for a review turn: `replayWakeReview` re-runs a review from its job,
   * not from a message, so there is nothing to fold a steer into — its steer
   * rows keep the unlinked handling. `false` → not linked (fail-open, recorded
   * as `gateway.spool_update_failed` when the write threw); the caller keeps
   * the row in `state.absorbed`. Pinned by `__tests__/inbound-spool.test.ts`
   * ('absorbed steer rows').
   */
  linkAbsorbed(spoolId: string, state: SpoolTurnState): boolean {
    const spool = this.deps.inboundSpool;
    if (!spool || !state.id || state.review) return false;
    try {
      return spool.markAbsorbed(spoolId, state.id);
    } catch (err) {
      this.recordSpoolUpdateFailed('markAbsorbed', err);
      return false;
    }
  }

  /**
   * `message` — revived from primary row `row` — with the text of every row
   * still absorbed into it appended, in arrival order: the turn as the user
   * actually shaped it, primary plus steers. Used where a primary is re-run
   * from its row: the replay (`replaySpoolRow`) and `retry`
   * (`settleInterrupted`). The text is folded, and the steer's attachments are
   * appended to the primary's — a live steer carries them too (UBP-012,
   * `steerEntryFor`). An unreadable absorbed row contributes nothing.
   */
  async foldAbsorbed(
    spool: InboundSpool,
    row: SpoolRow,
    message: InboundMessage,
  ): Promise<InboundMessage> {
    const absorbed = spool.listAbsorbed(row.id);
    if (absorbed.length === 0) return message;
    const texts = [message.text];
    const attachments = [...(message.attachments ?? [])];
    for (const child of absorbed) {
      const steer = await this.deps.reviveSpooledMessage(child);
      if (steer?.text.trim()) texts.push(steer.text);
      if (steer?.attachments) attachments.push(...steer.attachments);
    }
    return {
      ...message,
      text: texts.filter((t) => t.trim()).join('\n\n'),
      ...(attachments.length > 0 ? { attachments } : {}),
    };
  }

  /**
   * The turn's first `tool_start` (plan openclaw-9.5-adoption D5): from here the
   * row is never replayed. One commit, only on turns that use tools. Fail-open
   * — the in-memory flag still steers this process's own shutdown, but a
   * `kill -9` after a failed mark would replay the turn, tools included; the
   * `gateway.spool_update_failed` event is how that is seen.
   */
  markSpoolToolStarted(state: SpoolTurnState): void {
    if (state.toolStarted) return;
    state.toolStarted = true;
    if (!state.id) return;
    try {
      this.deps.inboundSpool?.markToolStarted(state.id);
    } catch (err) {
      this.recordSpoolUpdateFailed('markToolStarted', err);
    }
  }

  /**
   * Settle a turn's row once `runTurn` has returned or thrown.
   *
   * An `inbound` row:
   * - Shutdown abort, not answered, no tool started → `releaseOnShutdown`:
   *   owed, not failed, and the attempt is refunded; the next boot replays it,
   *   which is why `shutdown()` sends this lane no "please resend" (D19).
   *   Its linked steer rows stay `received` and linked, so that replay runs
   *   them folded in (`foldAbsorbed`); unlinked ones stay `received` too.
   * - Shutdown abort, not answered, a tool started → `interrupted`, and the
   *   lane gets {@link INTERRUPTED_RETRY_NOTICE} instead of "please resend"
   *   (D5/D19).
   * - Threw before answering → `markFailed`: back to `received` for the next
   *   boot, `interrupted` (+ the retry notice) if a tool had started, or
   *   `dead` at the attempt cap (`gateway.spool_dead_lettered`, plus one
   *   tracked notice naming the row — {@link notifyDeadLettered}).
   * - Otherwise → `done`, absorbed rows included. An answered turn is `done`
   *   even if its tail failed or shutdown cut it: the user has the reply.
   *
   * Linked steer rows (`linkAbsorbed`) need nothing here: every terminal above
   * is written to them by the spool in the same transaction
   * (`cascadeAbsorbed` in @ethosagent/inbound-spool) — `interrupted` with an
   * interrupted primary, so `retry` re-runs primary and steers together.
   * Only the unlinked ones in `state.absorbed` are closed below.
   *
   * A `wake_review` row (plan item 6, D29): answered → `done`. Shutdown with no
   * tool started → `releaseOnShutdown` (the next boot re-runs the review).
   * Anything else unanswered — a throw, `/stop`, or a shutdown after a tool
   * started — hands the user the plain wake notice instead
   * ({@link deliverReviewFallback}), so the result is never lost.
   */
  async finishSpoolTurn(
    state: SpoolTurnState,
    signal: AbortSignal,
    err: unknown,
    target: SpoolTurnTarget,
  ): Promise<void> {
    const spool = this.deps.inboundSpool;
    if (!spool) return;
    const shutdown = this.deps.closing !== null && signal.aborted && !state.answered;
    try {
      if (state.id && state.review) {
        if (state.answered) spool.markDone(state.id);
        else if (shutdown && !state.toolStarted) spool.releaseOnShutdown(state.id);
        else {
          const reason =
            err !== undefined
              ? `review turn failed: ${err instanceof Error ? err.message : String(err)}`
              : 'review turn cut before it answered';
          await this.deliverReviewFallback(state.id, target, state.review.fallbackText, reason);
        }
      } else if (state.id) {
        if (shutdown && !state.toolStarted) {
          spool.releaseOnShutdown(state.id);
        } else if (shutdown) {
          if (spool.markInterrupted(state.id, 'interrupted by shutdown after a tool started')) {
            await this.notifyInterrupted(state.id, target);
          }
        } else if (err !== undefined && !state.answered) {
          const error = err instanceof Error ? err.message : String(err);
          const outcome = spool.markFailed(state.id, error, this.deps.spoolMaxAttempts);
          if (outcome === 'dead') await this.notifyDeadLettered(state.id, error, target);
          else if (outcome === 'interrupted') await this.notifyInterrupted(state.id, target);
        } else {
          spool.markDone(state.id);
        }
      }
      if (!shutdown) for (const id of state.absorbed) spool.markDone(id);
    } catch (e) {
      this.recordSpoolUpdateFailed('settle', e);
    }
  }

  /**
   * An `inbound` row just became `interrupted`: remember its lane for the
   * `retry` lookup and tell the user, through the ledger-backed path on the
   * row's own bot (`notifyTracked` → `adapterForBot`). Never throws.
   */
  async notifyInterrupted(spoolId: string, target: SpoolTurnTarget): Promise<void> {
    this.deps.interruptedLanes.add(target.laneKey);
    this.deps.observability?.recordSafetyBlock({
      code: 'gateway.spool_interrupted',
      cause: 'inbound message interrupted after a tool started — not replayed',
      details: { spoolId, platform: target.platform, botKey: target.botKey },
    });
    await this.deps
      .notifyTracked(
        {
          platform: target.platform,
          chatId: target.chatId,
          botKey: target.botKey,
          sessionKey: this.deps.sessionKeys.get(target.laneKey) ?? target.laneKey,
          ...(target.threadId ? { threadId: target.threadId } : {}),
          answersInbound: true,
        },
        INTERRUPTED_RETRY_NOTICE,
      )
      .catch(() => false);
  }

  /**
   * An `inbound` row's turn just failed at the attempt cap and the row is
   * `dead`: record it and tell the lane ONCE, through the ledger-backed path on
   * the row's own bot ({@link deadLetteredNotice}, `notifyTracked` →
   * `adapterForBot`). Called only from the attempt-cap branch of
   * `finishSpoolTurn`; the stale path sends its own per-lane notice. Never throws.
   */
  async notifyDeadLettered(
    spoolId: string,
    reason: string,
    target: SpoolTurnTarget,
  ): Promise<void> {
    this.recordSpoolDeadLettered(spoolId, reason);
    await this.deps
      .notifyTracked(
        {
          platform: target.platform,
          chatId: target.chatId,
          botKey: target.botKey,
          sessionKey: this.deps.sessionKeys.get(target.laneKey) ?? target.laneKey,
          ...(target.threadId ? { threadId: target.threadId } : {}),
          answersInbound: true,
        },
        deadLetteredNotice(spoolId),
      )
      .catch(() => false);
  }

  /**
   * A review turn cannot answer, so the user gets the plain wake notice — the
   * text `deliverCompletion` would have sent (plan item 6, D29). Delivered
   * through `sendTracked` with the row's id as `inboundRef`, BEFORE the row is
   * closed: a crash after the obligation is written is caught by the replay's
   * `hasObligationFor` guard (the ledger sweep then sends it), and a crash
   * before it leaves the row for the next replay. Never lost, never both.
   * Without a ledger, an unconfirmed send leaves the row for the next boot.
   */
  async deliverReviewFallback(
    spoolId: string,
    target: SpoolTurnTarget,
    text: string,
    reason: string,
  ): Promise<void> {
    const spool = this.deps.inboundSpool;
    this.deps.observability?.recordSafetyBlock({
      code: 'gateway.review_fallback',
      cause: reason,
      details: { spoolId, platform: target.platform, botKey: target.botKey },
    });
    const owned = await this.sendReviewFallback(target, text, spoolId);
    if (!spool || !owned) return;
    try {
      spool.markDone(spoolId);
    } catch (err) {
      this.recordSpoolUpdateFailed('markDone', err);
    }
  }

  /**
   * Send the plain wake notice for a review that could not answer, on the
   * row's own bot. `true` once someone owns delivery: the platform confirmed,
   * the identical text already reached the lane (outbound dedup), or the
   * ledger holds a `pending` obligation (stamped `inboundRef`) that its sweep
   * will retry. `false` = nobody does — no adapter here, or no ledger and an
   * unconfirmed send — so the caller must leave the row for a later attempt.
   *
   * U11 — the plain notice is unprompted, so inside quiet hours or a lane
   * `/mute` it is held ({@link holdNotice}) and `true` is returned: the durable
   * held-notice store now owns it and {@link releaseHeldNotices} sends it once
   * the hold ends, so the row can close. Pinned by the U11 fallback case in
   * `__tests__/parent-review.test.ts`.
   */
  async sendReviewFallback(
    target: SpoolTurnTarget,
    text: string,
    inboundRef: string | undefined,
  ): Promise<boolean> {
    const adapter = this.deps.adapterForBot(target.botKey, target.platform);
    if (!adapter) return false;
    const sessionKey = this.deps.sessionKeys.get(target.laneKey) ?? target.laneKey;
    if (
      await this.deps.holdNotice({
        botKey: target.botKey,
        platform: target.platform,
        chatId: target.chatId,
        ...(target.threadId ? { threadId: target.threadId } : {}),
        laneKey: target.laneKey,
        sessionKey,
        text,
      })
    ) {
      return true;
    }
    if (!this.deps.outboundDedup.shouldSend(target.laneKey, text)) return true;
    const confirmed = await this.deps
      .sendTracked(
        {
          adapter,
          botKey: target.botKey,
          platform: target.platform,
          chatId: target.chatId,
          sessionKey,
          ...(inboundRef ? { inboundRef } : {}),
        },
        { text, ...(target.threadId ? { threadId: target.threadId } : {}) },
      )
      .catch(() => false);
    return confirmed || this.deps.deliveryLedger !== undefined;
  }

  /**
   * The `interrupted` row a message's lane is holding, if any, within the
   * `retry` window. Reads SQLite only for a lane in {@link interruptedLanes};
   * a lane found empty is dropped from that gate. Fail-open: a lookup that
   * throws treats the lane as holding nothing.
   */
  pendingInterrupted(message: InboundMessage): SpoolRow | null {
    const spool = this.deps.inboundSpool;
    if (!spool || this.deps.interruptedLanes.size === 0) return null;
    const threadId = message.threadId ? message.threadId : undefined;
    const laneKey = laneKeyOf(
      message.platform,
      this.deps.routedBotKey(message),
      message.chatId,
      threadId,
    );
    if (!this.deps.interruptedLanes.has(laneKey)) return null;
    try {
      const row = spool.findInterrupted(laneKey, Date.now() - RETRY_WINDOW_MS);
      if (!row) this.deps.interruptedLanes.delete(laneKey);
      return row;
    } catch (err) {
      this.recordSpoolUpdateFailed('findInterrupted', err);
      return null;
    }
  }

  /**
   * Act on a lane's interrupted row once the message holding it has passed
   * the safety filter (plan D5). `retry` → the row's payload as a fresh row,
   * returned for the caller to run; `'consumed'` → a `retry` that lost the race
   * to a concurrent one (nothing to run twice); `null` → the row was discarded
   * because this is some other message, which then proceeds normally.
   */
  async settleInterrupted(
    row: SpoolRow,
    retry: boolean,
  ): Promise<{ message: InboundMessage; spoolId: string } | 'consumed' | null> {
    const spool = this.deps.inboundSpool;
    if (!spool) return null;
    try {
      if (retry) {
        const revived = await this.deps.reviveSpooledMessage(row);
        // The interrupted turn's absorbed steers were interrupted with it; the
        // retry re-runs primary and steers as ONE turn, and its row carries the
        // folded text so a crash during the retry replays that same turn.
        const message = revived ? await this.foldAbsorbed(spool, row, revived) : null;
        if (message) {
          const fresh = spool.retryInterrupted(
            row.id,
            this.deps.spoolOwner,
            serializeInbound(message),
          );
          if (!fresh) return 'consumed';
          this.deps.observability?.recordSafetyBlock({
            code: 'gateway.spool_interrupted_retried',
            details: { spoolId: row.id, retrySpoolId: fresh, platform: row.platform },
          });
          return { message, spoolId: fresh };
        }
      }
      if (spool.discard(row.id)) {
        this.deps.observability?.recordSafetyBlock({
          code: 'gateway.spool_interrupted_discarded',
          details: { spoolId: row.id, platform: row.platform },
        });
      }
    } catch (err) {
      this.recordSpoolUpdateFailed('settleInterrupted', err);
    }
    return null;
  }

  recordSpoolDeadLettered(spoolId: string, reason: string): void {
    this.deps.observability?.recordSafetyBlock({
      code: 'gateway.spool_dead_lettered',
      cause: `inbound message dead-lettered: ${reason}`,
      details: { spoolId, reason },
    });
  }

  /**
   * UBP-012 — the steer a mid-turn message becomes: its text, with a voice note
   * transcribed into it, plus its images and PDFs as native blocks within the
   * shared vision caps (`steerAttachmentBlocks`, ./steer-sink.ts). A message
   * with no attachments is its text alone. Pinned by
   * `__tests__/steer-mid-turn.test.ts`.
   */
  async steerEntryFor(
    message: InboundMessage,
    text: string,
    laneKey: string,
    bot: GatewayBotConfig,
  ): Promise<SteerEntry> {
    const attachments = message.attachments;
    if (!attachments || attachments.length === 0) return { text };
    const attachmentCache = this.deps.attachmentCache;
    const storage = this.deps.storage;
    let steerText = text;
    if (hasAudioAttachments(attachments) && attachmentCache && storage) {
      const personalityId =
        bot.binding.type === 'team'
          ? undefined
          : (this.deps.personalityIds.get(laneKey) ?? bot.binding.name);
      // Bounded (V2-RT-3): the lane's later messages wait on this build.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<undefined>((resolve) => {
        const t = setTimeout(() => resolve(undefined), this.deps.steerTranscribeTimeoutMs);
        t.unref?.();
        timer = t;
      });
      try {
        const transcribed = await Promise.race([
          this.deps.transcribeVoiceNote(message, text, personalityId, { attachmentCache, storage }),
          deadline,
        ]);
        if (transcribed) {
          steerText = transcribed.text;
        } else {
          this.deps.observability?.recordSafetyBlock({
            code: 'gateway.steer_transcription_timeout',
            cause: `voice note not transcribed within ${this.deps.steerTranscribeTimeoutMs}ms; steered as its placeholder text`,
            details: { platform: message.platform, chatId: message.chatId },
          });
        }
      } finally {
        clearTimeout(timer);
      }
    }
    const blocks = await steerAttachmentBlocks(attachments, {
      ...(storage ? { storage } : {}),
      ...(attachmentCache ? { attachmentCache } : {}),
    });
    return blocks.length > 0 ? { text: steerText, blocks } : { text: steerText };
  }

  /**
   * UBP-001 — the steers still queued when a turn ends were read by no seam
   * (pushed after the loop's last drain, or left on its last allowed
   * iteration). Each runs as its own turn on the lane, queued behind the one
   * ending, with its spool row unlinked (`InboundSpool.unlinkAbsorbed`) so it
   * gets its own terminal instead of closing unread with the turn's
   * (`cascadeAbsorbed`). Pinned by `__tests__/steer-mid-turn.test.ts`.
   */
  requeueUnreadSteers(
    laneKey: string,
    lane: SessionLane,
    bot: GatewayBotConfig,
    sink: GatewaySteerSink<SteerOrigin>,
    spoolTurn: SpoolTurnState | undefined,
  ): void {
    for (const { origin } of sink.takeLeftovers()) {
      if (!origin) continue;
      if (origin.spoolId) this.unlinkSteer(origin.spoolId, spoolTurn);
      this.deps.observability?.recordSafetyBlock({
        code: 'gateway.steer_requeued',
        cause: 'a steer no seam of the running turn read runs as its own turn',
        details: { platform: origin.message.platform, botKey: bot.botKey },
      });
      void this.deps
        .enqueueTurn(
          laneKey,
          lane,
          bot,
          origin.message,
          origin.adapter,
          origin.text,
          origin.threadId,
          origin.spoolId,
        )
        .catch(() => {});
    }
  }

  /**
   * The turn is ending and cannot run its unread steers now. Shutdown after
   * the turn answered: each steer's row is unlinked, so it stays `received`
   * and the next boot replays it as its own message. Otherwise the rows stay
   * linked and follow the turn's row: a shutdown or failure before the answer
   * replays (or `retry`s) them folded into it; `/stop` or `/new` closes them
   * with it, as the user's own abort closes every message queued behind it.
   */
  settleUnreadSteers(
    sink: GatewaySteerSink<SteerOrigin>,
    spoolTurn: SpoolTurnState | undefined,
    answered: boolean,
  ): void {
    for (const { origin } of sink.takeLeftovers()) {
      if (this.deps.closing && answered && origin?.spoolId)
        this.unlinkSteer(origin.spoolId, spoolTurn);
    }
  }

  /** Undo a steer's link to the turn it was folded into (UBP-001). Fail-open. */
  unlinkSteer(spoolId: string, spoolTurn: SpoolTurnState | undefined): void {
    if (spoolTurn) spoolTurn.absorbed = spoolTurn.absorbed.filter((id) => id !== spoolId);
    try {
      this.deps.inboundSpool?.unlinkAbsorbed(spoolId);
    } catch (err) {
      this.recordSpoolUpdateFailed('unlinkAbsorbed', err);
    }
  }
}
