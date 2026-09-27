import { describe, expect, it } from 'vitest';
import { createLocalBargeIn, type LocalBargeInEvent } from '../local-barge-in';

function harness(opts: { threshold?: number; sustainMs?: number } = {}) {
  let now = 0;
  let speaking = true;
  let stops = 0;
  const events: LocalBargeInEvent[] = [];
  const barge = createLocalBargeIn({
    playout: {
      speaking: () => speaking,
      stop: () => {
        stops++;
        speaking = false;
      },
    },
    now: () => now,
    onBargeIn: (event) => events.push(event),
    ...opts,
  });
  /** Feed `ms` of 20 ms frames at `rms`. */
  const feed = (rms: number, ms: number): boolean[] => {
    const fired: boolean[] = [];
    for (let elapsed = 0; elapsed < ms; elapsed += 20) {
      fired.push(barge.frame(rms));
      now += 20;
    }
    return fired;
  };
  return {
    barge,
    feed,
    events,
    stops: () => stops,
    setSpeaking: (value: boolean) => {
      speaking = value;
    },
  };
}

describe('createLocalBargeIn', () => {
  it('fires once an onset above threshold is sustained for sustainMs while speaking', () => {
    const h = harness();
    h.feed(0.01, 100);
    const fired = h.feed(0.2, 120);
    // Onset at t=100; frames at 100..200; fires on the frame at t=200.
    expect(fired).toEqual([false, false, false, false, false, true]);
    expect(h.stops()).toBe(1);
    expect(h.events).toEqual([{ t: 200, onsetAt: 100, rms: 0.2 }]);
  });

  it('does not fire on a burst shorter than sustainMs', () => {
    const h = harness();
    h.feed(0.2, 80);
    h.feed(0.01, 20);
    h.feed(0.2, 80);
    expect(h.stops()).toBe(0);
  });

  it('never fires while playout is not speaking', () => {
    const h = harness();
    h.setSpeaking(false);
    h.feed(0.5, 500);
    expect(h.stops()).toBe(0);
    expect(h.events).toEqual([]);
  });

  it('suppresses retriggers until playout goes quiet, then re-arms', () => {
    const h = harness();
    h.feed(0.2, 120);
    expect(h.stops()).toBe(1);
    // Playout still reports speaking (a buffer draining after stop): no second stop.
    h.setSpeaking(true);
    h.feed(0.2, 300);
    expect(h.stops()).toBe(1);
    // One quiet frame re-arms; the next sustained onset fires again.
    h.setSpeaking(false);
    h.feed(0.2, 20);
    h.setSpeaking(true);
    h.feed(0.2, 120);
    expect(h.stops()).toBe(2);
    expect(h.events).toHaveLength(2);
  });

  it('re-arms on reset()', () => {
    const h = harness();
    h.feed(0.2, 120);
    h.setSpeaking(true);
    h.barge.reset();
    h.feed(0.2, 120);
    expect(h.stops()).toBe(2);
  });

  it('honours configurable threshold and sustain', () => {
    const h = harness({ threshold: 0.3, sustainMs: 40 });
    h.feed(0.2, 200);
    expect(h.stops()).toBe(0);
    const fired = h.feed(0.4, 60);
    expect(fired).toEqual([false, false, true]);
  });
});
