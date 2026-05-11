import { describe, expect, it } from 'vitest';
import {
  accentFor,
  BUILTIN_PERSONALITY_IDS,
  DEFAULT_TOKENS,
  isBuiltinPersonality,
  personalityAccent,
} from '../index';

describe('personalityAccent', () => {
  it('returns the DESIGN.md hex for every built-in personality', () => {
    expect(personalityAccent('researcher')).toBe('#4A9EFF');
    expect(personalityAccent('engineer')).toBe('#4ADE80');
    expect(personalityAccent('reviewer')).toBe('#F59E0B');
    expect(personalityAccent('coach')).toBe('#E879F9');
    expect(personalityAccent('operator')).toBe('#94A3B8');
  });

  it('falls back to operator grey for unknown personalities', () => {
    expect(personalityAccent('not-a-real-personality')).toBe('#94A3B8');
  });
});

describe('accentFor', () => {
  it('resolves against the supplied token pack', () => {
    const custom = {
      ...DEFAULT_TOKENS,
      accents: { ...DEFAULT_TOKENS.accents, strategist: '#123456' },
    };
    expect(accentFor(custom, 'strategist')).toBe('#123456');
    expect(accentFor(custom, 'engineer')).toBe('#4ADE80');
  });

  it('falls back to operator grey when an id is unknown', () => {
    expect(accentFor(DEFAULT_TOKENS, 'ghost')).toBe('#94A3B8');
  });
});

describe('isBuiltinPersonality', () => {
  it('matches every built-in id and rejects custom ones', () => {
    for (const id of BUILTIN_PERSONALITY_IDS) {
      expect(isBuiltinPersonality(id)).toBe(true);
    }
    expect(isBuiltinPersonality('strategist')).toBe(false);
    expect(isBuiltinPersonality('')).toBe(false);
  });
});

describe('BUILTIN_PERSONALITY_IDS', () => {
  it('lists the five DESIGN.md personalities', () => {
    expect([...BUILTIN_PERSONALITY_IDS].sort()).toEqual(
      ['coach', 'engineer', 'operator', 'researcher', 'reviewer'].sort(),
    );
  });
});
