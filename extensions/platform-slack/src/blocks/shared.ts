// Pure Block Kit builders. Blocks are JSON; the Slack web client validates
// at runtime. We use a minimal structural type so this package doesn't take
// a direct `@slack/types` dependency.

export interface SlackBlock {
  type: string;
  block_id?: string;
  [key: string]: unknown;
}

export function divider(): SlackBlock {
  return { type: 'divider' };
}

export function section(text: string): SlackBlock {
  return {
    type: 'section',
    text: { type: 'mrkdwn', text },
  };
}

export function header(text: string): SlackBlock {
  return {
    type: 'header',
    text: { type: 'plain_text', text, emoji: true },
  };
}

export function context(elements: string[]): SlackBlock {
  return {
    type: 'context',
    elements: elements.map((text) => ({ type: 'mrkdwn', text })),
  };
}

/**
 * A `section` rendered as a two-column key/value grid via Slack's `fields`
 * array. Slack lays the fields out in two columns, top-to-bottom; pass
 * pre-formatted mrkdwn strings (caller owns escaping). Slack caps `fields`
 * at 10 entries — callers stay well under that.
 */
export function sectionFields(fields: string[]): SlackBlock {
  return {
    type: 'section',
    fields: fields.map((text) => ({ type: 'mrkdwn', text })),
  };
}

/**
 * Escape the three characters Slack mrkdwn treats as markup delimiters. Any
 * string interpolated into a block that is model/config/user-influenced — tool
 * names, session labels, channel names, memory entries, ticket titles — must
 * pass through this first; an unescaped `<@U…>` or `<http…|text>` would inject
 * a live mention or link onto an Ethos surface.
 */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Cap a single field's length so it can't blow past Slack's per-block text
 * limit (~3000 chars for a `section`). When the text is over `max`, it's cut
 * to `max` characters and an ellipsis is appended so the UI stays honest —
 * same spirit as the `approval.ts` args-preview cap. Callers pick `max` per
 * field; this helper is deliberately content-agnostic (no whitespace
 * normalization) so it composes with `escapeMrkdwn` and link wrapping.
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/** Plaintext fallback rendered into the message `text` field — Slack uses
 *  this for notifications, screen-readers, and clients that don't render
 *  Block Kit. We pass the mrkdwn through unchanged: Slack strips it
 *  client-side for notifications, and pre-stripping here mangles identifiers
 *  like `thread_follow` (the underscores would be eaten as italic markers). */
export function plaintextFallback(blocks: SlackBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'header' || block.type === 'section') {
      const t = block.text as { text?: string } | undefined;
      if (t?.text) parts.push(t.text);
    } else if (block.type === 'context') {
      const els = (block.elements as Array<{ text?: string }> | undefined) ?? [];
      for (const el of els) {
        if (el.text) parts.push(el.text);
      }
    }
  }
  return parts.join('\n');
}
