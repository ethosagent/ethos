import { describe, expect, it } from 'vitest';
import { formatElapsed, SPINNER_FRAMES, SpinnerState } from '../lib/spinner';

describe('FW-11 spinner state machine', () => {
  it('starts in idle phase', () => {
    const s = new SpinnerState();
    expect(s.getPhase()).toBe('idle');
    expect(s.isRunning()).toBe(false);
  });

  it('start(now) transitions to running, resets frame + elapsed', () => {
    const s = new SpinnerState();
    s.start(1_000);
    expect(s.isRunning()).toBe(true);
    expect(s.elapsedMillis()).toBe(0);
    expect(s.frame()).toBe(SPINNER_FRAMES[0]);
  });

  it('tick advances frame index in cycle', () => {
    const s = new SpinnerState();
    s.start(0);
    s.tick(100);
    expect(s.frame()).toBe(SPINNER_FRAMES[1]);
    for (let i = 0; i < SPINNER_FRAMES.length; i++) s.tick(100 + i * 100);
    // After enough ticks, wraps back into the cycle.
    expect(SPINNER_FRAMES).toContain(s.frame());
  });

  it('tick updates elapsed from `now`', () => {
    const s = new SpinnerState();
    s.start(1_000);
    s.tick(2_500);
    expect(s.elapsedMillis()).toBe(1_500);
  });

  it('stop transitions to stopped — no leftover frame advances', () => {
    const s = new SpinnerState();
    s.start(0);
    s.tick(100);
    s.tick(200);
    const frameAtStop = s.frame();
    s.stop(500);
    expect(s.isRunning()).toBe(false);
    expect(s.getPhase()).toBe('stopped');
    s.tick(600); // should be ignored
    expect(s.frame()).toBe(frameAtStop);
  });

  it('stop records final elapsed', () => {
    const s = new SpinnerState();
    s.start(1_000);
    s.stop(4_200);
    expect(s.elapsedMillis()).toBe(3_200);
    expect(s.elapsed()).toBe('3.2s');
  });

  it('start() can re-start a stopped instance', () => {
    const s = new SpinnerState();
    s.start(0);
    s.stop(1_000);
    expect(s.isRunning()).toBe(false);
    s.start(2_000);
    expect(s.isRunning()).toBe(true);
    expect(s.elapsedMillis()).toBe(0);
  });
});

describe('FW-11 spinner reduced motion', () => {
  it('renders static · glyph when reducedMotion is set', () => {
    const s = new SpinnerState({ reducedMotion: true });
    s.start(0);
    expect(s.frame()).toBe('·');
    s.tick(100);
    expect(s.frame()).toBe('·');
    s.tick(200);
    expect(s.frame()).toBe('·');
  });

  it('elapsed still updates under reduced motion', () => {
    const s = new SpinnerState({ reducedMotion: true });
    s.start(1_000);
    s.tick(3_400);
    expect(s.elapsed()).toBe('2.4s');
  });
});

describe('FW-11 elapsed formatter', () => {
  it('renders sub-minute as N.Ns', () => {
    expect(formatElapsed(0)).toBe('0.0s');
    expect(formatElapsed(1_200)).toBe('1.2s');
    expect(formatElapsed(59_900)).toBe('59.9s');
  });

  it('renders ≥60s as "Nm Ms"', () => {
    expect(formatElapsed(60_000)).toBe('1m 0s');
    expect(formatElapsed(83_000)).toBe('1m 23s');
    expect(formatElapsed(125_500)).toBe('2m 5s');
  });
});
