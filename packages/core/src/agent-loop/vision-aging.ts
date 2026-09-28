import type { Message, MessageContent } from '@ethosagent/types';

/**
 * C3 — block aging.
 *
 * Images are the most token-expensive thing in a history and the least likely
 * to matter three turns later, so past a recency window they are replaced with
 * a line naming what was there. Same family as
 * {@link ./tool-result-aging}, with one deliberate difference: tool-result
 * aging fires on token PRESSURE, this fires on RECENCY alone. A 40-turn
 * session that never approaches the window would otherwise re-send every
 * screenshot on every request forever.
 *
 * Aging happens at prompt build and never mutates stored messages — the
 * session keeps the blocks so a fork or replay still has them, exactly as
 * tool-result aging does.
 */

/**
 * Assistant turns of history that keep their image/document blocks. Older user
 * turns degrade to text. Four is one more than tool-result aging's window: an
 * image is likelier than a tool result to be the subject of a follow-up
 * question ("what about the second error?").
 */
export const KEEP_RECENT_VISION_TURNS = 4;

type VisionBlock = Extract<MessageContent, { type: 'image' | 'document' }>;

/** Why a block is not sent; each has its own placeholder line. */
type DegradeReason = 'aged' | 'unanswered' | 'unreadable';

/** The text a block degrades to. */
function placeholder(block: VisionBlock, reason: DegradeReason): string {
  const kind = block.type === 'document' ? 'document' : 'image';
  const name = block.filename ? `: ${block.filename}` : '';
  if (reason === 'unanswered') {
    return `[${kind} not resent${name} — the turn it came with got no reply]`;
  }
  if (reason === 'unreadable') return `[${kind} not sent${name} — this model cannot read ${kind}s]`;
  return `[${kind} aged out${name}]`;
}

function isVisionBlock(block: MessageContent): block is VisionBlock {
  return block.type === 'image' || block.type === 'document';
}

export interface AgeVisionOptions {
  /**
   * UBP-019 — what the CURRENT turn's model can read (the `nativeVision` gate
   * in stages/context-assembly.ts). A replayed block of a kind it cannot read
   * degrades to a line naming it, however recent: a tier or personality switch
   * onto a text-only model must not receive the image an earlier turn sent.
   * Absent → no capability gate (callers that do not know the model).
   */
  vision?: { images: boolean; documents: boolean };
}

/**
 * Replace image/document blocks with placeholder text when:
 *   - they are older than `keepRecentTurns` assistant turns (C3, recency);
 *   - their message got no reply — another user message follows it with no
 *     assistant message between (UBP-019). The user row persists its blocks
 *     before the call, and a turn the provider rejected writes no assistant
 *     row, so without this the block never ages and every later turn resends
 *     it and fails the same way. The cost: an image from a turn that died for
 *     another reason (an abort, a crash) is named, not resent;
 *   - `opts.vision` says the current model cannot read that kind.
 *
 * Returns the input array unchanged when nothing degraded, so an ordinary
 * text-only session pays one pass and no allocation. Pinned by
 * __tests__/vision-replay-rejected.test.ts.
 */
export function ageVisionBlocks(
  messages: Message[],
  keepRecentTurns: number = KEEP_RECENT_VISION_TURNS,
  opts: AgeVisionOptions = {},
): Message[] {
  // Walk backward counting assistant turns; everything beyond the window is
  // old. Counting backward rather than forward means the window is measured
  // from the CURRENT turn, which is what "recent" has to mean when history is
  // also being truncated from the head.
  let assistantTurns = 0;
  // A user message was seen after this point with no assistant message since.
  let laterUnansweredUser = false;
  let agedAny = false;
  const out: Message[] = new Array(messages.length);
  const vision = opts.vision;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;

    if (msg.role === 'assistant') {
      assistantTurns++;
      laterUnansweredUser = false;
    }
    const unanswered = msg.role === 'user' && laterUnansweredUser;
    if (msg.role === 'user') laterUnansweredUser = true;

    if (!Array.isArray(msg.content) || !msg.content.some(isVisionBlock)) {
      out[i] = msg;
      continue;
    }
    const aged = assistantTurns > keepRecentTurns;
    const reasonFor = (block: VisionBlock): DegradeReason | undefined => {
      if (aged) return 'aged';
      if (unanswered) return 'unanswered';
      if (vision && !(block.type === 'document' ? vision.documents : vision.images)) {
        return 'unreadable';
      }
      return undefined;
    };
    if (!msg.content.some((b) => isVisionBlock(b) && reasonFor(b) !== undefined)) {
      out[i] = msg;
      continue;
    }

    // Collapse each vision block to text in place, preserving block order so
    // the surrounding text blocks keep their relationship to it.
    const content: MessageContent[] = msg.content.map((block) => {
      const reason = isVisionBlock(block) ? reasonFor(block) : undefined;
      return isVisionBlock(block) && reason
        ? { type: 'text', text: placeholder(block, reason) }
        : block;
    });
    out[i] = { ...msg, content };
    agedAny = true;
  }

  return agedAny ? out : messages;
}

/**
 * Flatten vision blocks to their placeholder text for a compaction summarizer.
 *
 * The summarizer is a separate model call whose only job is to produce prose;
 * re-sending every image into it doubles the cost of compaction and can exceed
 * the summarizer's own context. It sees what was there, not the pixels.
 */
export function stripVisionBlocksForSummary(messages: Message[]): Message[] {
  return ageVisionBlocks(messages, 0);
}
