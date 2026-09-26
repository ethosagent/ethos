// Plan §14 "Contract tests inside decision-typesafe": errors returned not
// thrown, limits enforced, signal and timeout honoured, answers of the declared
// type, `calibrated: true`.

import type { DecisionProvider } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createTypesafeDecisionProvider } from '../provider';
import { BOOL_Q, hang, json, okBody, stubFetch } from './stub';

describe('DecisionProvider contract — typesafe', () => {
  it('names itself and is calibrated', () => {
    const p: DecisionProvider = createTypesafeDecisionProvider({ apiKey: 'k' });
    expect(p.name).toBe('typesafe');
    expect(p.calibrated).toBe(true);
  });

  it('exposes exactly one method, decide', () => {
    const p = createTypesafeDecisionProvider({ apiKey: 'k' });
    const methods = Object.entries(p).filter(([, v]) => typeof v === 'function');
    expect(methods.map(([k]) => k)).toEqual(['decide']);
  });

  it('errors are returned, never thrown', async () => {
    const throwingFetch = () => {
      throw new Error('sync boom');
    };
    const cases: DecisionProvider[] = [
      createTypesafeDecisionProvider({ apiKey: 'k', fetch: throwingFetch }),
      createTypesafeDecisionProvider({ apiKey: 'k', fetch: async () => json(null) }),
      createTypesafeDecisionProvider({ apiKey: 'k', fetch: async () => json([1, 2]) }),
      createTypesafeDecisionProvider({
        apiKey: 'k',
        fetch: async () => json({}, 503),
        now: () => {
          throw new Error('clock boom');
        },
      }),
      // An observer that throws must not surface either.
      createTypesafeDecisionProvider({
        apiKey: 'k',
        fetch: async () => json({}, 401),
        onEvent: () => {
          throw new Error('observer boom');
        },
      }),
    ];
    for (const p of cases) {
      for (let i = 0; i < 4; i++) {
        const r = await p.decide({ state: 's', questions: BOOL_Q });
        expect(r.ok).toBe(false);
      }
    }
    // A malformed request is also data, not a throw.
    const p = createTypesafeDecisionProvider({ apiKey: 'k', fetch: async () => json({}) });
    const bad = await p.decide({ state: 's', questions: null as unknown as Record<string, never> });
    expect(bad).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('honours the signal and the timeout', async () => {
    const stub = stubFetch(hang);
    const p = createTypesafeDecisionProvider({ apiKey: 'k', fetch: stub.fetch });
    expect(await p.decide({ state: 's', questions: BOOL_Q, timeoutMs: 15 })).toMatchObject({
      code: 'timeout',
    });
    const c = new AbortController();
    const pending = p.decide({ state: 's', questions: BOOL_Q, signal: c.signal });
    c.abort();
    expect(await pending).toMatchObject({ code: 'aborted' });
  });

  it('answers carry the declared type for every question asked', async () => {
    const stub = stubFetch(() =>
      json(
        okBody({
          b: { type: 'noul', noul: 0.8 },
          c: { type: 'choice', choice: 'x', probabilities: { x: 0.9, y: 0.1 }, confidence: 0.9 },
          s: { type: 'score', score: 0.2, probabilities: [0.8, 0.2], confidence: 0.8 },
        }),
      ),
    );
    const p = createTypesafeDecisionProvider({ apiKey: 'k', fetch: stub.fetch });
    const r = await p.decide({
      state: ['a', 'b'],
      questions: {
        b: { type: 'boolean', instructions: 'b?' },
        c: { type: 'choice', instructions: 'c?', criteria: { x: 'x', y: 'y' } },
        s: { type: 'score', instructions: 's?', criteria: ['low', 'high'] },
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.answers.b?.type).toBe('boolean');
    expect(r.answers.c?.type).toBe('choice');
    expect(r.answers.s).toMatchObject({ type: 'score', level: 0 });
    for (const a of Object.values(r.answers)) {
      expect(a.confidence).toBeGreaterThanOrEqual(0);
      expect(a.confidence).toBeLessThanOrEqual(1);
    }
  });
});
