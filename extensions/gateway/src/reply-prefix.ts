import type { ChannelPresence } from '@ethosagent/core';

// ---------------------------------------------------------------------------
// Reply prefix (plan personality-presence-and-initiative §3)
//
// An operator SETTING per bot (`telegram.bots.N.replyPrefix`,
// `slack.apps.N.replyPrefix`, `discord.replyPrefix`), not a PersonalityConfig
// field: label templates belong to the operator (CLAUDE.md "What does NOT
// belong on PersonalityConfig"). It reads the bound personality's identity.
//
// The prefix is part of the reply's CONTENT. The gateway applies it BEFORE
// `MessageDedupCache.shouldSend` and before the delivery ledger writes its
// `pending` row, so the dedup key, the ledger row and a sweep redelivery all
// carry the same bytes — and a redelivery sends the stored row as-is
// (`Gateway.sweepDeliveriesOnce` never calls this), so nothing is prefixed
// twice. Adapters never add it. Pinned by `__tests__/reply-prefix.test.ts`.
// ---------------------------------------------------------------------------

const PLACEHOLDER = /(\{name\}|\{emoji\})/;

/**
 * A reply that OPENS with a markdown block construct: an ATX heading, a `-`,
 * `*` or `+` list item, a block quote, an ordered list item, or a ``` / ~~~
 * fence. An inline prefix in front of one turns it into paragraph text
 * (`[Owl] # Heading` is not a heading), so the prefix goes on its own line.
 * The markers need their CommonMark trailing space, so `#hashtag`, `*bold*`
 * and `-5` stay inline.
 */
const LEADING_BLOCK = /^(?:#{1,6}(?:[ \t]|$)|[-*+][ \t]|>|\d{1,9}[.)](?:[ \t]|$)|```|~~~)/;

/**
 * `text` with the bot's reply-prefix template rendered in front of it.
 *
 * The only placeholders are `{name}` (the bound personality's name) and
 * `{emoji}` (its `display.emoji`). A placeholder with no value is removed
 * together with ONE adjacent space — the one after it, else the one before —
 * so `"{emoji} {name}: "` with no emoji renders `"Owl: "`, never `" Owl: "`.
 * Values are inserted verbatim and never re-scanned for placeholders.
 *
 * When `text` opens with a markdown block construct (`LEADING_BLOCK`), the
 * rendered prefix is trimmed and put on its own line instead. A pure function
 * of its inputs, so the same reply always renders the same bytes for dedup
 * and the delivery ledger.
 *
 * No template, or an empty `text`, returns `text` unchanged — the
 * byte-identical guarantee for a bot with no `replyPrefix`.
 */
export function applyReplyPrefix(
  text: string,
  template: string | undefined,
  presence: ChannelPresence | undefined,
): string {
  if (!template || text.length === 0) return text;
  const parts = template.split(PLACEHOLDER);
  const values: Record<string, string> = {
    '{name}': presence?.name ?? '',
    '{emoji}': presence?.emoji ?? '',
  };
  // `split` with a capturing group alternates literal, placeholder, literal…
  // so every odd index is a placeholder.
  for (let i = 1; i < parts.length; i += 2) {
    const value = values[parts[i] ?? ''] ?? '';
    parts[i] = value;
    if (value) continue;
    const after = parts[i + 1] ?? '';
    const before = parts[i - 1] ?? '';
    if (after.startsWith(' ')) parts[i + 1] = after.slice(1);
    else if (before.endsWith(' ')) parts[i - 1] = before.slice(0, -1);
  }
  const prefix = parts.join('');
  if (LEADING_BLOCK.test(text)) {
    const own = prefix.trim();
    return own ? `${own}\n${text}` : text;
  }
  return `${prefix}${text}`;
}
