import { describe, expect, it } from 'vitest';
import { interruptionStep } from '../interruption';

describe('interruptionStep', () => {
  it('a live call is held on began: playout stops and the uplink mutes', () => {
    expect(interruptionStep('live', { type: 'began' })).toEqual({
      state: 'held',
      effects: ['stop-playout', 'mute-uplink', 'emit-held'],
    });
  });

  it('ended with shouldResume reactivates, restarts the recorder, then unmutes', () => {
    expect(interruptionStep('held', { type: 'ended', shouldResume: true })).toEqual({
      state: 'live',
      effects: ['reactivate-session', 'restart-recorder', 'unmute-uplink', 'emit-resumed'],
    });
  });

  it('ended WITHOUT shouldResume stays held', () => {
    expect(interruptionStep('held', { type: 'ended', shouldResume: false })).toEqual({
      state: 'held',
      effects: [],
    });
  });

  it('returning to the app re-arms a held call even when no ended arrived', () => {
    expect(interruptionStep('held', { type: 'app-active' }).state).toBe('live');
    expect(interruptionStep('held', { type: 'app-active' }).effects).toContain('restart-recorder');
  });

  it('app-active on a live call does nothing', () => {
    expect(interruptionStep('live', { type: 'app-active' })).toEqual({
      state: 'live',
      effects: [],
    });
  });

  it('nothing happens outside a call', () => {
    expect(interruptionStep('idle', { type: 'began' })).toEqual({ state: 'idle', effects: [] });
    expect(interruptionStep('idle', { type: 'app-active' }).effects).toEqual([]);
  });

  it('call-start and call-end move between idle and live', () => {
    expect(interruptionStep('idle', { type: 'call-start' }).state).toBe('live');
    expect(interruptionStep('held', { type: 'call-end' }).state).toBe('idle');
  });
});
