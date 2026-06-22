import { describe, expect, it } from 'vitest';
import { generateCodeChallenge, generateCodeVerifier } from '../pkce';

describe('generateCodeVerifier', () => {
  it('produces a 43-character string', () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toHaveLength(43);
  });

  it('contains only base64url-safe characters', () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('generateCodeChallenge', () => {
  it('is deterministic for a given verifier', () => {
    const verifier = 'test-verifier-value';
    const a = generateCodeChallenge(verifier);
    const b = generateCodeChallenge(verifier);
    expect(a).toBe(b);
  });

  it('is not equal to the verifier', () => {
    const verifier = generateCodeVerifier();
    const challenge = generateCodeChallenge(verifier);
    expect(challenge).not.toBe(verifier);
  });
});
