import { describe, expect, it } from 'vitest';
import { CaptionParser, parseCaptions } from '../caption-parser';
import { EXPECTED_TRANSCRIPT, MEET_CAPTION_FRAGMENTS } from './fixtures/meet-captions';

describe('caption parser — recorded Meet fixture', () => {
  it('merges rolling captions into the finalized transcript', () => {
    expect(parseCaptions(MEET_CAPTION_FRAGMENTS)).toEqual(EXPECTED_TRANSCRIPT);
  });

  it('is stable when fed incrementally (streaming push === batch parse)', () => {
    const parser = new CaptionParser();
    for (const fragment of MEET_CAPTION_FRAGMENTS) parser.push(fragment);
    expect(parser.transcript()).toEqual(EXPECTED_TRANSCRIPT);
  });
});

describe('caption parser — merge / dedup / attribution units', () => {
  it('keeps only the last text of a rolling block (last-wins)', () => {
    const out = parseCaptions([
      { speaker: 'A', text: 'hello', blockId: 'x' },
      { speaker: 'A', text: 'hello there', blockId: 'x' },
      { speaker: 'A', text: 'hello there friend', blockId: 'x' },
    ]);
    expect(out).toEqual([{ speaker: 'A', text: 'hello there friend' }]);
  });

  it('collapses a verbatim re-emit of a finalized line', () => {
    const out = parseCaptions([
      { speaker: 'A', text: 'done', blockId: 'x' },
      { speaker: 'A', text: 'done', blockId: 'x' },
    ]);
    expect(out).toEqual([{ speaker: 'A', text: 'done' }]);
  });

  it('drops empty/whitespace-only fragments', () => {
    const out = parseCaptions([
      { speaker: 'A', text: '', blockId: 'x' },
      { speaker: 'A', text: '   ', blockId: 'x' },
    ]);
    expect(out).toEqual([]);
  });

  it('falls back to contiguous same-speaker runs when no blockId is present', () => {
    const out = parseCaptions([
      { speaker: 'A', text: 'one' },
      { speaker: 'A', text: 'one two' },
      { speaker: 'B', text: 'reply' },
      { speaker: 'A', text: 'again' },
    ]);
    expect(out).toEqual([
      { speaker: 'A', text: 'one two' },
      { speaker: 'B', text: 'reply' },
      { speaker: 'A', text: 'again' },
    ]);
  });

  it('preserves first-seen order for overlapping interleaved blocks', () => {
    const out = parseCaptions([
      { speaker: 'A', text: 'a-partial', blockId: '1' },
      { speaker: 'B', text: 'b-partial', blockId: '2' },
      { speaker: 'A', text: 'a-final', blockId: '1' },
      { speaker: 'B', text: 'b-final', blockId: '2' },
    ]);
    expect(out).toEqual([
      { speaker: 'A', text: 'a-final' },
      { speaker: 'B', text: 'b-final' },
    ]);
  });
});
