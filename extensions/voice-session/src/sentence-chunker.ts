// Incremental sentence chunker. Fed `text_delta` strings as the LLM streams,
// it flushes complete sentences as soon as a boundary is seen and buffers the
// trailing partial. Generalizes `truncateAtSentenceBoundary` from the gateway
// voice-pipeline (reimplemented here — no cross-extension dependency).

// A small set of common abbreviations whose trailing period is NOT a sentence
// boundary. Minimal by design (the brief asks for "minimally-reasonable"); an
// abbreviation not listed here will over-split, which is acceptable for voice.
const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'vs',
  'etc',
  'no',
  'inc',
  'ltd',
  'co',
]);

export class SentenceChunker {
  private buffer = '';

  /**
   * Append a streamed text delta. Returns every complete sentence that became
   * available (in order). Partial trailing text is retained for the next push
   * or `flush()`.
   */
  push(delta: string): string[] {
    this.buffer += delta;
    const sentences: string[] = [];
    while (true) {
      const boundary = this.findBoundary(this.buffer);
      if (boundary < 0) break;
      const sentence = this.buffer.slice(0, boundary).trim();
      if (sentence.length > 0) sentences.push(sentence);
      // Drop the consumed sentence plus any whitespace before the next one.
      this.buffer = this.buffer.slice(boundary).replace(/^\s+/, '');
    }
    return sentences;
  }

  /** Emit any buffered remainder as a final sentence. Returns null if empty. */
  flush(): string | null {
    const remainder = this.buffer.trim();
    this.buffer = '';
    return remainder.length > 0 ? remainder : null;
  }

  /**
   * Index just past a completed sentence, or -1 if none. A boundary is a run
   * of `.`/`!`/`?` followed by whitespace (end-of-buffer is ambiguous while
   * streaming, so it is NOT treated as a boundary until `flush`). A terminating
   * period immediately after a known abbreviation is skipped.
   */
  private findBoundary(text: string): number {
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c !== '.' && c !== '!' && c !== '?') continue;
      // Consume the terminator run.
      let j = i;
      while (j < text.length && (text[j] === '.' || text[j] === '!' || text[j] === '?')) j++;
      // Require trailing whitespace to confirm the sentence completed.
      if (j < text.length && /\s/.test(text[j] ?? '')) {
        if (!SentenceChunker.endsWithAbbreviation(text.slice(0, i))) {
          return j;
        }
      }
      i = j - 1; // skip the rest of the run
    }
    return -1;
  }

  private static endsWithAbbreviation(before: string): boolean {
    const match = /([A-Za-z]+)$/.exec(before);
    if (!match) return false;
    const word = match[1];
    if (!word) return false;
    return ABBREVIATIONS.has(word.toLowerCase());
  }
}
