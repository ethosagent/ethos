import { describe, expect, it } from 'vitest';
import { evaluateEligibility } from '../eligibility';

const LONG = 'My daughter Priya was born in 2019 and I work as a staff engineer at Acme.';

function input(over: Partial<Parameters<typeof evaluateEligibility>[0]> = {}) {
  return {
    sessionKey: 'cli:ethos',
    initialPrompt: LONG,
    finalText: 'Noted — congratulations!',
    isDryRun: false,
    minUserChars: 80,
    ...over,
  };
}

describe('evaluateEligibility', () => {
  it('accepts a substantive turn', () => {
    // LONG is 73 chars; bump above the 80 floor.
    const res = evaluateEligibility(
      input({ initialPrompt: `${LONG} Please remember all of that.` }),
    );
    expect(res.eligible).toBe(true);
  });

  it('excludes user text shorter than the floor', () => {
    const res = evaluateEligibility(input({ initialPrompt: 'hi there' }));
    expect(res).toEqual({ eligible: false, reason: 'user-text-too-short' });
  });

  it('excludes tool-only turns (no assistant prose)', () => {
    const res = evaluateEligibility(input({ finalText: '   ' }));
    expect(res).toEqual({ eligible: false, reason: 'tool-only' });
  });

  it('excludes dream sessions', () => {
    const res = evaluateEligibility(input({ sessionKey: 'dream:ethos' }));
    expect(res).toEqual({ eligible: false, reason: 'dream-session' });
  });

  it('excludes :sub: child sessions', () => {
    const res = evaluateEligibility(input({ sessionKey: 'cli:ethos:sub:task:3' }));
    expect(res).toEqual({ eligible: false, reason: 'child-session' });
  });

  it('excludes :moa: child sessions', () => {
    const res = evaluateEligibility(input({ sessionKey: 'cli:ethos:moa:worker:3' }));
    expect(res).toEqual({ eligible: false, reason: 'child-session' });
  });

  it('excludes :job: child sessions', () => {
    const res = evaluateEligibility(input({ sessionKey: 'cli:ethos:job:build:ab12cd34' }));
    expect(res).toEqual({ eligible: false, reason: 'child-session' });
  });

  it('excludes background-job wake turns (envelope)', () => {
    const res = evaluateEligibility(
      input({ initialPrompt: '[background job ab12cd34 finished — status: done]\n\nresult' }),
    );
    expect(res).toEqual({ eligible: false, reason: 'wake-turn' });
  });

  it('excludes background-job wake turns (untrusted tag)', () => {
    const res = evaluateEligibility(
      input({
        initialPrompt: `${LONG} <untrusted source="unknown" tool="background_job_summary">x</untrusted>`,
      }),
    );
    expect(res).toEqual({ eligible: false, reason: 'wake-turn' });
  });

  it('excludes dry runs', () => {
    const res = evaluateEligibility(input({ isDryRun: true }));
    expect(res).toEqual({ eligible: false, reason: 'dry-run' });
  });
});
