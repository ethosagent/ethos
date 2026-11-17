// `ethos gateway start` — voice-out derivation, the optional telephony media
// binding, and the channel / per-bot speaker rosters the outbound-policy gate
// reads. Split out of gateway.ts, which re-exports everything here.

import {
  type BotBinding,
  bindResolvesToPersonality,
  deriveBotKey,
  type EthosConfig,
} from '@ethosagent/config';
import { ConsoleLogger } from '@ethosagent/logger';
import type { LiveKitBindings } from '@ethosagent/wiring';
import { resolveLiveKitMedia } from '../livekit-media';
import { loadTeamManifest } from '../wiring';
import { c } from './_shared';
import { whatsAppBotKey } from './gateway-bots';

/**
 * `voice.channels.<platform>.ttsOut` → the Gateway's `channelVoiceOut` gate.
 *
 * Only an EXPLICIT boolean is an operator decision. A platform whose entry
 * omits `ttsOut` inherits the lane's mode, so it must NOT appear in the map —
 * an entry present with `undefined` would read as "declared" downstream.
 * Returns `undefined` when nothing was declared, so the option is omitted
 * entirely rather than passed as an empty object.
 */
export function deriveChannelVoiceOut(
  channels: Readonly<Record<string, { ttsOut?: boolean }>> | undefined,
): Record<string, boolean> | undefined {
  if (!channels) return undefined;
  const out: Record<string, boolean> = {};
  for (const [platform, entry] of Object.entries(channels)) {
    if (typeof entry?.ttsOut === 'boolean') out[platform] = entry.ttsOut;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** What {@link resolveTelephonyMedia} decided, plus the banner lines saying so. */
export interface TelephonyMediaOutcome {
  /** Forwarded to `createAgentLoop` → `buildVoiceStack`. Absent = no media path. */
  livekit?: LiveKitBindings;
  /** Startup-banner lines, already coloured. Empty when nothing was configured. */
  lines: string[];
}

/**
 * Resolve the native LiveKit media binding for this deployment, ONCE at startup.
 *
 * Gated on config, not attempted unconditionally: `resolveLiveKitMedia()` does a
 * dynamic import of a native package, and a deployment with no `voice.trunk` and
 * no `voice.livekit` has no reason to pay for it or to hear about it.
 *
 * When telephony IS configured and the media SDK is not usable, this says so in
 * plain words at boot. That is the whole point of the gate: without it, an
 * operator who rented a phone number learns that calls cannot carry audio from a
 * `failed` row in `calls.db` after a real person rang and got silence.
 */
export async function resolveTelephonyMedia(
  voice: EthosConfig['voice'],
  opts: { importModule?: (specifier: string) => Promise<unknown> } = {},
): Promise<TelephonyMediaOutcome> {
  if (!voice?.trunk && !voice?.livekit) return { lines: [] };

  const media = await resolveLiveKitMedia({
    ...(opts.importModule ? { importModule: opts.importModule } : {}),
    onError: (message) => new ConsoleLogger().warn(message),
  });

  if (media.ok) {
    const version = media.version ? ` ${media.version}` : '';
    return {
      livekit: { createClient: media.createClient },
      lines: [
        `  ${c.green}✓${c.reset} voice media: ${c.cyan}@livekit/rtc-node${version}${c.reset} ${c.dim}— calls can carry audio.${c.reset}`,
      ],
    };
  }

  const lines = [
    `${c.yellow}⚠ voice media unavailable${c.reset} ${c.dim}(${media.reason})${c.reset}`,
  ];
  if (voice.trunk) {
    lines.push(
      `${c.dim}  A call will be answered, screened and logged, but ${c.reset}${c.bold}cannot carry audio${c.reset}${c.dim} until the media SDK loads. Fix: ${c.reset}${c.cyan}pnpm add @livekit/rtc-node${c.reset}${c.dim}, then restart the gateway.${c.reset}`,
    );
  }
  return { lines };
}

/**
 * "Does any configured bot on `platform` still speak for `personalityId`?"
 *
 * Cron delivery to a channel origin is gated on this: `Gateway.sendTo` resolves
 * an adapter by platform alone, so without the check a job whose bot was
 * removed from config would silently deliver through some other agent's bot.
 * The binding predicate itself lives in `@ethosagent/config` so this and the
 * web API's delivery-target resolver cannot drift apart.
 *
 * Exported for `ethos boot`, which runs the same gateway role through the same
 * `createCronDeliver` (apps/ethos/src/lib/cron-deliver.ts) and must gate on the
 * same answer — a second copy of this is what B-T5 removed.
 */
export function buildChannelSpeakers(
  config: EthosConfig,
): (platform: string, id: string) => boolean {
  const speakers = buildBotSpeakers(config);
  return (platform, id) => speakers.candidates(platform, id).length > 0;
}

/**
 * The same binding question, answered at BOT granularity (O-T4/O-T5,
 * plan/phases/trust-before-reach.md).
 *
 * `buildChannelSpeakers` above asks "does ANY bot on this platform speak for
 * this personality", which is the right question for a send addressed at a
 * platform. Two sends are not addressed at a platform:
 *
 *  - a PUBLICATION names the exact bot that will speak, because a human
 *    approved a card with that bot's name on it. `speaksFor` is what
 *    `GatewayConfig.publicationSpeaksFor` is wired to, so a bot rebound since
 *    the approval voids it instead of publishing in a voice nobody approved.
 *  - a PROPOSAL has to pick that bot in the first place. `candidates` is the
 *    input to `resolveSender` (`../lib/outbox-wiring`), which refuses rather
 *    than guessing when there is more than one and the turn names none.
 *
 * ONE roster for both, and for `buildChannelSpeakers`, which is now a
 * non-empty-candidates test over it: three derivations of "which bots are
 * bound to whom" is three chances to disagree.
 *
 * The botKeys are derived exactly as the adapters' are — `deriveBotKey` for
 * telegram/slack, `whatsAppBotKey` for WhatsApp — so a key here is a key the
 * Gateway's routing table actually holds. Discord and Email are absent for the
 * same reason they are absent from `buildChannelSpeakers`: neither carries a
 * per-bot binding, so neither can answer the question.
 */
export interface BotSpeakers {
  /** The botKeys on `platform` bound to `personalityId`, directly or through a
   *  team manifest. Empty means no configured bot can speak for it. */
  candidates(platform: string, personalityId: string): string[];
  /** Does this exact bot still speak for `personalityId`? */
  speaksFor(botKey: string, personalityId: string): boolean;
}

export function buildBotSpeakers(config: EthosConfig): BotSpeakers {
  const bots: Array<{ botKey: string; platform: string; bind: BotBinding }> = [
    ...(config.telegram?.bots ?? []).map((b) => ({
      botKey: deriveBotKey(b),
      platform: 'telegram',
      bind: b.bind,
    })),
    ...(config.slack?.apps ?? []).map((a) => ({
      botKey: deriveBotKey(a),
      platform: 'slack',
      bind: a.bind,
    })),
    // A bind-less WhatsApp entry is excluded, not defaulted: it answers as the
    // default personality at runtime, but nothing in config says it speaks FOR
    // that personality, and a publication is not a thing to infer.
    ...(config.whatsapp ?? []).flatMap((w) =>
      w.bind ? [{ botKey: whatsAppBotKey(w), platform: 'whatsapp', bind: w.bind }] : [],
    ),
  ];
  const memberCache = new Map<string, readonly string[]>();
  const members = (team: string): readonly string[] => {
    const hit = memberCache.get(team);
    if (hit) return hit;
    let loaded: readonly string[] = [];
    try {
      loaded = loadTeamManifest(team).members.map((m) => m.personality);
    } catch {
      // No manifest (or an unparseable one) resolves to no members rather
      // than to everyone.
    }
    memberCache.set(team, loaded);
    return loaded;
  };
  const bound = (bot: { bind: BotBinding }, id: string): boolean =>
    bindResolvesToPersonality(bot.bind, id, members);
  return {
    candidates: (platform, id) =>
      bots.filter((b) => b.platform === platform && bound(b, id)).map((b) => b.botKey),
    speaksFor: (botKey, id) => bots.some((b) => b.botKey === botKey && bound(b, id)),
  };
}
