// Agent-initiated outbound sends (`send_message`, cron targets, channel
// digests): `sendVia`, `sendTo`, `sendAsBot` and their shared body
// `sendThrough`, moved out of index.ts (Context Budget 3, Task 2). `Gateway`
// constructs one `OutboundSend` and keeps a delegating method under each public
// name (`Gateway.sendTo`, `sendAsBot`, `sendVia`).
//
// It owns no state. `outboundDedup` and `inFlightSends` stay `Gateway` fields
// (`Gateway.inFlightSends` is cited, and `dedup-reply-scope.test.ts` reads
// `gw['outboundDedup']`); the same instances are reached through `deps`, so the
// reply paths, the delivery sweep and these sends share one cache and one
// in-flight map.

import type { PlatformAdapter } from '@ethosagent/types';
import type { MessageDedupCache } from './dedup';
import type { GatewayObservability } from './gateway-config';
import { platformOfAdapterId } from './gateway-pure';
import {
  attachmentsFromStructured,
  OUTBOUND_MEDIA_MAX_BYTES,
  type OutboundMediaCaps,
} from './media';

/** What `OutboundSend` reads and calls on `Gateway`: live getters (and setters for
 *  the fields it writes) over `Gateway`-owned state, closures for its methods. */
export interface OutboundSendDeps {
  adapterForBot(botKey: string, platform: string): PlatformAdapter | undefined;
  readonly adapterRegistry: Map<string, PlatformAdapter>;
  readonly botAdapters: Map<string, PlatformAdapter>;
  readonly inFlightSends: Map<string, Promise<{ ok: boolean; error?: string }>>;
  readonly observability: GatewayObservability | undefined;
  readonly outboundDedup: MessageDedupCache;
}

export class OutboundSend {
  constructor(private readonly deps: OutboundSendDeps) {}

  // ---------------------------------------------------------------------------
  // Public API — agent-initiated outbound sends (send_message tool)
  // ---------------------------------------------------------------------------

  /**
   * Send from ONE NAMED BOT, resolved by botKey.
   *
   * `sendTo` resolves by PLATFORM, and `adapterRegistry` holds the first
   * adapter registered per platform — so on a multi-bot deployment every
   * cross-platform send leaves through whichever bot happened to start first.
   * For a channel digest that is the wrong answer twice over: the summary of a
   * room bot B watches would arrive from bot A, in bot A's DM, to whoever bot A
   * answers to. This resolves through `botAdapters`, the authoritative
   * botKey-keyed registry, so the bot that watched is the bot that reports.
   *
   * No outbound dedup and no delivery ledger, deliberately. A digest is
   * scheduled, self-contained and regenerated on the next run; a `pending`
   * obligation redelivering yesterday's summary tomorrow is worse than the
   * gap. The caller is told whether the platform confirmed and decides.
   */
  async sendVia(
    botKey: string,
    chatId: string,
    body: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const adapter = this.deps.botAdapters.get(botKey);
    if (!adapter) return { ok: false, error: `No adapter registered for bot "${botKey}"` };
    try {
      const result = await adapter.send(chatId, { text: body });
      if (!result.ok) return { ok: false, error: result.error ?? 'Adapter send failed' };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async sendTo(
    platform: string,
    target: string,
    body: string,
    media?: unknown,
  ): Promise<{ ok: boolean; error?: string }> {
    const adapter = this.deps.adapterRegistry.get(platform);
    if (!adapter) {
      return { ok: false, error: `No adapter registered for platform "${platform}"` };
    }
    return await this.sendThrough(adapter, platform, target, body, media);
  }

  /**
   * Every adapter this process runs on `platform`, deduplicated by identity.
   *
   * `botAdapters` is keyed by the botKey each adapter speaks as, so its values
   * ARE the platform's bots — unlike `adapterRegistry`, which keeps only the
   * first one per platform. One adapter filed under two keys (a legacy alias)
   * is one candidate, not two.
   */
  adaptersOnPlatform(platform: string): PlatformAdapter[] {
    const seen = new Set<PlatformAdapter>();
    for (const adapter of this.deps.botAdapters.values()) {
      if (platformOfAdapterId(adapter.id) === platform) seen.add(adapter);
    }
    return [...seen];
  }

  /**
   * Send AS a named bot — the agent-initiated counterpart to `adapterForBot`
   * (B-T4, plan/phases/trust-before-reach.md).
   *
   * `sendTo` resolves by platform alone: the first adapter registered for it.
   * That is right for a send the OPERATOR aimed at a platform, and wrong for
   * one an agent turn produced, because a turn runs in a lane that names the
   * bot it is speaking as. With two Telegram bots configured, a
   * platform-resolved `send_message` from SupportBot's lane leaves through
   * SalesBot's adapter — the reply arrives from the wrong identity, and the
   * two failures below are why this refuses instead of guessing:
   *
   *  - `botKey` given but no adapter speaks for it here (the bot was removed
   *    from config, or lives in another process) → refuse. Falling back to the
   *    platform default is exactly the wrong-identity send.
   *  - No `botKey` (a CLI or web turn: its lane names no bot) → the platform
   *    default is used ONLY when that platform has exactly one bot, which is
   *    what every single-bot deployment has. With several, nothing in the turn
   *    says which one, so the send is refused as an ambiguous sender rather
   *    than silently attributed to whichever adapter registered first.
   */
  async sendAsBot(
    platform: string,
    target: string,
    body: string,
    botKey?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    if (botKey) {
      const adapter = this.deps.adapterForBot(botKey, platform);
      if (!adapter) {
        return {
          ok: false,
          error:
            `CRON_TARGET_NOT_ALLOWED: no ${platform} bot "${botKey}" is configured here — ` +
            'nothing was sent. Another bot must not speak in its place.',
        };
      }
      return await this.sendThrough(adapter, platform, target, body, undefined);
    }
    const candidates = this.adaptersOnPlatform(platform);
    const only = candidates[0];
    if (!only) {
      return {
        ok: false,
        error: `CRON_TARGET_NOT_ALLOWED: no ${platform} bot is configured here — nothing was sent.`,
      };
    }
    if (candidates.length > 1) {
      return {
        ok: false,
        error:
          `ambiguous sender: ${candidates.length} ${platform} bots are configured and this ` +
          'turn does not run as any of them. Send from a lane on that platform, or remove ' +
          'the extra bots.',
      };
    }
    return await this.sendThrough(only, platform, target, body, undefined);
  }

  /** The shared body of `sendTo` / `sendAsBot`: dedup, media mapping, send. */
  async sendThrough(
    adapter: PlatformAdapter,
    platform: string,
    target: string,
    body: string,
    media: unknown,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      // Route through outbound dedup — same path as normal responses.
      // Use target as the session key for dedup so repeated sends to the
      // same target with same content are suppressed within TTL. No ledger
      // stands behind this send, so the check is a RESERVATION: `reserve`
      // arms the key now (a second identical send while this one is in
      // flight is a duplicate — V-GC-1), `record` commits it once the
      // platform confirms, and `release` un-arms it on failure so a retry
      // inside the TTL goes out instead of being reported as sent (UBP-003).
      // A duplicate that arrives while the first is in flight shares that
      // send's outcome (`inFlightSends`). Both are owned (V2-RT-4): a send
      // that outlived the TTL commits, releases and clears only its own
      // reservation and flight, never those of the identical send that went
      // out after the TTL. Pinned by `__tests__/dedup-send-retry.test.ts`.
      const dedupKey = `outbound:${platform}:${target}`;
      const flightKey = `${dedupKey}\u0000${body}`;
      const reservation = this.deps.outboundDedup.reserve(dedupKey, body);
      if (!reservation) {
        // Silently deduplicated — against a send still in flight, its outcome.
        return (await this.deps.inFlightSends.get(flightKey)) ?? { ok: true };
      }
      const flight = this.sendReserved(
        adapter,
        platform,
        target,
        body,
        media,
        dedupKey,
        reservation,
      );
      this.deps.inFlightSends.set(flightKey, flight);
      try {
        return await flight;
      } finally {
        if (this.deps.inFlightSends.get(flightKey) === flight)
          this.deps.inFlightSends.delete(flightKey);
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** `sendThrough`'s platform call, holding a dedup reservation it commits on
   *  a confirmed send and releases otherwise (V-GC-1). */
  async sendReserved(
    adapter: PlatformAdapter,
    platform: string,
    target: string,
    body: string,
    media: unknown,
    dedupKey: string,
    reservation: symbol,
  ): Promise<{ ok: boolean; error?: string }> {
    let confirmed = false;
    try {
      // W3.2 — outbound media convention. Map a recognized `structured`
      // payload to native attachments when the adapter's caps allow;
      // otherwise degrade to the text body (nothing attached).
      const attachments =
        media !== undefined
          ? attachmentsFromStructured(
              media,
              this.outboundMediaCaps(adapter),
              OUTBOUND_MEDIA_MAX_BYTES,
              (rejectedPath) =>
                this.deps.observability?.recordSafetyBlock({
                  code: 'gateway.media_path_rejected',
                  cause: 'rejected unsafe path-based media source (traversal or symlink)',
                  details: { platform, path: rejectedPath },
                }),
            )
          : [];
      const result = await adapter.send(target, {
        text: body,
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      if (!result.ok) {
        return { ok: false, error: result.error ?? 'Adapter send failed' };
      }
      confirmed = true;
      this.deps.outboundDedup.record(dedupKey, body, undefined, reservation);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      if (!confirmed) this.deps.outboundDedup.release(dedupKey, body, undefined, reservation);
    }
  }

  /**
   * Outbound media capabilities for an adapter (W3.2). Prefers the v2
   * `ChannelCapabilities.media` manifest when present; otherwise falls back to
   * the legacy `canSendFiles` boolean, which gates both images and files.
   */
  outboundMediaCaps(adapter: PlatformAdapter): OutboundMediaCaps {
    const media = adapter.caps?.media;
    if (media) return { imagesOut: media.imagesOut, filesOut: media.filesOut };
    return { imagesOut: adapter.canSendFiles, filesOut: adapter.canSendFiles };
  }
}
