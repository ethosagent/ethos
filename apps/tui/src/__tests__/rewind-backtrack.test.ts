import { describe, expect, it } from 'vitest';
import { DOUBLE_ESC_MS, isDoubleEsc, stepBacktrack } from '../rewind-backtrack';

describe('isDoubleEsc', () => {
  it('is false with no earlier Esc', () => {
    expect(isDoubleEsc(null, 1000)).toBe(false);
  });
  it('is true inside the window and false outside it', () => {
    expect(DOUBLE_ESC_MS).toBe(500);
    expect(isDoubleEsc(600, 1000)).toBe(true);
    expect(isDoubleEsc(400, 1000)).toBe(false);
  });
});

describe('stepBacktrack', () => {
  it('older steps back and clamps at the oldest prompt', () => {
    expect(stepBacktrack({ index: 0, count: 2 }, 'older')).toEqual({
      state: { index: 1, count: 2 },
    });
    expect(stepBacktrack({ index: 1, count: 2 }, 'older')).toEqual({
      state: { index: 1, count: 2 },
    });
  });
  it('newer steps forward, and at the latest it cancels', () => {
    expect(stepBacktrack({ index: 1, count: 2 }, 'newer')).toEqual({
      state: { index: 0, count: 2 },
    });
    expect(stepBacktrack({ index: 0, count: 2 }, 'newer')).toEqual({ done: 'cancel' });
  });
  it('pick returns the index and cancel cancels', () => {
    expect(stepBacktrack({ index: 1, count: 2 }, 'pick')).toEqual({ done: 'pick', index: 1 });
    expect(stepBacktrack({ index: 1, count: 2 }, 'cancel')).toEqual({ done: 'cancel' });
  });
});
