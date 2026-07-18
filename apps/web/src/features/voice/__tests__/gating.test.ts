import { describe, expect, it } from 'vitest';
import { personalityCanTalk, VOICE_CAPABILITY } from '../gating';

describe('personalityCanTalk (§3(e) toolset gate)', () => {
  it('is true when the toolset lists the voice capability', () => {
    expect(personalityCanTalk(['memory_read', VOICE_CAPABILITY, 'read_file'])).toBe(true);
  });

  it('is false when the toolset omits the voice capability', () => {
    expect(personalityCanTalk(['memory_read', 'read_file'])).toBe(false);
  });

  it('is false for an empty toolset', () => {
    expect(personalityCanTalk([])).toBe(false);
  });

  it('is false while the toolset is unresolved (null / undefined)', () => {
    expect(personalityCanTalk(null)).toBe(false);
    expect(personalityCanTalk(undefined)).toBe(false);
  });
});
