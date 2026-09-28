// Verification round A1 — the fold every deny comparison uses. Pins that it
// folds case and Unicode normalization, and the characters whose plain
// `toLowerCase()` would miss the letter a case-insensitive file system maps
// them to.

import { describe, expect, it } from 'vitest';
import { foldForDeny } from '../deny-fold';

describe('foldForDeny', () => {
  it('folds ASCII case', () => {
    expect(foldForDeny('/Users/U/.ETHOS/Personalities/A/TOOLSET.yaml')).toBe(
      '/users/u/.ethos/personalities/a/toolset.yaml',
    );
  });

  it('folds Unicode normalization (NFD and NFC compare equal)', () => {
    expect(foldForDeny('/home/José/.ethos')).toBe(foldForDeny('/home/josé/.ethos'));
  });

  it('folds the Kelvin sign and the long s to their plain letters', () => {
    expect(foldForDeny('Keys.json')).toBe('keys.json');
    expect(foldForDeny('ſoul.md')).toBe('soul.md');
  });
});
