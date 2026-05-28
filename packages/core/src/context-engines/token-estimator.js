// Cheap token estimator — char-count / 4. Used by the context engines to
// decide when to compact. Anthropic and OpenAI tokenizers are not available
// at compaction time without a network round-trip, and 4 chars/token is the
// industry rule of thumb that's close enough for budget gates.
const CHARS_PER_TOKEN = 4;
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
function messageContentChars(content) {
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
export function estimateMessageTokens(message) {
  return Math.ceil(messageContentChars(message.content) / CHARS_PER_TOKEN);
}
export function estimateMessagesTokens(input) {
  if (typeof input === 'string') return estimateTokens(input);
  if (Array.isArray(input)) {
    let total = 0;
    for (const m of input) total += estimateMessageTokens(m);
    return total;
  }
  return estimateMessageTokens(input);
}
