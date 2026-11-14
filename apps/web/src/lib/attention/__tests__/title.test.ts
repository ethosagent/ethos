import { describe, expect, it } from 'vitest';
import { formatAttentionTitle, stripAttentionPrefix } from '../title';

describe('formatAttentionTitle', () => {
  it('prefixes the count', () => {
    expect(formatAttentionTitle('Ethos', 3)).toBe('(3) Ethos');
  });

  it('returns the base for count 0 and negative', () => {
    expect(formatAttentionTitle('Ethos', 0)).toBe('Ethos');
    expect(formatAttentionTitle('Ethos', -2)).toBe('Ethos');
  });

  it('does not stack prefixes', () => {
    expect(formatAttentionTitle('(2) Ethos', 5)).toBe('(5) Ethos');
  });

  it('strips an existing prefix when count drops to 0', () => {
    expect(formatAttentionTitle('(2) Ethos', 0)).toBe('Ethos');
  });
});

describe('stripAttentionPrefix', () => {
  it('removes a leading (N) prefix', () => {
    expect(stripAttentionPrefix('(12) Ethos')).toBe('Ethos');
  });

  it('leaves non-numeric parentheses alone', () => {
    expect(stripAttentionPrefix('(draft) Ethos')).toBe('(draft) Ethos');
  });

  it('does not treat (0) as a prefix', () => {
    expect(stripAttentionPrefix('(0) Ethos')).toBe('(0) Ethos');
  });

  it('removes only one prefix', () => {
    expect(stripAttentionPrefix('(1) (2) Ethos')).toBe('(2) Ethos');
  });
});
