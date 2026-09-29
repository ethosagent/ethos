// plan personality-presence-and-initiative §2 — the chat header's personality
// label. `display.emoji` (already validated by the loader, `buildDisplayConfig`
// in @ethosagent/personalities) sits beside the name; unset, the label is the
// bare name, so a personality without one looks exactly as it did.

import type { PersonalityConfig } from '@ethosagent/types';

/**
 * `displayName` is `ActiveLoop.displayName` (apps/ethos/src/wiring.ts): the
 * personality id, or `team:<name>` for a team — which no registry resolves, so
 * a team never borrows its coordinator's emoji.
 */
export function chatPersonalityLabel(
  displayName: string,
  personalities: { get(id: string): PersonalityConfig | undefined },
): string {
  const emoji = personalities.get(displayName)?.display?.emoji;
  return emoji ? `${emoji} ${displayName}` : displayName;
}
