// Inbound SIP dispatch — resolve an inbound call's dialed number to the bound
// voice bot, then build the EXISTING VoiceChannelAdapter stack for it
// (plan/phases/gap-voice-realtime.md §4 Phase C, §3(b)).
//
// The dialed DID (`call.toNumber`) selects WHICH bot/personality answers by
// matching against the `voice.bots[]` patterns — no separate number->personality
// mapping structure, the bot `match` IS that mapping. The caller's number
// (`call.fromNumber`) becomes the adapter's `callerId`, so the lane key
// `voice:<botKey>:<callerId>` gives a repeat caller their own session and, via
// the normal SessionStore path, cross-call memory for free.
//
// This seam owns NO transport/LLM wiring: it matches, then delegates
// construction to an injected `buildAdapter`, exactly as `createLiveKitTransport`
// keeps provider wiring at the app layer.

import type { VoiceBotIdentity, VoiceChannelAdapter } from '../adapter';
import type { InboundSipCall } from './trunk-client';

/**
 * Match a number/room value against a `voice.bots[]` `match` pattern. `*` is a
 * wildcard (any run of characters); every other character is literal. Anchored
 * full-string match. Mirrors the E.164/room patterns the config already uses
 * (`+15551234567`, `+1555*`, `room-support-*`).
 */
export function matchesVoicePattern(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === '*' ? '.*' : `\\${ch}`));
  return new RegExp(`^${escaped}$`).test(value);
}

/**
 * First bot (in config order) whose `match` pattern matches `value`, or `null`
 * when none does. Ordered so a specific exact number can precede a broad
 * wildcard.
 */
export function resolveVoiceBot(
  value: string,
  bots: readonly VoiceBotIdentity[],
): VoiceBotIdentity | null {
  for (const bot of bots) {
    if (matchesVoicePattern(value, bot.match)) return bot;
  }
  return null;
}

export interface InboundDispatchDeps {
  /** Bots that answer inbound numbers — `voice.bots[]` mapped to identities. */
  bots: readonly VoiceBotIdentity[];
  /**
   * Builds a ready (un-started) adapter for a matched inbound call. In
   * production this composes a LiveKitVoiceTransport (joining `call.roomName`,
   * `callerId` = `call.fromNumber`) -> VoiceChannelAdapter -> VoiceSession for
   * the matched bot's bound personality. Injected so this seam stays pure.
   */
  buildAdapter: (bot: VoiceBotIdentity, call: InboundSipCall) => VoiceChannelAdapter;
}

/**
 * Returns a dispatcher: call it with an inbound SIP call to get the (un-started)
 * VoiceChannelAdapter for the bound bot, or `null` when the dialed number
 * matches no bot. Call `adapter.start()` to connect.
 */
export function createInboundDispatcher(
  deps: InboundDispatchDeps,
): (call: InboundSipCall) => VoiceChannelAdapter | null {
  return (call: InboundSipCall): VoiceChannelAdapter | null => {
    const bot = resolveVoiceBot(call.toNumber, deps.bots);
    if (!bot) return null;
    return deps.buildAdapter(bot, call);
  };
}
