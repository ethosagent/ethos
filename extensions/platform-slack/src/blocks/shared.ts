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
