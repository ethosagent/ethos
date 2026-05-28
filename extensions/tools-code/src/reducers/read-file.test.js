import { describe, expect, it } from 'vitest';
import { readFileReducer } from './read-file';

const ctx = { args: {}, turnCount: 0 };
function makeLines(count) {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n');
}
describe('readFileReducer', () => {
  it('file with ≤200 lines → passes through unchanged', () => {
    const value = makeLines(200);
    const result = { ok: true, value };
    const reduced = readFileReducer.reduce(result, ctx);
    expect(reduced).toEqual(result);
  });
  it('file with 400 lines, no range args → truncates to 200 + hint message', () => {
    const value = makeLines(400);
    const result = { ok: true, value };
    const reduced = readFileReducer.reduce(result, ctx);
    expect(reduced.ok).toBe(true);
    if (reduced.ok) {
      expect(reduced.value).toContain('File is 400 lines');
      expect(reduced.value).toContain('Showing lines 1-200');
      expect(reduced.value).toContain('line 200');
      expect(reduced.value).not.toContain('line 201');
    }
  });
  it('file with 400 lines, lineStart in args → passes through unchanged', () => {
    const value = makeLines(400);
    const result = { ok: true, value };
    const ctxWithRange = { args: { lineStart: 50 }, turnCount: 0 };
    const reduced = readFileReducer.reduce(result, ctxWithRange);
    expect(reduced).toEqual(result);
  });
  it('file with 400 lines, lineEnd in args → passes through unchanged', () => {
    const value = makeLines(400);
    const result = { ok: true, value };
    const ctxWithRange = { args: { lineEnd: 100 }, turnCount: 0 };
    const reduced = readFileReducer.reduce(result, ctxWithRange);
    expect(reduced).toEqual(result);
  });
  it('error result → passes through unchanged', () => {
    const result = { ok: false, error: 'file not found', code: 'execution_failed' };
    const reduced = readFileReducer.reduce(result, ctx);
    expect(reduced).toEqual(result);
  });
  it('exactly 199 lines → passes through unchanged', () => {
    const value = makeLines(199);
    const result = { ok: true, value };
    const reduced = readFileReducer.reduce(result, ctx);
    expect(reduced).toEqual(result);
  });
});
