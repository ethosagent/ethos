// reference_preserving — keep messages that contain file paths, function
// references, or structured data; drop verbose prose between them. Useful
// for engineer / refactor flows where code-context references matter more
// than the running commentary that surrounds them.
import { estimateMessagesTokens, estimateMessageTokens } from './token-estimator';

const REFERENCE_PATTERN =
  /[A-Za-z_][\w./-]*\.(?:ts|tsx|js|jsx|py|go|rs|java|md|yaml|yml|json)\b|\b[A-Z][A-Za-z0-9]+(?:\.[A-Za-z0-9_]+)+\b/;
function messageText(content) {
  if (typeof content === 'string') return content;
  return content
    .map((b) => {
      if (b.type === 'text') return b.text;
      if (b.type === 'tool_result') return b.content;
      if (b.type === 'tool_use') return `${b.name} ${JSON.stringify(b.input)}`;
      return '';
    })
    .join(' ');
}
function carriesReference(message) {
  return REFERENCE_PATTERN.test(messageText(message.content));
}
export class ReferencePreservingEngine {
  name = 'reference_preserving';
  async compact(opts) {
    const target = opts.targetTokens;
    const systemTokens = estimateMessagesTokens(opts.currentSystem);
    // Always keep the last 4 messages — losing fresh context defeats the
    // point of compaction when the user just spoke.
    const tailKeep = Math.min(4, opts.messages.length);
    const head = opts.messages.slice(0, opts.messages.length - tailKeep);
    const tail = opts.messages.slice(opts.messages.length - tailKeep);
    let total = systemTokens + estimateMessagesTokens([...head, ...tail]);
    // First pass: drop prose-only messages from the head until we fit.
    const kept = [];
    let droppedProse = 0;
    for (const m of head) {
      if (total <= target) {
        kept.push(m);
        continue;
      }
      if (carriesReference(m)) {
        kept.push(m);
      } else {
        total -= estimateMessageTokens(m);
        droppedProse++;
      }
    }
    // Second pass: if still over budget, drop the oldest reference-bearing
    // messages too. Recent code-context wins over ancient code-context.
    while (total > target && kept.length > 0) {
      const removed = kept.shift();
      if (!removed) break;
      total -= estimateMessageTokens(removed);
    }
    const note =
      droppedProse > 0
        ? `dropped ${droppedProse} prose message(s); kept ${kept.length} reference-bearing`
        : 'no prose messages to drop';
    return { messages: [...kept, ...tail], notes: note };
  }
}
