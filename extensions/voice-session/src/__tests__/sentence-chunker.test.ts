import { describe, expect, it } from 'vitest';
import { SentenceChunker } from '../sentence-chunker';

describe('SentenceChunker', () => {
  it('flushes a complete sentence on a boundary', () => {
    const c = new SentenceChunker();
    expect(c.push('Hello world. ')).toEqual(['Hello world.']);
  });

  it('assembles a sentence from streamed deltas', () => {
    const c = new SentenceChunker();
    expect(c.push('Hel')).toEqual([]);
    expect(c.push('lo. Wor')).toEqual(['Hello.']);
    expect(c.push('ld! ')).toEqual(['World!']);
  });

  it('does not flush mid-sentence', () => {
    const c = new SentenceChunker();
    expect(c.push('Hello wor')).toEqual([]);
    expect(c.push('ld')).toEqual([]);
  });

  it('does not flush a terminator with no trailing whitespace yet', () => {
    const c = new SentenceChunker();
    // Ambiguous while streaming — could be an abbreviation or number.
    expect(c.push('Ready.')).toEqual([]);
    expect(c.push(' Go!')).toEqual(['Ready.']);
  });

  it('emits multiple sentences from a single push', () => {
    const c = new SentenceChunker();
    expect(c.push('One. Two. Three. ')).toEqual(['One.', 'Two.', 'Three.']);
  });

  it('handles question and exclamation boundaries', () => {
    const c = new SentenceChunker();
    expect(c.push('Really? Yes! ')).toEqual(['Really?', 'Yes!']);
  });

  it('does not split on a known abbreviation', () => {
    const c = new SentenceChunker();
    expect(c.push('Dr. Smith arrived. ')).toEqual(['Dr. Smith arrived.']);
  });

  it('flush() emits the buffered remainder', () => {
    const c = new SentenceChunker();
    expect(c.push('No terminator here')).toEqual([]);
    expect(c.flush()).toBe('No terminator here');
  });

  it('flush() returns null when empty', () => {
    const c = new SentenceChunker();
    c.push('Done. ');
    expect(c.flush()).toBeNull();
  });
});
