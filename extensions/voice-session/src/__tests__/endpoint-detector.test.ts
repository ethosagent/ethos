import { describe, expect, it } from 'vitest';
import { EndpointDetector } from '../endpoint-detector';
import { makeClock } from './fakes';

describe('EndpointDetector', () => {
  it('commits after trailing silence exceeds the threshold', () => {
    const clock = makeClock();
    const d = new EndpointDetector({ silenceMs: 400, now: clock.now });

    clock.advance(20);
    expect(d.process(true).committed).toBe(false); // speech at t=20

    let committed = false;
    for (let i = 0; i < 30 && !committed; i++) {
      clock.advance(20);
      committed = d.process(false).committed;
    }
    expect(committed).toBe(true);
  });

  it('never commits without prior speech', () => {
    const clock = makeClock();
    const d = new EndpointDetector({ silenceMs: 400, now: clock.now });
    for (let i = 0; i < 50; i++) {
      clock.advance(20);
      expect(d.process(false).committed).toBe(false);
    }
  });

  it('re-arms for the next utterance after a commit', () => {
    const clock = makeClock();
    const d = new EndpointDetector({ silenceMs: 400, now: clock.now });

    const runToCommit = () => {
      clock.advance(20);
      d.process(true);
      let committed = false;
      for (let i = 0; i < 30 && !committed; i++) {
        clock.advance(20);
        committed = d.process(false).committed;
      }
      return committed;
    };

    expect(runToCommit()).toBe(true);
    expect(d.active).toBe(false);
    expect(runToCommit()).toBe(true);
  });
});
