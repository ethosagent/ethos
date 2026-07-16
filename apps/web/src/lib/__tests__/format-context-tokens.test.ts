import { describe, expect, it } from 'vitest';
import { formatContextTokens } from '../format-context-tokens';

describe('formatContextTokens', () => {
  it('shows exact counts below 1000', () => {
    expect(formatContextTokens(0)).toBe('0');
    expect(formatContextTokens(820)).toBe('820');
    expect(formatContextTokens(999)).toBe('999');
  });

  it('uses one-decimal k at or above 1000', () => {
    expect(formatContextTokens(1000)).toBe('1k');
    expect(formatContextTokens(12_400)).toBe('12.4k');
    expect(formatContextTokens(12_000)).toBe('12k');
  });

  it('uses one-decimal M at or above a million', () => {
    expect(formatContextTokens(1_200_000)).toBe('1.2M');
    expect(formatContextTokens(2_000_000)).toBe('2M');
  });
});
