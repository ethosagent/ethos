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
