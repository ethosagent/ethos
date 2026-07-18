// §3(e) of plan/phases/gap-voice-realtime.md — per-personality voice enablement
// as a personality *capability*, never a PersonalityConfig schema field.
//
// Real-time voice availability rides the `toolset` seam: a personality can open a
// live voice session only when its toolset lists the voice-session capability
// entry. This is the same mechanism that gates every other tool
// (`DefaultToolRegistry.toDefinitions(allowedTools)`), so no frozen schema is
// touched — a personality that omits this entry simply cannot be dialed into a
// live conversation.

/** Toolset entry that gates the `VoiceSession` capability (plan §3(a)/§3(e)). */
export const VOICE_CAPABILITY = 'voice_session';

/**
 * True when the personality's toolset enables real-time voice. `null`/`undefined`
 * (toolset still loading, or not configured) reads as not-capable so the call
 * affordance stays disabled until the toolset resolves.
 */
export function personalityCanTalk(toolset: readonly string[] | null | undefined): boolean {
  return Array.isArray(toolset) && toolset.includes(VOICE_CAPABILITY);
}
