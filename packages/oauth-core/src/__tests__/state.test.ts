import { describe, expect, it } from 'vitest';
import { generateState } from '../state';

describe('generateState', () => {
  it('produces a 22-character base64url string', () => {
    const state = generateState();
    expect(state).toHaveLength(22);
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('produces different values on each call', () => {
    const a = generateState();
    const b = generateState();
    expect(a).not.toBe(b);
  });
});
