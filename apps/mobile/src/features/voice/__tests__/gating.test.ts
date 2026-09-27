import { describe, expect, it } from 'vitest';
import { callAvailable, personalityCanTalk, VOICE_CAPABILITY } from '../gating';

const talking = ['read_file', VOICE_CAPABILITY];
const base = {
  scopes: ['chat:send', 'voice:talk'],
  toolset: talking,
  executionEnvironment: 'bare',
};

describe('callAvailable — the composer mic', () => {
  it('shows with voice:talk, a personality that can talk, and a native build', () => {
    expect(callAvailable(base)).toBe(true);
  });

  it('is hidden without voice:talk (a key minted before Phase 3)', () => {
    expect(callAvailable({ ...base, scopes: ['chat:send'] })).toBe(false);
  });

  it('is hidden while whoami is loading or for a cookie session', () => {
    expect(callAvailable({ ...base, scopes: null })).toBe(false);
  });

  it('is hidden when the personality cannot talk', () => {
    expect(callAvailable({ ...base, toolset: ['read_file'] })).toBe(false);
    expect(callAvailable({ ...base, toolset: null })).toBe(false);
  });

  it('is hidden in Expo Go, which has no native audio library', () => {
    expect(callAvailable({ ...base, executionEnvironment: 'storeClient' })).toBe(false);
  });
});

describe('personalityCanTalk', () => {
  it('mirrors the web gate on the voice_session toolset entry', () => {
    expect(personalityCanTalk([VOICE_CAPABILITY])).toBe(true);
    expect(personalityCanTalk(undefined)).toBe(false);
  });
});
