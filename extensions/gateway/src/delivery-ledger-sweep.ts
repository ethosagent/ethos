// Delivery-ledger redelivery (the boot sweep, the periodic sweep, the refusal
// backoff and voice redelivery) plus the reply-dedup local inbound id, moved
// out of index.ts (Context Budget 3, Task 2). `Gateway` constructs one
// `DeliveryLedgerSweep` and keeps a delegating method under every cited name
// (`Gateway.sweepPendingDeliveries`, `startDeliverySweep`,
// `settleRefusedRedelivery`, `recordRedelivered`, `localInboundId`).
//
// It owns no state. The sweep timer, the in-flight sweep, the local-id WeakMap
// and counter and the outbound dedup cache stay `Gateway` fields — `shutdown`
// stops the timer and joins the in-flight sweep there — and are read and
// written through the live accessors in `deps`, so each keeps one owner.

import type { DeliveryLedger, DeliveryObligation } from '@ethosagent/delivery-ledger';
import type { DeliveryResult, InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { isVoiceOutboundAdapter, voiceAudioExtension, voiceAudioMimeType } from '@ethosagent/types';
import type { MessageDedupCache } from './dedup';
import { isDeliveryInFlight } from './delivery';
import type { GatewayBotConfig, GatewayObservability } from './gateway-config';
import {
  DELIVERY_CLAIM_STALE_MS,
  DELIVERY_SWEEP_MIN_AGE_MS,
  deliveryRetryDelayMs,
} from './gateway-pure';
import type { VoiceArtifactStore } from './voice-artifacts';

/** What `DeliveryLedgerSweep` reads and calls on `Gateway`: live getters (and setters for
 *  the fields it writes) over `Gateway`-owned state, closures for its methods. */
export interface DeliveryLedgerSweepDeps {
  adapterForBot(botKey: string, platform: string): PlatformAdapter | undefined;
  readonly bots: Map<string, GatewayBotConfig>;
  readonly closing: { notify?: string } | null;
  readonly deliveryLedger: DeliveryLedger | undefined;
  readonly deliveryMaxAttempts: number;
  deliverySweepInFlight: Promise<{ redelivered: number; failed: number }> | undefined;
  readonly deliverySweepIntervalMs: number;
  deliverySweepTimer: ReturnType<typeof setInterval> | undefined;
  readonly localInboundIds: WeakMap<InboundMessage, string>;
  localInboundSeq: number;
  readonly observability: GatewayObservability | undefined;
  readonly outboundDedup: MessageDedupCache;
  releaseHeldNotices(): Promise<number>;
  releaseParkedReviews(): Promise<number>;
  readonly voiceArtifacts: VoiceArtifactStore | undefined;
}

export class DeliveryLedgerSweep {
  constructor(private readonly deps: DeliveryLedgerSweepDeps) {}

  /**
   * Redeliver every `pending` obligation this process OWNS.
   *
   * Ownership is `botKey ∈ this.deps.bots` — a deployment sharing a ledger file
   * never touches another deployment's rows. Two processes that DO share a
   * botKey are separated by the ledger's atomic claim, so each obligation is
   * redelivered exactly once. Note the corollary: age alone never authorizes
   * a redelivery, because an old `pending` row may belong to a live peer that
   * is mid-send. The claim is what makes the sweep safe, not a threshold.
   *
   * Redelivery calls `adapter.send()` DIRECTLY, bypassing `shouldSend()` — a
   * warm dedup cache must not swallow a message the user never received — then
   * calls `record()` so a *subsequent* duplicate is still suppressed. That is
   * exactly what `record()` exists for; no new dedup API is needed.
   *
   * Must run AFTER `adapter.start()`: a sweep against a cold adapter is a
   * silent no-op that also burns the obligation.
   *
   * Never overlaps itself: a call made while a sweep runs (the boot call, a
   * {@link startDeliverySweep} tick) joins that sweep instead of starting a
   * second (`deliverySweepInFlight`). Each sweep first returns stranded
   * `redelivering` claims to `pending` (`DeliveryLedger.reclaimStaleClaims`,
   * older than `DELIVERY_CLAIM_STALE_MS`).
   */
  async sweepPendingDeliveries(): Promise<{ redelivered: number; failed: number }> {
    return this.runDeliverySweep(0);
  }

  /** The id `replyDedupScope` falls back to for a message with no spool row
   *  and no platform id: `gw-local:<n>`, assigned once per message object. */
  localInboundId(message: InboundMessage): string {
    let id = this.deps.localInboundIds.get(message);
    if (id === undefined) {
      this.deps.localInboundSeq += 1;
      id = `gw-local:${this.deps.localInboundSeq}`;
      this.deps.localInboundIds.set(message, id);
    }
    return id;
  }

  /**
   * Re-arm dedup for a redelivered obligation. Both keys: the content-only one
   * the notice paths check, and — for a row that answered a spooled inbound
   * message — the scoped one its reply path checks (`replyDedupScope`, UBP-014).
   */
  recordRedelivered(row: DeliveryObligation): void {
    this.deps.outboundDedup.record(row.sessionId, row.content);
    if (row.inboundRef) {
      this.deps.outboundDedup.record(row.sessionId, row.content, { inboundId: row.inboundRef });
    }
  }

  /**
   * Arm the periodic delivery sweep (plan openclaw-2026.9.6-gaps R1): every
   * `deliverySweepIntervalMs` (default 60s, 0 = never), unref'd. Call AFTER
   * `adapter.start()`, beside the boot {@link sweepPendingDeliveries} — the
   * first tick lands one interval later, and a tick that fires while the boot
   * sweep is still running joins it. Idempotent; {@link shutdown} stops it.
   *
   * A tick skips `pending` rows younger than `DELIVERY_SWEEP_MIN_AGE_MS`: they
   * may be replies still in flight, which the ledger does not claim. Every
   * sweep also skips a row whose live send is still running in this process
   * (`isDeliveryInFlight`), whatever its age.
   */
  startDeliverySweep(): void {
    if (this.deps.deliverySweepTimer || this.deps.deliverySweepIntervalMs <= 0 || this.deps.closing)
      return;
    if (!this.deps.deliveryLedger) return;
    this.deps.deliverySweepTimer = setInterval(() => {
      if (this.deps.closing) return;
      void this.runDeliverySweep(DELIVERY_SWEEP_MIN_AGE_MS).catch(() => {});
    }, this.deps.deliverySweepIntervalMs);
    this.deps.deliverySweepTimer.unref?.();
  }

  runDeliverySweep(minAgeMs: number): Promise<{ redelivered: number; failed: number }> {
    if (this.deps.deliverySweepInFlight) return this.deps.deliverySweepInFlight;
    const run = this.sweepDeliveriesOnce(minAgeMs).finally(() => {
      this.deps.deliverySweepInFlight = undefined;
    });
    this.deps.deliverySweepInFlight = run;
    return run;
  }

  async sweepDeliveriesOnce(minAgeMs: number): Promise<{ redelivered: number; failed: number }> {
    // U11 — held notices whose window has ended go out first, filing their
    // obligations before this sweep reads the ledger.
    await this.deps.releaseHeldNotices().catch(() => 0);
    await this.deps.releaseParkedReviews().catch(() => 0);
    const ledger = this.deps.deliveryLedger;
    if (!ledger) return { redelivered: 0, failed: 0 };

    try {
      const reclaimed = await ledger.reclaimStaleClaims(Date.now() - DELIVERY_CLAIM_STALE_MS);
      if (reclaimed > 0) {
        this.deps.observability?.recordSafetyBlock({
          code: 'gateway.delivery_claims_reclaimed',
          details: { count: reclaimed },
        });
      }
    } catch (err) {
      // A failed reclaim costs only the stranded rows; the sweep still runs.
      this.deps.observability?.recordSafetyBlock({
        code: 'gateway.delivery_sweep_failed',
        cause: err instanceof Error ? err.message : String(err),
        details: { stage: 'reclaimStaleClaims' },
      });
    }

    let pending: Awaited<ReturnType<DeliveryLedger['listPending']>>;
    try {
      const now = Date.now();
      const newest = now - minAgeMs;
      // Two gates. Age guards a live send (see DELIVERY_SWEEP_MIN_AGE_MS; the
      // boot sweep passes 0). `nextAttemptAt` is the backoff a refused
      // redelivery set (`settleRefusedRedelivery`), and binds EVERY sweep,
      // the boot one included — a restart is not a reason to hit a platform
      // that refused a minute ago.
      pending = (await ledger.listPending([...this.deps.bots.keys()])).filter(
        (row) =>
          (minAgeMs <= 0 || row.createdAt <= newest) &&
          (row.nextAttemptAt === undefined || row.nextAttemptAt <= now),
      );
    } catch (err) {
      this.deps.observability?.recordSafetyBlock({
        code: 'gateway.delivery_sweep_failed',
        cause: err instanceof Error ? err.message : String(err),
      });
      return { redelivered: 0, failed: 0 };
    }

    let redelivered = 0;
    let failed = 0;
    for (const row of pending) {
      // The row's OWN bot's adapter, never the platform's default: a sibling
      // bot's `ok: true` would mark this bot's obligation delivered (F08).
      // Resolved BEFORE the claim, so a row this process cannot deliver is left
      // exactly as it was — still `pending`, never burned, never held in
      // `redelivering` where a peer that does own the adapter would skip it.
      // A live reply path in THIS process is still sending it (registered by
      // `beginDelivery` until `endDelivery`): redelivering now would send it
      // twice. It is neither a redelivery nor a failure; a later sweep takes it
      // if that send ends unconfirmed.
      if (isDeliveryInFlight(ledger, row.id)) continue;
      const adapter = this.deps.adapterForBot(row.botKey, row.platform);
      if (!adapter) {
        failed++;
        continue;
      }
      let claimed = false;
      try {
        claimed = await ledger.claim(row.id);
        if (!claimed) continue; // a peer process won the claim
        if (row.kind === 'voice') {
          // A voice obligation owes BYTES, not a string, so it takes its own
          // path — one that re-sends the stored artifact and never
          // re-synthesizes (a second TTS pass is a different recording).
          if (await this.redeliverVoiceObligation(row, adapter, ledger)) redelivered++;
          else failed++;
          continue;
        }
        // The row carries its thread, so a redelivered reply returns to the
        // sub-conversation it belonged to instead of the root chat. `threadId`
        // is `undefined` for an unthreaded row — never '' or the string 'null',
        // which some adapters would forward to the platform verbatim.
        const result = await adapter
          .send(row.chatId, { text: row.content, threadId: row.threadId })
          .catch(
            (err: unknown): DeliveryResult => ({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        if (result?.ok === true) {
          await ledger.markDelivered(row.id);
          this.recordRedelivered(row);
          redelivered++;
          this.deps.observability?.recordSafetyBlock({
            code: 'gateway.delivery_redelivered',
            details: {
              platform: row.platform,
              botKey: row.botKey,
              chatId: row.chatId,
              contentHash: row.contentHash,
              createdAt: row.createdAt,
            },
          });
        } else {
          await this.settleRefusedRedelivery(row, ledger, result ?? {});
          failed++;
        }
      } catch (err) {
        if (claimed) await ledger.release(row.id).catch(() => {});
        failed++;
        this.deps.observability?.recordSafetyBlock({
          code: 'gateway.delivery_redelivery_failed',
          cause: err instanceof Error ? err.message : String(err),
          details: { platform: row.platform, botKey: row.botKey },
        });
      }
    }
    return { redelivered, failed };
  }

  /**
   * Settle a claimed row whose redelivery the platform refused. The one owner
   * of the retry policy: a `permanent` refusal (`DeliveryResult.permanent`) or
   * the `deliveryMaxAttempts`-th refusal abandons the row, with the reason
   * recorded on it (`DeliveryLedger.abandon`), a voice artifact released, and a
   * `gateway.delivery_abandoned` event; anything else goes back to `pending`,
   * not due again until `deliveryRetryDelayMs` has passed
   * (`DeliveryLedger.deferRetry`). Pinned by the 'redelivery backoff and cap'
   * cases in `__tests__/delivery-ledger.test.ts`.
   */
  async settleRefusedRedelivery(
    row: DeliveryObligation,
    ledger: DeliveryLedger,
    refusal: { error?: string; permanent?: boolean },
  ): Promise<void> {
    const attempts = row.attempts + 1;
    const error = refusal.error ?? 'unconfirmed';
    const permanent = refusal.permanent === true;
    const reason = permanent
      ? `permanent: ${error}`
      : attempts >= this.deps.deliveryMaxAttempts
        ? `gave up after ${attempts} attempts: ${error}`
        : undefined;
    if (!reason) {
      await ledger.deferRetry(row.id, Date.now() + deliveryRetryDelayMs(attempts));
      return;
    }
    const abandoned = await ledger.abandon(row.id, reason);
    if (!abandoned) return;
    if (abandoned.artifactRef) await this.deps.voiceArtifacts?.remove(abandoned.artifactRef);
    this.deps.observability?.recordSafetyBlock({
      code: 'gateway.delivery_abandoned',
      cause: reason,
      details: {
        platform: row.platform,
        botKey: row.botKey,
        chatId: row.chatId,
        kind: row.kind,
        attempts,
        permanent,
        contentHash: row.contentHash,
      },
    });
  }

  /**
   * Redeliver one claimed `voice` obligation by re-sending its stored artifact.
   *
   * It never re-synthesizes. A second TTS pass is a different recording — the
   * engine is not deterministic and the personality's voice may have changed
   * since — so the user would receive an answer they can hear is not the one
   * that was lost. The artifact IS the obligation's payload.
   *
   * Returns whether the platform confirmed. Every failure goes through
   * {@link settleRefusedRedelivery}: back to the pending pool on a backoff, or
   * abandoned at the attempt cap or when the artifact is gone.
   */
  async redeliverVoiceObligation(
    row: DeliveryObligation,
    adapter: PlatformAdapter,
    ledger: DeliveryLedger,
  ): Promise<boolean> {
    const giveBack = async (code: string, details: Record<string, unknown> = {}) => {
      this.deps.observability?.recordSafetyBlock({
        code,
        details: { platform: row.platform, botKey: row.botKey, chatId: row.chatId, ...details },
      });
      // A vanished artifact can never be re-sent — the bytes ARE the
      // obligation — so it is permanent; every other refusal backs off. Only
      // when a store is wired: a process with none cannot see an artifact a
      // properly configured peer could still send.
      await this.settleRefusedRedelivery(row, ledger, {
        error: typeof details.error === 'string' ? details.error : code,
        permanent:
          code === 'gateway.voice_artifact_missing' && this.deps.voiceArtifacts !== undefined,
      });
      return false;
    };

    const ref = row.artifactRef;
    const bytes = ref ? await this.deps.voiceArtifacts?.read(ref) : undefined;
    if (!bytes) {
      // Deliberately NOT a text fallback on `row.content`. The written reply
      // for this turn already went out under its own obligation, so sending
      // the spoken text as a message here would deliver the same answer twice.
      // A missing voice note is the smaller failure, and the event names it.
      return giveBack('gateway.voice_artifact_missing', { artifactRef: ref ?? null });
    }
    if (!isVoiceOutboundAdapter(adapter)) {
      return giveBack('gateway.voice_no_caps');
    }

    const declared = adapter.voiceCaps.outbound.formats;
    // The row's own format is authoritative: the artifact holds exactly those
    // bytes, and re-labelling them would hand the platform a mislabelled
    // container. It is matched against the adapter's declared list because that
    // is the only typed source of `VoiceAudioFormat` values here — a stored
    // format the adapter no longer accepts (a caps change between the send and
    // the sweep) is refused rather than mislabelled. A null column is a pre-v3
    // row or a store that lost it; the sink's preferred format is the best
    // available guess.
    const format = row.mediaFormat ? declared.find((f) => f === row.mediaFormat) : declared[0];
    if (!format) {
      return giveBack('gateway.voice_format_unsupported', {
        format: row.mediaFormat,
        accepted: declared,
      });
    }

    const result = await adapter
      .sendVoiceNote(row.chatId, bytes, {
        format,
        mimeType: voiceAudioMimeType(format),
        filename: `reply.${voiceAudioExtension(format)}`,
        ...(row.threadId ? { threadId: row.threadId } : {}),
      })
      .catch(
        (err: unknown): DeliveryResult => ({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    if (result?.ok !== true) {
      return giveBack('gateway.delivery_unconfirmed', { kind: 'voice', error: result?.error });
    }

    await ledger.markDelivered(row.id);
    // Redelivery bypassed `shouldSend()` — a warm cache must not swallow what
    // the user never received — so record the key afterwards, exactly as the
    // text path does, and release the artifact now that it is discharged.
    this.recordRedelivered(row);
    if (ref) await this.deps.voiceArtifacts?.remove(ref);
    this.deps.observability?.recordSafetyBlock({
      code: 'gateway.delivery_redelivered',
      details: {
        kind: 'voice',
        platform: row.platform,
        botKey: row.botKey,
        chatId: row.chatId,
        contentHash: row.contentHash,
        createdAt: row.createdAt,
      },
    });
    return true;
  }
}
