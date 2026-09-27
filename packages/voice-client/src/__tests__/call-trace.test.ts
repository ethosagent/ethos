import { describe, expect, it } from 'vitest';
import { parseTrace } from '../trace/analyze';
import { createCallTrace } from '../trace/call-trace';

describe('createCallTrace', () => {
  it('stamps events from the injected clocks and serialises JSONL', () => {
    let now = 1000;
    let audio = 5;
    const trace = createCallTrace({
      tier: 'realtime',
      label: 'test',
      clock: { now: () => now, audioNow: () => audio },
    });
    trace.localEnd();
    now = 1100;
    audio = 5.1;
    trace.sched(5.3, 0.5, 'u1');
    trace.calib(40);
    const lines = trace
      .toJsonl()
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { ev: 'header', v: 1, tier: 'realtime', label: 'test' },
      { ev: 'local_end', t: 1000 },
      { ev: 'sched', t: 1100, ctxNow: 5.1, startAt: 5.3, dur: 0.5, utteranceId: 'u1' },
      { ev: 'calib', roundTripMs: 40 },
    ]);
  });

  it('maps sched onto the monotonic clock when there is no audio clock', () => {
    const trace = createCallTrace({ tier: 'pipeline', clock: { now: () => 2000 } });
    trace.sched(2.5, 1, 'u');
    expect(trace.events()[1]).toMatchObject({ ctxNow: 2, startAt: 2.5 });
  });

  it('records engine errors in a form parseTrace reads back', () => {
    const trace = createCallTrace({ tier: 'pipeline', clock: { now: () => 7 } });
    trace.engineError('undecodable_audio', 'audio/ogg: no decoder');
    expect(trace.events()[1]).toEqual({
      ev: 'engine_error',
      t: 7,
      code: 'undecodable_audio',
      message: 'audio/ogg: no decoder',
    });
    expect(parseTrace(trace.toJsonl()).malformed).toBe(0);
  });

  it('stops storing past maxEvents and counts the rest', () => {
    const trace = createCallTrace({ tier: 'realtime', clock: { now: () => 0 }, maxEvents: 3 });
    for (let i = 0; i < 5; i++) trace.txAudio(i);
    expect(trace.events()).toHaveLength(3);
    expect(trace.dropped()).toBe(3);
  });
});
