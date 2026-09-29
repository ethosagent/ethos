/**
 * Who a channel bot speaks as in one chat (plan
 * personality-presence-and-initiative §3): the personality bound to that lane
 * right now — after any `/personality` switch — and its `display.emoji`.
 *
 * The gateway owns the answer (`Gateway.presenceFor`, extensions/gateway); an
 * adapter that wants it for its receipt reaction or its mention-by-name check
 * exposes `setPresenceResolver`, which the gateway calls when it registers the
 * adapter. A structural hook, deliberately NOT a `PlatformAdapter` field.
 */
export interface ChannelPresence {
  /** The bound personality's display name (its id when no name is known). */
  name: string;
  /** The bound personality's `display.emoji`, when it has one. */
  emoji?: string;
}

/** Resolves the presence for one chat (and thread) of the adapter's own bot. */
export type ChannelPresenceResolver = (
  chatId: string,
  threadId?: string,
) => ChannelPresence | undefined;

/**
 * Does `text` name `name` as a whole word? Case-insensitive, with every regex
 * metacharacter in the name escaped, and a "word" boundary that counts any
 * Unicode letter, combining mark or digit (or `_`) as part of a word — `\b` is
 * ASCII-only, so it would let "Émilee" match "Émile", and without `\p{M}` a
 * decomposed "José" (`e` + U+0301) would match "Jose". Both sides are NFC
 * normalized first, so a composed and a decomposed spelling are the same name.
 * A blank name never matches. Pinned by `__tests__/channel-presence.test.ts`.
 *
 * Used by the Telegram, Slack and Discord adapters for `mentionByName`: a
 * match sets `InboundMessage.isGroupMention`, and the channel filter is
 * unchanged.
 */
export function mentionsPersonalityName(text: string, name: string): boolean {
  const trimmed = name.normalize('NFC').trim();
  if (!trimmed) return false;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])${escaped}(?![\\p{L}\\p{M}\\p{N}_])`, 'iu').test(
    text.normalize('NFC'),
  );
}
