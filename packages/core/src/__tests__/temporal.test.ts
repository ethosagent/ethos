import type { SearchResult } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { applyTemporalDecay, parseTemporalBound, toJournalKey } from '../temporal';

const SEVEN_DAYS_MS = 604_800_000;

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    sessionId: 's1',
    messageId: 'm1',
    snippet: 'test',
    score: 1,
    timestamp: new Date('2025-01-15T00:00:00Z'),
    ...overrides,
  };
}

describe('parseTemporalBound', () => {
  it('parses a valid ISO date string', () => {
    const d = parseTemporalBound('2026-05-20');
    expect(d).toBeInstanceOf(Date);
    expect(d?.toISOString().startsWith('2026-05-20')).toBe(true);
  });

  it('parses a valid ISO datetime string', () => {
    const d = parseTemporalBound('2026-05-20T14:30:00Z');
    expect(d).toBeInstanceOf(Date);
    expect(d?.toISOString()).toBe('2026-05-20T14:30:00.000Z');
  });

  it('returns undefined for an invalid string', () => {
    expect(parseTemporalBound('not-a-date')).toBeUndefined();
  });

  it('returns undefined for an empty string', () => {
    expect(parseTemporalBound('')).toBeUndefined();
  });
});

describe('toJournalKey', () => {
  it('formats a known date as YYYY-MM-DD', () => {
    const d = new Date('2026-05-20T14:30:00Z');
    expect(toJournalKey(d)).toBe('2026-05-20');
  });

  it('handles midnight UTC correctly', () => {
    const d = new Date('2026-01-01T00:00:00Z');
    expect(toJournalKey(d)).toBe('2026-01-01');
  });
});

describe('applyTemporalDecay', () => {
  const now = new Date('2025-01-15T00:00:00Z');

  it('ranks newer results higher when scores are equal', () => {
    const older = makeResult({
      messageId: 'old',
      timestamp: new Date(now.getTime() - SEVEN_DAYS_MS * 2),
    });
    const newer = makeResult({
      messageId: 'new',
      timestamp: new Date(now.getTime() - SEVEN_DAYS_MS * 0.5),
    });
    const result = applyTemporalDecay([older, newer], { now });
    expect(result[0].messageId).toBe('new');
    expect(result[1].messageId).toBe('old');
  });

  it('leaves score unchanged for zero-age result', () => {
    const r = makeResult({ score: 0.8, timestamp: now });
    const [decayed] = applyTemporalDecay([r], { now });
    expect(decayed.score).toBeCloseTo(0.8, 10);
  });

  it('halves score at exactly one half-life', () => {
    const r = makeResult({
      score: 1,
      timestamp: new Date(now.getTime() - SEVEN_DAYS_MS),
    });
    const [decayed] = applyTemporalDecay([r], { now });
    expect(decayed.score).toBeCloseTo(0.5, 10);
  });

  it('drives score near zero for very old results (10x half-life)', () => {
    const r = makeResult({
      score: 1,
      timestamp: new Date(now.getTime() - SEVEN_DAYS_MS * 10),
    });
    const [decayed] = applyTemporalDecay([r], { now });
    expect(decayed.score).toBeLessThan(0.001);
  });

  it('respects custom halfLifeMs', () => {
    const oneHourMs = 3_600_000;
    const r = makeResult({
      score: 1,
      timestamp: new Date(now.getTime() - oneHourMs),
    });
    const [decayed] = applyTemporalDecay([r], { now, halfLifeMs: oneHourMs });
    expect(decayed.score).toBeCloseTo(0.5, 10);
  });

  it('does not mutate the input array', () => {
    const r = makeResult({ score: 0.9, timestamp: now });
    const input = [r];
    const inputCopy = [...input];
    applyTemporalDecay(input, { now });
    expect(input).toEqual(inputCopy);
    expect(input[0].score).toBe(0.9);
  });

  it('clamps decay factor to 1 for future timestamps', () => {
    const r = makeResult({
      score: 0.7,
      timestamp: new Date(now.getTime() + SEVEN_DAYS_MS),
    });
    const [decayed] = applyTemporalDecay([r], { now });
    expect(decayed.score).toBeCloseTo(0.7, 10);
  });
});
