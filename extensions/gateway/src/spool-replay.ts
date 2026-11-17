// Inbound-spool replay (rules gateway-inbound-spool.md): the boot and periodic
// replay, orphan recovery, per-row replay with its dead-letter and staleness
// checks, wake-review replay and reviving a spooled message. Moved out of
// index.ts (Context Budget 3, Task 2). `Gateway` constructs one `SpoolReplay`
// and keeps a delegating method under every cited name
// (`Gateway.replayInboundSpool`, `replaySpoolRow`).
//
// It owns no state. The `replaying` flag (read by `acceptInbound`), the
// in-flight replay, the replay timer (stopped by `Gateway.shutdown`) and the
// orphans-recovered flag stay `Gateway` fields, read and written through the
// live accessors in `deps`.

import type { DeliveryLedger } from '@ethosagent/delivery-ledger';
import type { InboundSpool, SpoolRow } from '@ethosagent/inbound-spool';
import type {
  AttachmentCache,
  BackgroundJob,
  InboundMessage,
  PlatformAdapter,
  Storage,
  TurnAudience,
} from '@ethosagent/types';
import type {
  GatewayBotConfig,
  GatewayObservability,
  HandleMessageOptions,
} from './gateway-config';
import {
  ATTACHMENT_NOT_RECOVERED_NOTE,
  describeReplayAge,
  type SpoolTurnTarget,
  spooledText,
  type WakeReview,
} from './gateway-pure';

/** What `SpoolReplay` reads and calls on `Gateway`: live getters (and setters for
 *  the fields it writes) over `Gateway`-owned state, closures for its methods. */
export interface SpoolReplayDeps {
  adapterForBot(botKey: string, platform: string): PlatformAdapter | undefined;
  readonly attachmentCache: AttachmentCache | undefined;
  readonly bots: Map<string, GatewayBotConfig>;
  readonly closing: { notify?: string } | null;
  deliverReviewFallback(
    spoolId: string,
    target: SpoolTurnTarget,
    text: string,
    reason: string,
  ): Promise<void>;
  readonly deliveryLedger: DeliveryLedger | undefined;
  enqueueReview(
    bot: GatewayBotConfig,
    adapter: PlatformAdapter,
    message: InboundMessage,
    spoolId: string,
    review: WakeReview,
    laneKey: string,
  ): void;
  foldAbsorbed(
    spool: InboundSpool,
    row: SpoolRow,
    message: InboundMessage,
  ): Promise<InboundMessage>;
  handleMessage(
    message: InboundMessage,
    adapter: PlatformAdapter,
    opts?: HandleMessageOptions,
  ): Promise<void>;
  readonly inboundSpool: InboundSpool | undefined;
  readonly interruptedLanes: Set<string>;
  notifyDeadLettered(spoolId: string, reason: string, target: SpoolTurnTarget): Promise<void>;
  notifyInterrupted(spoolId: string, target: SpoolTurnTarget): Promise<void>;
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
  orphansRecovered: boolean;
  recordSpoolDeadLettered(spoolId: string, reason: string): void;
  recordSpoolUpdateFailed(stage: string, err: unknown): void;
  replayInFlight: Promise<{ replayed: number; deferred: number; dead: number }> | undefined;
  replaying: boolean;
  reviewAudience(job: BackgroundJob): TurnAudience;
  readonly spoolMaxAttempts: number;
  readonly spoolMaxReplayAgeMs: number;
  readonly spoolOwner: string;
  readonly spoolReplayIntervalMs: number;
  spoolReplayTimer: ReturnType<typeof setInterval> | undefined;
  readonly storage: Storage | undefined;
}

export class SpoolReplay {
  constructor(private readonly deps: SpoolReplayDeps) {}

  /**
   * Replay every `received` spool row this process owns (plan
   * reach-and-containment §2.4). Call AFTER `adapter.start()` — a replayed turn
   * replies through a live adapter — beside `sweepPendingDeliveries()`. The
   * first call also arms a periodic tick (default 60s, unref'd) so a row
   * requeued from `ethos gateway spool replay` or the web Deliveries page is
   * picked up without a restart.
   *
   * 1. First call only: `recoverOrphans` returns every `processing` row (and
   *    every row claimed by another owner) to unclaimed `received`. Safe
   *    because the gateway singleton lock (`acquireGatewayLock`,
   *    packages/wiring/src/gateway-lock.ts, taken by `ethos gateway start`)
   *    proves no live peer gateway shares the file.
   * 2. `listReplayable` — only rows whose `botKey` this process serves. Rows
   *    for an unconfigured bot stay `received` (doctor reports them orphaned).
   * 3. Older than `maxReplayAgeMs` → `dead` (`stale`), whatever its adapter,
   *    and one notice per lane that has an adapter to carry it.
   * 4. The row's adapter is resolved by BOT (`adapterForBot`) BEFORE the
   *    claim; no adapter → the row is left untouched.
   * 5. `claim`, then the double-reply guard: a ledger obligation already
   *    carrying this row's id (`hasObligationFor`) means the reply exists, so
   *    the row closes and the ledger sweep owns delivery.
   * 6. Otherwise `handleMessage` is re-entered with the replay marker — the
   *    same resolution code, the safety filter included — one lane's rows
   *    strictly in order, lanes concurrently. While this runs a live message
   *    is spooled unclaimed and not run; the loop re-lists until nothing
   *    unclaimed is left, so it runs behind the older rows of its lane.
   *
   * Resolves once every row is QUEUED, not once the turns finish.
   */
  async replayInboundSpool(): Promise<{ replayed: number; deferred: number; dead: number }> {
    const spool = this.deps.inboundSpool;
    if (!spool || this.deps.closing) return { replayed: 0, deferred: 0, dead: 0 };
    if (this.deps.replayInFlight) return this.deps.replayInFlight;
    const run = this.runSpoolReplay(spool).finally(() => {
      this.deps.replayInFlight = undefined;
    });
    this.deps.replayInFlight = run;
    if (!this.deps.spoolReplayTimer && this.deps.spoolReplayIntervalMs > 0) {
      this.deps.spoolReplayTimer = setInterval(() => {
        void this.replayInboundSpool().catch(() => {});
      }, this.deps.spoolReplayIntervalMs);
      this.deps.spoolReplayTimer.unref?.();
    }
    return run;
  }

  async runSpoolReplay(
    spool: InboundSpool,
  ): Promise<{ replayed: number; deferred: number; dead: number }> {
    const counts = { replayed: 0, deferred: 0, dead: 0 };
    if (!this.deps.orphansRecovered) {
      this.deps.orphansRecovered = true;
      try {
        spool.recoverOrphans(this.deps.spoolOwner);
        // Rows a previous process interrupted still answer to `retry` here.
        for (const row of spool.listInterrupted(500)) {
          if (this.deps.bots.has(row.botKey)) this.deps.interruptedLanes.add(row.laneKey);
        }
      } catch (err) {
        this.deps.recordSpoolUpdateFailed('recoverOrphans', err);
      }
    }
    // Rows this run has already dealt with (deferred, stale, lost claims) —
    // without it a row with no adapter would be re-listed forever.
    const seen = new Set<string>();
    const staleByLane = new Map<string, { row: SpoolRow; count: number; samples: string[] }>();
    this.deps.replaying = true;
    try {
      for (;;) {
        let rows: SpoolRow[];
        try {
          rows = spool.listReplayable([...this.deps.bots.keys()]).filter((r) => !seen.has(r.id));
        } catch (err) {
          this.deps.observability?.recordSafetyBlock({
            code: 'gateway.spool_replay_failed',
            cause: err instanceof Error ? err.message : String(err),
          });
          break;
        }
        // `break` runs the `finally` synchronously, so no live message can be
        // spooled unclaimed between this empty list and `replaying = false`.
        if (rows.length === 0) break;
        const byLane = new Map<string, SpoolRow[]>();
        for (const row of rows) {
          seen.add(row.id);
          const laneRows = byLane.get(row.laneKey);
          if (laneRows) laneRows.push(row);
          else byLane.set(row.laneKey, [row]);
        }
        await Promise.all(
          [...byLane.values()].map(async (laneRows) => {
            for (const row of laneRows) await this.replaySpoolRow(spool, row, staleByLane, counts);
          }),
        );
      }
    } finally {
      this.deps.replaying = false;
    }
    for (const { row, count, samples } of staleByLane.values()) {
      // H6 — quote what was missed (first 40 chars of each, up to 3), so the
      // user knows WHICH messages to resend rather than a bare count.
      const quoted = samples.map((s) => `"${s.length > 40 ? `${s.slice(0, 40)}…` : s}"`);
      const more = count - quoted.length;
      const missed =
        quoted.length > 0
          ? ` Missed: ${quoted.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`
          : '';
      await this.deps
        .notifyTracked(
          {
            platform: row.platform,
            chatId: row.chatId,
            botKey: row.botKey,
            sessionKey: row.laneKey,
            ...(row.threadId ? { threadId: row.threadId } : {}),
            answersInbound: true,
          },
          `I restarted and missed ${count} message(s) older than ${describeReplayAge(
            this.deps.spoolMaxReplayAgeMs,
          )}; resend if still needed.${missed}`,
        )
        .catch(() => false);
    }
    return counts;
  }

  async replaySpoolRow(
    spool: InboundSpool,
    row: SpoolRow,
    staleByLane: Map<string, { row: SpoolRow; count: number; samples: string[] }>,
    counts: { replayed: number; deferred: number; dead: number },
  ): Promise<void> {
    // BY BOT, before the claim — the ledger sweep's rule: a row this process
    // cannot answer is left exactly as it was, never claimed and stranded.
    const adapter = this.deps.adapterForBot(row.botKey, row.platform);
    const stale = Date.now() - row.receivedAt > this.deps.spoolMaxReplayAgeMs;
    // Staleness BEFORE the adapter check: a row too old to answer is too old
    // whatever its adapter, and deferring it instead kept a row no adapter
    // will ever serve (one a pre-fix build spooled from a capturing adapter —
    // see `acceptInbound`) `received` forever. The lane is told only when an
    // adapter can tell it; with none there is nowhere to send the notice.
    if (stale && row.kind !== 'wake_review') {
      try {
        // Answering a day-old question as if it were fresh is worse than
        // saying so: dead-letter it and tell the lane once.
        if (spool.markDead(row.id, 'stale')) {
          counts.dead++;
          this.deps.recordSpoolDeadLettered(row.id, 'stale');
          if (adapter) {
            const entry = staleByLane.get(row.laneKey) ?? { row, count: 0, samples: [] };
            entry.count++;
            // Up to 3 quoted texts per lane; the notice adds "and N more".
            if (entry.samples.length < 3) {
              const text = spooledText(row);
              if (text) entry.samples.push(text);
            }
            staleByLane.set(row.laneKey, entry);
          }
        }
      } catch (err) {
        this.deps.observability?.recordSafetyBlock({
          code: 'gateway.spool_replay_failed',
          cause: err instanceof Error ? err.message : String(err),
          details: { spoolId: row.id, platform: row.platform, botKey: row.botKey },
        });
      }
      return;
    }
    if (!adapter) {
      counts.deferred++;
      return;
    }
    try {
      if (!spool.claim(row.id, this.deps.spoolOwner)) return;
      if (this.deps.deliveryLedger && (await this.deps.deliveryLedger.hasObligationFor(row.id))) {
        spool.markDone(row.id);
        this.deps.observability?.recordSafetyBlock({
          code: 'gateway.spool_replay_already_answered',
          details: { spoolId: row.id, platform: row.platform, botKey: row.botKey },
        });
        return;
      }
      // A parent-review row (plan openclaw-9.5-adoption item 6, D29) never
      // passes through `handleMessage`: no clarify correlator, no slash
      // parsing. It replays as the review turn it was — unless it cannot, and
      // then the user gets the plain wake notice instead, never nothing.
      if (row.kind === 'wake_review') {
        await this.replayWakeReview(row, adapter, stale, counts);
        return;
      }
      // D5: the crashed turn had started a tool. Re-running it would repeat a
      // half-executed action on the user's behalf, so it is NOT replayed: the
      // row waits for the user's `retry` and they are told so. Marked before
      // the notice, so a crash in between cannot notify twice.
      if (row.toolStartedAt !== undefined) {
        if (spool.markInterrupted(row.id, 'interrupted after a tool started')) {
          await this.deps.notifyInterrupted(row.id, {
            botKey: row.botKey,
            platform: row.platform,
            chatId: row.chatId,
            threadId: row.threadId,
            laneKey: row.laneKey,
          });
        }
        return;
      }
      // UBP-022: a turn that killed the process never reached `markFailed`, so
      // its cap was never read there. `markProcessing` counted each attempt and
      // `recoverOrphans` kept the count: at the cap the row is dead-lettered
      // here instead of crash-looping every boot until the stale cutoff. The
      // extra `markProcessing` lets `markFailed` (which only moves a
      // `processing` row) write `dead`. Pinned by `__tests__/inbound-spool.test.ts`
      // ('a message that kills the process').
      if (row.attempts >= this.deps.spoolMaxAttempts) {
        const reason = `the turn ended the process ${row.attempts} time(s) without finishing`;
        spool.markProcessing(row.id, this.deps.spoolOwner);
        if (spool.markFailed(row.id, reason, this.deps.spoolMaxAttempts) === 'dead') {
          counts.dead++;
          await this.deps.notifyDeadLettered(row.id, reason, {
            botKey: row.botKey,
            platform: row.platform,
            chatId: row.chatId,
            threadId: row.threadId,
            laneKey: row.laneKey,
          });
        }
        return;
      }
      const revived = await this.reviveSpooledMessage(row);
      // Its absorbed steer rows ride in it (they are never listed on their own).
      const message = revived ? await this.deps.foldAbsorbed(spool, row, revived) : null;
      if (!message) {
        // An unreadable payload can never become a turn; dead-letter it now
        // rather than on the third boot.
        spool.markProcessing(row.id, this.deps.spoolOwner);
        spool.markFailed(row.id, 'unreadable payload', 0);
        counts.dead++;
        this.deps.recordSpoolDeadLettered(row.id, 'unreadable payload');
        return;
      }
      counts.replayed++;
      await new Promise<void>((resolve) => {
        void this.deps
          .handleMessage(message, adapter, {
            replaySpoolId: row.id,
            onQueued: resolve,
          })
          .catch((err: unknown) => {
            this.deps.observability?.recordSafetyBlock({
              code: 'gateway.inbound_error',
              cause: 'replayed inbound message handling threw',
              details: {
                platform: row.platform,
                botKey: row.botKey,
                spoolId: row.id,
                error: err instanceof Error ? err.message : String(err),
              },
            });
            resolve();
          });
      });
    } catch (err) {
      this.deps.observability?.recordSafetyBlock({
        code: 'gateway.spool_replay_failed',
        cause: err instanceof Error ? err.message : String(err),
        details: { spoolId: row.id, platform: row.platform, botKey: row.botKey },
      });
    }
  }

  /**
   * Replay one claimed `wake_review` row. A tool had started, it is stale, it
   * hit the attempt cap, its bot is gone or its payload is unreadable → the
   * plain wake notice (`deliverReviewFallback`). Otherwise the review turn runs
   * again on its lane, with `reviewOfJobId` restored from the row.
   */
  async replayWakeReview(
    row: SpoolRow,
    adapter: PlatformAdapter,
    stale: boolean,
    counts: { replayed: number; deferred: number; dead: number },
  ): Promise<void> {
    const target: SpoolTurnTarget = {
      botKey: row.botKey,
      platform: row.platform,
      chatId: row.chatId,
      threadId: row.threadId,
      laneKey: row.laneKey,
    };
    const message = await this.reviveSpooledMessage(row);
    const fallbackText = message?.text ?? '';
    const bot = this.deps.bots.get(row.botKey);
    let reason: string | undefined;
    if (row.toolStartedAt !== undefined) reason = 'review turn interrupted after a tool started';
    else if (stale) reason = 'review turn too old to replay';
    else if (row.attempts >= this.deps.spoolMaxAttempts) reason = 'review turn hit the attempt cap';
    else if (!bot || !message) reason = 'review turn cannot be rebuilt';
    if (reason || !bot || !message) {
      if (fallbackText) {
        await this.deps.deliverReviewFallback(row.id, target, fallbackText, reason ?? 'unreadable');
      } else {
        // Nothing to review and nothing to fall back to: a dead letter.
        this.deps.inboundSpool?.markProcessing(row.id, this.deps.spoolOwner);
        this.deps.inboundSpool?.markFailed(row.id, 'unreadable payload', 0);
        counts.dead++;
        this.deps.recordSpoolDeadLettered(row.id, 'unreadable payload');
      }
      return;
    }
    counts.replayed++;
    const roomAudience = await this.replayedReviewAudience(bot, row, message);
    const jobId = row.reviewJobId ?? '';
    const tainted = await this.reviewJobTainted(bot, jobId);
    this.deps.enqueueReview(
      bot,
      adapter,
      message,
      row.id,
      { jobId, fallbackText, roomAudience, ...(tainted ? { tainted: true } : {}) },
      row.laneKey,
    );
  }

  /**
   * A replayed review's audience: shared when the row says so (the hint
   * `admitWakeReview` spooled), else the job's (`reviewAudience`), read back
   * from the bot's job store. A row whose job cannot be read — no store, a
   * missing row, a store error, a row spooled before the hint existed with no
   * job — runs shared: fail closed.
   */
  async replayedReviewAudience(
    bot: GatewayBotConfig,
    row: SpoolRow,
    message: InboundMessage,
  ): Promise<TurnAudience> {
    if (message.audienceHint === 'shared' || !row.reviewJobId || !bot.jobStore) return 'shared';
    const job = await bot.jobStore.get(row.reviewJobId).catch(() => null);
    return job ? this.deps.reviewAudience(job) : 'shared';
  }

  /**
   * Whether a replayed review's job is tainted (`WakeReview.tainted`). The
   * spool row does not carry it, so it is read back from the job store — and
   * when that read cannot answer (no store, no row, a throw) the review is
   * treated as tainted: a missed downgrade can persist an injection, a spurious
   * one only refuses memory writes for one review turn.
   */
  async reviewJobTainted(bot: GatewayBotConfig, jobId: string): Promise<boolean> {
    try {
      const job = bot.jobStore ? await bot.jobStore.get(jobId) : null;
      return job ? job.tainted === true : true;
    } catch {
      return true;
    }
  }

  /**
   * Rebuild the `InboundMessage` a row was spooled from. Attachments are
   * stored by reference (plan D2-4): one whose cached file is gone is dropped
   * with a `gateway.spool_attachment_missing` event, and the turn still runs —
   * a message with its image missing beats no message. The text then ends
   * with {@link ATTACHMENT_NOT_RECOVERED_NOTE} (plan openclaw-9.5-adoption
   * item 2), so the model answers knowing something is missing rather than
   * as if the user had sent text alone. Pinned by
   * `__tests__/inbound-spool.test.ts` ('missing attachment').
   */
  async reviveSpooledMessage(row: SpoolRow): Promise<InboundMessage | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payload);
    } catch {
      return null;
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { platform?: unknown }).platform !== 'string' ||
      typeof (parsed as { chatId?: unknown }).chatId !== 'string' ||
      typeof (parsed as { text?: unknown }).text !== 'string'
    ) {
      return null;
    }
    const message = { ...(parsed as Omit<InboundMessage, 'raw'>), raw: null } as InboundMessage;
    const attachments = message.attachments;
    const cache = this.deps.attachmentCache;
    const storage = this.deps.storage;
    if (attachments && attachments.length > 0 && cache && storage) {
      const kept: NonNullable<InboundMessage['attachments']> = [];
      for (const att of attachments) {
        let present = true;
        if (att.url.startsWith('file://')) {
          try {
            present = await storage.exists(cache.resolveLocalPath(att.url));
          } catch {
            present = false;
          }
        }
        if (present) {
          kept.push(att);
        } else {
          this.deps.observability?.recordSafetyBlock({
            code: 'gateway.spool_attachment_missing',
            details: { spoolId: row.id, platform: row.platform, type: att.type },
          });
        }
      }
      if (kept.length < attachments.length) {
        message.text = message.text.trim()
          ? `${message.text}\n\n${ATTACHMENT_NOT_RECOVERED_NOTE}`
          : ATTACHMENT_NOT_RECOVERED_NOTE;
      }
      message.attachments = kept;
    }
    return message;
  }
}
