import { describe, expect, it } from 'vitest';

describe('receipt reaction', () => {
  it('defaults to 👀 when no config provided', () => {
    const config = { token: 'test' };
    const reaction = config.receiptReaction ?? '👀';
    expect(reaction).toBe('👀');
  });
  it('respects custom receiptReaction', () => {
    const config = { token: 'test', receiptReaction: '✅' };
    const reaction = config.receiptReaction ?? '👀';
    expect(reaction).toBe('✅');
  });
  it('empty string disables reaction', () => {
    const reaction = '';
    expect(reaction).toBeFalsy();
  });
});
