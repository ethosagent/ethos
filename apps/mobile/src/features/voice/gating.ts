// When the composer offers a call (§3, T7). Three conditions, all required:
//
// - the key holds `voice:talk` (`meta.whoami`, S12) — a key minted before
//   Phase 3 lacks it, and voice is then absent rather than broken;
// - the personality can talk — the web's gate, mirrored rather than imported
//   (`apps/web/src/features/voice/gating.ts`: the `voice_session` toolset
//   entry; a toolset still loading reads as not capable);
// - the app is not running in Expo Go, which does not carry the native audio
//   library the call engine loads.

/** Toolset entry that gates a live call — the web's `VOICE_CAPABILITY`. */
export const VOICE_CAPABILITY = 'voice_session';

export const VOICE_SCOPE = 'voice:talk';

/** Expo Go's `Constants.executionEnvironment`. */
export const EXPO_GO_ENVIRONMENT = 'storeClient';

/** The web's `personalityCanTalk`. */
export function personalityCanTalk(toolset: readonly string[] | null | undefined): boolean {
  return Array.isArray(toolset) && toolset.includes(VOICE_CAPABILITY);
}

export function callAvailable(input: {
  /** `whoami.key.scopes`; null while whoami is loading or for a cookie session. */
  scopes: readonly string[] | null | undefined;
  toolset: readonly string[] | null | undefined;
  executionEnvironment: string | null | undefined;
}): boolean {
  if (input.executionEnvironment === EXPO_GO_ENVIRONMENT) return false;
  if (!input.scopes?.includes(VOICE_SCOPE)) return false;
  return personalityCanTalk(input.toolset);
}
