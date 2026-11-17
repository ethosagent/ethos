// Background-job wakes: the completion notice (`deliverCompletion`), the
// `deliver: 'parent'` review turn (`admitWakeReview`), its quiet-hours/`/mute`
// parking (`releaseParkedReviews`) and the restart sweep
// (`sweepUndeliveredJobs`), moved out of index.ts (Context Budget 3, Task 2).
// `Gateway` constructs one `WakeReviews` and keeps a delegating method under
// every cited name.
//
// It owns no state. The delivered-wakes set, the pending-wakes map and the
// parked-review map stay `Gateway` fields (the constructor's wake sweep timer
// reads `pendingWakes`), reached by reference through `deps`.

import { buildLaneKey } from '@ethosagent/core';
import type { DeliveryLedger } from '@ethosagent/delivery-ledger';
import type { InboundSpool } from '@ethosagent/inbound-spool';
import { shortPatternCheck, wrapUntrusted } from '@ethosagent/safety-injection';
import type { SessionLane } from '@ethosagent/session-lane';
import type {
  BackgroundJob,
  InboundMessage,
  JobSteer,
  OutboundMessage,
  PlatformAdapter,
  TurnAudience,
} from '@ethosagent/types';
import type { MessageDedupCache } from './dedup';
import type {
  GatewayBotConfig,
  GatewayObservability,
  HeldNotice,
  HeldNoticeStore,
} from './gateway-config';
import {
  DELIVERED_WAKES_MAX,
  isAnnounceableJob,
  type SteerOrigin,
  serializeInbound,
  type WakeReview,
} from './gateway-pure';
import { unreadSteerSuffix } from './job-commands';
import type { GatewaySteerSink } from './steer-sink';

/** What `WakeReviews` reads and calls on `Gateway`: live getters (and setters for
 *  the fields it writes) over `Gateway`-owned state, closures for its methods. */
export interface WakeReviewsDeps {
  readonly activeSinks: Map<string, GatewaySteerSink<SteerOrigin>>;
  readonly activeTurns: Map<
    string,
    { adapter: PlatformAdapter; chatId: string; threadId?: string; answered?: boolean }
  >;
  adapterForBot(botKey: string, platform: string): PlatformAdapter | undefined;
  readonly bots: Map<string, GatewayBotConfig>;
  closeSpool(spoolId: string): void;
  readonly deliveredWakes: Set<string>;
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
  getOrCreateLane(key: string): SessionLane;
  readonly heldNotices: HeldNoticeStore | undefined;
  holdNotice(notice: Omit<HeldNotice, 'id' | 'heldAt'>): Promise<boolean>;
  readonly inboundSpool: InboundSpool | undefined;
  noticeHoldReason(botKey: string, laneKey: string, now?: number): 'muted' | 'quiet_hours' | null;
  readonly observability: GatewayObservability | undefined;
  readonly outboundDedup: MessageDedupCache;
  readonly parkedReviews: Map<
    string,
    { bot: GatewayBotConfig; job: BackgroundJob; laneKey: string }
  >;
  readonly pendingWakes: Map<string, Array<{ job: BackgroundJob; bot: GatewayBotConfig }>>;
  recordSpoolUpdateFailed(stage: string, err: unknown): void;
  reviewAudience(job: BackgroundJob): TurnAudience;
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
  readonly spoolOwner: string;
}

export class WakeReviews {
  constructor(private readonly deps: WakeReviewsDeps) {}

  // ---------------------------------------------------------------------------
  // Background-completion wakes
  // ---------------------------------------------------------------------------

  /**
   * A durable background job finished. Queue a completion notice for its
   * originating lane and try to flush it. Deferred (not sent) while a turn is
   * in flight on that lane so the notice never interleaves with a streaming
   * response. `done` / `failed` wake, and so does an `aborted` job its
   * runtime's shutdown interrupted (`JOB_ABORTED_BY_SHUTDOWN` — the origin
   * chat is told to ask again); a user's cancel stays silent. `stale` /
   * `expired` never reach `onComplete` (they come from sweeps, whose
   * cross-process delivery is a later phase). Never throws — a completion
   * callback that throws would crash the executor.
   */
  onBackgroundJobComplete(bot: GatewayBotConfig, job: BackgroundJob): void {
    if (!isAnnounceableJob(job)) return;
    if (this.deps.deliveredWakes.has(job.id)) return;
    const platform = job.originPlatform;
    const chatId = job.originChatId;
    if (!platform || !chatId) return; // no originating channel (e.g. CLI-owned)
    const threadId = job.originThreadId;
    const laneKey = threadId
      ? buildLaneKey(platform, bot.botKey, chatId, threadId)
      : buildLaneKey(platform, bot.botKey, chatId);
    const list = this.deps.pendingWakes.get(laneKey) ?? [];
    list.push({ job, bot });
    this.deps.pendingWakes.set(laneKey, list);
    void this.flushWakes(laneKey);
  }

  /**
   * Deliver every queued completion notice for `laneKey`, unless a turn is
   * running on that lane (then it's retried on turn-end and by the periodic
   * sweep). Dequeuing is synchronous, so a concurrent flush (turn-end vs sweep)
   * sees an empty queue; the per-job claim below is what makes exactly-once hold
   * across PROCESSES too. Best-effort adapter resolution: an unresolved platform
   * drops the item with an observability record rather than throwing.
   */
  async flushWakes(laneKey: string): Promise<void> {
    // A turn is running — defer. `activeTurns` as well as `activeSinks`: the
    // sink is unhooked at the turn's terminal event, but the turn holds the
    // lane (and may still be sending its voice note) until `runTurn` returns.
    if (this.deps.activeTurns.has(laneKey) || this.deps.activeSinks.has(laneKey)) return;
    const list = this.deps.pendingWakes.get(laneKey);
    if (!list || list.length === 0) {
      this.deps.pendingWakes.delete(laneKey);
      return;
    }
    // Drain synchronously into a local batch so a re-entrant flush sees an empty
    // queue. Items are re-checked against deliveredWakes as a second guard.
    const batch = list.splice(0, list.length);
    if (list.length === 0) this.deps.pendingWakes.delete(laneKey);
    for (const item of batch) {
      const { job, bot } = item;
      if (this.deps.deliveredWakes.has(job.id)) continue;
      const platform = job.originPlatform;
      const chatId = job.originChatId;
      if (!platform || !chatId) continue;
      // The notice is filed under `bot.botKey`, so it leaves through that
      // bot's adapter — never a sibling's (F08, see `adapterForBot`).
      const adapter = this.deps.adapterForBot(bot.botKey, platform);
      if (!adapter) {
        // No adapter for this bot on this platform in this process — drop from
        // memory, don't retry here. The durable claim (`jobs.delivered_at`) is
        // untouched, so `sweepUndeliveredJobs` still owes it on the next boot.
        this.markWakeDelivered(job.id);
        this.deps.observability?.recordSafetyBlock({
          code: 'background.wake_undeliverable',
          details: { jobId: job.id, platform, chatId, botKey: bot.botKey },
        });
        continue;
      }
      // Mark BEFORE the first await: a second `onComplete` for this job that
      // arrives while the claim is in flight must not open a second delivery.
      // Marking a job whose claim we then LOSE is still correct — losing means
      // a peer process is announcing it, so this process is done with it either
      // way.
      this.markWakeDelivered(job.id);
      if (job.deliver === 'parent' && this.deps.inboundSpool) {
        await this.admitWakeReview(bot, job, adapter, laneKey);
        continue;
      }
      if (!(await this.claimWake(bot, job))) continue; // a peer process won it
      await this.deliverCompletion(bot, job, adapter, laneKey);
    }
  }

  /**
   * A finished `deliver: 'parent'` job (plan openclaw-9.5-adoption item 6,
   * D29): instead of waking the user with the raw result, run ONE review turn
   * on the job's origin lane and let the user see its answer. Gateway only —
   * CLI chat and web show the result inside the parent session already.
   *
   * Admission order spans two files, and the order is the guarantee:
   *
   *  1. `spool.accept` a `wake_review` row keyed `wake:<jobId>` (idempotent —
   *     a second admission of the same job is the UNIQUE key's no-op), claimed
   *     by this process. Its payload is `buildWakeNotice(job)`.
   *  2. THEN the job's delivery claim (`claimWake` → `jobs.delivered_at`).
   *     Lost → a peer is announcing it: close the row. A crash between 1 and
   *     2 leaves an unclaimed job, which `sweepUndeliveredJobs` re-admits into
   *     the same row; a crash after 2 leaves the row, which the replay runs.
   *  3. Enqueue the review turn on the lane, straight into `enqueueTurn` — it
   *     never passes the clarify correlator or slash parsing, so a pending
   *     clarify cannot swallow it.
   *
   * From there the spool's terminals apply (`finishSpoolTurn`, the replay's
   * `wake_review` branch): an answered review closes the row; an error, an
   * empty answer, a tool-started crash, staleness or the attempt cap hand the
   * user the plain wake notice instead (`deliverReviewFallback`). Never lost,
   * never both. A spool write that throws fails open to the plain notice.
   *
   * U11 — a review is as unprompted as the plain notice, and it costs a paid
   * turn. Inside quiet hours or a lane `/mute` ({@link noticeHoldReason}, the
   * same decision and the same `heldNotices` enablement {@link holdNotice}
   * uses) nothing is admitted: the job is parked in `parkedReviews` with its
   * delivery claim NOT taken, and {@link releaseParkedReviews} admits it once
   * the hold ends. A restart meanwhile loses only the in-memory park; the
   * unclaimed job is re-owed by `sweepUndeliveredJobs`, which comes back here.
   * Returns false while parked (nothing delivered yet). Pinned by the U11 cases
   * in `__tests__/parent-review.test.ts`.
   */
  async admitWakeReview(
    bot: GatewayBotConfig,
    job: BackgroundJob,
    adapter: PlatformAdapter,
    laneKey: string,
  ): Promise<boolean> {
    const spool = this.deps.inboundSpool;
    const platform = job.originPlatform;
    const chatId = job.originChatId;
    if (!spool || !platform || !chatId) return false;
    const hold = this.deps.heldNotices ? this.deps.noticeHoldReason(bot.botKey, laneKey) : null;
    if (hold) {
      this.deps.parkedReviews.set(job.id, { bot, job, laneKey });
      this.deps.observability?.recordSafetyBlock({
        code: 'gateway.review_held',
        cause: hold,
        details: { jobId: job.id, botKey: bot.botKey, platform, chatId },
      });
      return false;
    }
    const threadId = job.originThreadId ? job.originThreadId : undefined;
    const fallbackText = this.buildWakeNotice(job);
    const roomAudience = this.deps.reviewAudience(job);
    const message: InboundMessage = {
      platform,
      chatId,
      botKey: bot.botKey,
      text: fallbackText,
      // Routing only (streaming class, approval binding) — the audience is the
      // job's (`reviewAudience`), not this. A shared review carries the hint
      // so a replay of the row stays shared without the job store.
      isDm: false,
      ...(roomAudience === 'shared' ? { audienceHint: 'shared' as const } : {}),
      isGroupMention: false,
      messageId: `wake:${job.id}`,
      ...(threadId ? { threadId } : {}),
      raw: null,
    };
    let row: { id: string; fresh: boolean };
    try {
      row = spool.accept({
        platform,
        botKey: bot.botKey,
        chatId,
        ...(threadId ? { threadId } : {}),
        messageId: `wake:${job.id}`,
        laneKey,
        payload: serializeInbound(message),
        claimedBy: this.deps.spoolOwner,
        kind: 'wake_review',
        reviewJobId: job.id,
      });
    } catch (err) {
      this.deps.recordSpoolUpdateFailed('accept wake_review', err);
      if (!(await this.claimWake(bot, job))) return false;
      return this.deliverCompletion(bot, job, adapter, laneKey);
    }
    // Already admitted (a crash before the job claim, re-found by the restore
    // sweep). Whoever wins the row's claim runs it; the replay may have it.
    if (!row.fresh && !spool.claim(row.id, this.deps.spoolOwner)) {
      await this.claimWake(bot, job);
      return true;
    }
    if (!(await this.claimWake(bot, job))) {
      this.deps.closeSpool(row.id);
      return false;
    }
    const review = {
      jobId: job.id,
      fallbackText,
      roomAudience,
      ...(job.tainted ? { tainted: true } : {}),
    };
    this.enqueueReview(bot, adapter, message, row.id, review, laneKey);
    return true;
  }

  /** Queue a review turn on its lane; it resolves the row itself. */
  enqueueReview(
    bot: GatewayBotConfig,
    adapter: PlatformAdapter,
    message: InboundMessage,
    spoolId: string,
    review: WakeReview,
    laneKey: string,
  ): void {
    const threadId = message.threadId ? message.threadId : undefined;
    const lane = this.deps.getOrCreateLane(laneKey);
    void this.deps
      .enqueueTurn(laneKey, lane, bot, message, adapter, message.text, threadId, spoolId, review)
      .catch((err: unknown) => {
        this.deps.observability?.recordSafetyBlock({
          code: 'gateway.review_turn_failed',
          cause: err instanceof Error ? err.message : String(err),
          details: { jobId: review.jobId, spoolId, platform: message.platform },
        });
      });
  }

  /**
   * Win the right to announce this job's completion, exactly once.
   *
   * The `jobs.delivered_at` claim is the authority — it is atomic and it
   * survives a restart, which the in-memory `deliveredWakes` Set does not.
   * A store error deliberately fails OPEN (returns true): a completion the user
   * is waiting on must not be swallowed by an audit-column write, and the worst
   * case is one duplicate notice, which the outbound dedup cache usually eats.
   */
  async claimWake(bot: GatewayBotConfig, job: BackgroundJob): Promise<boolean> {
    if (!bot.jobStore) return true; // no durable store wired — Set-only, as before
    try {
      return await bot.jobStore.claimDelivery(job.id);
    } catch (err) {
      this.deps.observability?.recordSafetyBlock({
        code: 'background.delivery_claim_failed',
        cause: err instanceof Error ? err.message : String(err),
        details: { jobId: job.id, botKey: bot.botKey },
      });
      return true;
    }
  }

  /**
   * Remember an announced job in-process. Bounded: the durable claim is the real
   * exactly-once gate, so this Set only needs to cover the window between an
   * `onComplete` firing twice — it must never grow for the life of the process
   * (it used to, and was lost on restart, which is the worst of both).
   */
  markWakeDelivered(jobId: string): void {
    this.deps.deliveredWakes.add(jobId);
    while (this.deps.deliveredWakes.size > DELIVERED_WAKES_MAX) {
      const oldest = this.deps.deliveredWakes.values().next().value;
      if (oldest === undefined) break;
      this.deps.deliveredWakes.delete(oldest);
    }
  }

  /**
   * Send one completion notice through the durable outbound path (item 9's
   * ledger), so a notice the platform never confirmed is redelivered by
   * `sweepPendingDeliveries()` rather than silently lost. Returns whether the
   * platform confirmed. A dedup hit counts as delivered — the identical text
   * already reached this lane.
   */
  async deliverCompletion(
    bot: GatewayBotConfig,
    job: BackgroundJob,
    adapter: PlatformAdapter,
    laneKey: string,
  ): Promise<boolean> {
    const platform = job.originPlatform;
    const chatId = job.originChatId;
    if (!platform || !chatId) return false;
    // D8 — steers the job never read ride on its completion notice. A failed
    // read costs the suffix, never the notice.
    const unread = (await bot.jobControl?.steers(job).catch(() => [] as JobSteer[]))?.filter(
      (s) => s.state === 'unread',
    );
    const text = this.buildWakeNotice(job, unread ?? []);
    const sessionKey = this.deps.sessionKeys.get(laneKey) ?? laneKey;
    // U11 — a wake notice is unprompted: held for quiet hours or a lane mute.
    // `true`: the held store now owns it, so the job's delivery claim stays.
    if (
      await this.deps.holdNotice({
        botKey: bot.botKey,
        platform,
        chatId,
        ...(job.originThreadId ? { threadId: job.originThreadId } : {}),
        laneKey,
        sessionKey,
        text,
      })
    ) {
      return true;
    }
    if (!this.deps.outboundDedup.shouldSend(laneKey, text)) return true;
    return this.deps.sendTracked(
      {
        adapter,
        botKey: bot.botKey,
        platform,
        chatId,
        sessionKey,
      },
      { text, threadId: job.originThreadId },
    );
  }

  /**
   * Notice text for a finished background job: a plain, trusted envelope plus
   * the job's own summary/error wrapped as untrusted content (it may echo
   * whatever the child agent read). Mirrors the `channel_message` treatment.
   */
  buildWakeNotice(job: BackgroundJob, unread: JobSteer[] = []): string {
    const shortId = job.id.slice(0, 8);
    const labelPart = job.label ? `"${job.label}" ` : '';
    // Interrupted by its runtime's shutdown: no result to relay, and the error
    // is our own constant — a trusted one-liner, nothing to wrap.
    if (job.status === 'aborted') {
      return `background job ${shortId} ${labelPart}was interrupted by a restart or config change — ask again to rerun${unreadSteerSuffix(unread)}`;
    }
    // H6 — a human sentence, not a bracketed record. A failure names where
    // the detail lives (`ethos process logs <id>`).
    const envelope =
      job.status === 'done'
        ? `background job ${shortId} ${labelPart}finished`
        : job.status === 'failed'
          ? `background job ${shortId} ${labelPart}failed — ethos process logs ${shortId}`
          : `background job ${shortId} ${labelPart}finished — status: ${job.status}`;
    const body =
      job.status === 'done' ? (job.summary ?? '(no summary)') : (job.error ?? 'unknown error');
    const wrapped = wrapUntrusted({ content: body, toolName: 'background_job_summary' });
    const tier1 = shortPatternCheck(body);
    if (tier1.containsInstructions || wrapped.strippedTokens > 0) {
      this.deps.observability?.recordInjectionFlag?.({
        code: 'background.injection_detected',
        cause: tier1.containsInstructions
          ? (tier1.hits[0]?.rule ?? 'pattern-hit')
          : `stripped ${wrapped.strippedTokens} template token${wrapped.strippedTokens === 1 ? '' : 's'}`,
        details: {
          jobId: job.id,
          ...(job.originPlatform ? { platform: job.originPlatform } : {}),
          ...(job.originChatId ? { chatId: job.originChatId } : {}),
          ...(tier1.containsInstructions ? { hits: tier1.hits } : {}),
        },
      });
    }
    return `${envelope}\n\n${wrapped.content}${unreadSteerSuffix(unread)}`;
  }

  /**
   * U11 — admit every parked `deliver: 'parent'` review whose hold has ended
   * ({@link admitWakeReview}). A review whose bot has no adapter here stays
   * parked. Run beside {@link releaseHeldNotices} at the top of every delivery
   * sweep, so it follows the sweep's boot pass and 60s timer.
   */
  async releaseParkedReviews(): Promise<number> {
    let released = 0;
    for (const [jobId, parked] of [...this.deps.parkedReviews]) {
      const { bot, job, laneKey } = parked;
      if (this.deps.noticeHoldReason(bot.botKey, laneKey)) continue;
      const adapter = job.originPlatform
        ? this.deps.adapterForBot(bot.botKey, job.originPlatform)
        : undefined;
      if (!adapter) continue;
      this.deps.parkedReviews.delete(jobId);
      await this.admitWakeReview(bot, job, adapter, laneKey).catch((err: unknown) => {
        this.deps.observability?.recordSafetyBlock({
          code: 'gateway.review_turn_failed',
          cause: err instanceof Error ? err.message : String(err),
          details: { jobId, platform: job.originPlatform },
        });
      });
      released++;
    }
    return released;
  }

  // ---------------------------------------------------------------------------
  // Restart-durable background completions (item 10)
  // ---------------------------------------------------------------------------

  /**
   * Announce every background job that finished while nobody was listening.
   *
   * The gap item 9's ledger structurally cannot close: a process that died
   * before announcing a completion never called `record()`, so no pending
   * obligation exists and the ledger has nothing to redeliver. The job row's
   * own `delivered_at` is the missing bit of state — NULL on a terminal row
   * means "finished, never announced", which is precisely this sweep's input.
   *
   * Ownership matches the ledger's rule (`botKey ∈ this.deps.bots`): the query is
   * scoped per bot, so a deployment sharing a `jobs.db` never announces another
   * deployment's completions. The claim is atomic, so two processes booting at
   * once announce each completion exactly once. Delivery itself goes through
   * `sendTracked`, which is how a restored completion inherits the ledger's
   * durability and thread-correct redelivery.
   *
   * Must run AFTER `adapter.start()`, for the same reason the ledger sweep must.
   */
  async sweepUndeliveredJobs(): Promise<{ delivered: number; failed: number }> {
    let delivered = 0;
    let failed = 0;
    for (const bot of this.deps.bots.values()) {
      const store = bot.jobStore;
      if (!store) continue;
      let rows: BackgroundJob[];
      try {
        rows = await store.listUndelivered([bot.botKey]);
      } catch (err) {
        this.deps.observability?.recordSafetyBlock({
          code: 'background.restore_sweep_failed',
          cause: err instanceof Error ? err.message : String(err),
          details: { botKey: bot.botKey },
        });
        continue;
      }
      for (const job of rows) {
        const platform = job.originPlatform;
        const chatId = job.originChatId;
        if (!platform || !chatId) continue;
        // This bot's own adapter — never a sibling's (F08, `adapterForBot`).
        const adapter = this.deps.adapterForBot(bot.botKey, platform);
        if (!adapter) {
          // This process owns the bot but not an adapter for it on this
          // platform. Hand the row back untouched rather than burning its one
          // claim.
          failed++;
          continue;
        }
        const laneKey = job.originThreadId
          ? buildLaneKey(platform, bot.botKey, chatId, job.originThreadId)
          : buildLaneKey(platform, bot.botKey, chatId);
        try {
          // `deliver: 'parent'`: spool first, THEN the claim — see admitWakeReview.
          if (job.deliver === 'parent' && this.deps.inboundSpool) {
            this.markWakeDelivered(job.id);
            if (await this.admitWakeReview(bot, job, adapter, laneKey)) delivered++;
            continue;
          }
          if (!(await store.claimDelivery(job.id))) continue; // a peer won it
          this.markWakeDelivered(job.id);
          const ok = await this.deliverCompletion(bot, job, adapter, laneKey);
          if (ok) {
            delivered++;
            continue;
          }
          failed++;
          // With a ledger wired, `sendTracked` left a `pending` obligation and
          // the ledger sweep owns the retry — keep the claim so the completion
          // is not announced twice. Without one there is no retry anywhere, so
          // release the claim and let the next boot try again.
          if (!this.deps.deliveryLedger) await store.releaseDelivery(job.id);
        } catch (err) {
          failed++;
          this.deps.observability?.recordSafetyBlock({
            code: 'background.restore_delivery_failed',
            cause: err instanceof Error ? err.message : String(err),
            details: { jobId: job.id, botKey: bot.botKey, platform },
          });
        }
      }
    }
    return { delivered, failed };
  }
}
