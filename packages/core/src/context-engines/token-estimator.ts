// Cheap token estimator — char-count / 4. Used by the context engines to
// decide when to compact. Anthropic and OpenAI tokenizers are not available
// at compaction time without a network round-trip, and 4 chars/token is the
// industry rule of thumb that's close enough for budget gates.

import type { Message, MessageContent } from '@ethosagent/types';

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function messageContentChars(content: string | MessageContent[]): number {
  if (typeof content === 'string') return content.length;
  let total = 0;
  for (const block of content) {
    if (block.type === 'text') total += block.text.length;
    else if (block.type === 'tool_use')
      total += JSON.stringify(block.input).length + block.name.length;
    else if (block.type === 'tool_result') total += block.content.length;
    // Note: 'image' / 'document' MessageContent variants are intentionally
    // unhandled here. They are ephemeral — produced and consumed inside a
    // single one-shot tool call (e.g. vision_analyze's internal
    // provider.complete()), and never persisted onto the main-loop session
    // history. If a future feature ever places image/document blocks onto a
    // Message that flows through compaction, this estimator must be extended
    // (image: ~1.6k tokens per Anthropic; document: per-page) — silently
    // counting their base64 length as zero would be wrong, and counting it
    // as data.length would over-count by ~4x. Be deliberate at that point.
  }
  return total;
}

export function estimateMessageTokens(message: Message): number {
  return Math.ceil(messageContentChars(message.content) / CHARS_PER_TOKEN);
}

export function estimateMessagesTokens(input: Message | Message[] | string): number {
  if (typeof input === 'string') return estimateTokens(input);
  if (Array.isArray(input)) {
    let total = 0;
    for (const m of input) total += estimateMessageTokens(m);
    return total;
  }
  return estimateMessageTokens(input);
}

/**
 * Raw character count for the same content `estimateMessagesTokens` measures,
 * WITHOUT the char/4 divide or per-message rounding. Used only by the
 * compaction gate's per-model `charsPerToken` path so it can divide the true
 * char total by the model's tokenizer ratio. The token estimators above stay
 * the exact char/4 gate used everywhere else.
 */
export function estimateMessagesChars(input: Message | Message[] | string): number {
  if (typeof input === 'string') return input.length;
  if (Array.isArray(input)) {
    let total = 0;
    for (const m of input) total += messageContentChars(m.content);
    return total;
  }
  return messageContentChars(input.content);
}
