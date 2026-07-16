// Phase 3 — per-model-class default context engine. Frontier models with a
// wired summarizer default to semantic_summary; mid/small/local models (and any
// model without a summarizer) default to the deterministic drop_oldest, never
// weak-model self-summarization.

import { describe, expect, it } from 'vitest';
import { FRONTIER_WINDOW_TOKENS, resolveDefaultContextEngine } from '../model-catalog';

describe('resolveDefaultContextEngine', () => {
  it('frontier window + summarizer wired → semantic_summary', () => {
    expect(resolveDefaultContextEngine(200_000, true)).toBe('semantic_summary');
    expect(resolveDefaultContextEngine(FRONTIER_WINDOW_TOKENS, true)).toBe('semantic_summary');
  });

  it('frontier window but NO summarizer → drop_oldest', () => {
    expect(resolveDefaultContextEngine(200_000, false)).toBe('drop_oldest');
  });

  it('mid / small / local windows → drop_oldest even with a summarizer', () => {
    expect(resolveDefaultContextEngine(64_000, true)).toBe('drop_oldest');
    expect(resolveDefaultContextEngine(32_000, true)).toBe('drop_oldest');
    expect(resolveDefaultContextEngine(8_192, true)).toBe('drop_oldest');
  });

  it('unknown window → drop_oldest', () => {
    expect(resolveDefaultContextEngine(undefined, true)).toBe('drop_oldest');
  });
});
