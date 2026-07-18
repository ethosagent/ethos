// Caption parser — PURE logic that turns the noisy stream of rolling Meet
// caption fragments into clean, finalized transcript entries. This is the
// §4 "Phase D" check target: fixture-tested against a recorded caption stream.
//
// Meet emits captions as rolling, in-place updates (see RawCaptionFragment).
// The parser's job:
//   1. MERGE rolling partials — every update to an active line replaces the
//      prior text (last-wins per caption block), so only the final line commits.
//   2. ATTRIBUTE speakers — each block carries its scraped speaker.
//   3. DEDUP — Meet re-emits a finalized line verbatim; identical consecutive
//      (speaker, text) entries collapse to one.
// It holds NO IO — it is fed fragments and hands back entries.

import type { RawCaptionFragment } from './meeting-client';

/** One clean, finalized transcript line: a speaker and what they said. */
export interface TranscriptEntry {
  speaker: string;
  text: string;
}

interface Block {
  speaker: string;
  text: string;
}

/**
 * Accumulates rolling caption fragments and yields finalized transcript
 * entries. Insertion order is preserved: blocks commit in the order their
 * caption line first appeared (correct for sequential speakers, and stable for
 * the occasional overlap where two lines are active at once).
 */
export class CaptionParser {
  // Insertion-ordered: blockKey -> latest observed state of that caption line.
  private readonly blocks = new Map<string, Block>();
  // For the no-blockId fallback: a monotonic run index bumped on speaker change
  // so each contiguous same-speaker run becomes its own block.
  private runIndex = 0;
  private lastRunSpeaker: string | null = null;

  /** Feed one scraped caption fragment. Idempotent for repeated identical text. */
  push(fragment: RawCaptionFragment): void {
    const speaker = fragment.speaker.trim();
    const text = fragment.text.trim();
    if (text.length === 0) return;

    const key = this.blockKeyFor(fragment, speaker);
    // Last-wins: rolling updates (and in-place corrections) replace the line.
    this.blocks.set(key, { speaker, text });
  }

  /**
   * The finalized transcript so far: blocks in first-seen order, empties
   * dropped, identical consecutive (speaker, text) pairs deduped.
   */
  transcript(): TranscriptEntry[] {
    const entries: TranscriptEntry[] = [];
    for (const block of this.blocks.values()) {
      const prev = entries[entries.length - 1];
      if (prev && prev.speaker === block.speaker && prev.text === block.text) continue;
      entries.push({ speaker: block.speaker, text: block.text });
    }
    return entries;
  }

  private blockKeyFor(fragment: RawCaptionFragment, speaker: string): string {
    const blockId = fragment.blockId;
    if (blockId !== undefined && blockId.length > 0) return `id:${blockId}`;
    // No stable id: a speaker change starts a new contiguous run.
    if (this.lastRunSpeaker !== null && this.lastRunSpeaker !== speaker) this.runIndex += 1;
    this.lastRunSpeaker = speaker;
    return `run:${this.runIndex}:${speaker}`;
  }
}

/** Convenience: run a full recorded fragment stream through a fresh parser. */
export function parseCaptions(fragments: readonly RawCaptionFragment[]): TranscriptEntry[] {
  const parser = new CaptionParser();
  for (const fragment of fragments) parser.push(fragment);
  return parser.transcript();
}
