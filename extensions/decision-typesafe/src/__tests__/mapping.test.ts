// Plan §14 "Mapping" (the parts that live in this package) and §5.2:
// boolean confidence = |2p − 1|, score level = argmax, anything unexpected is
// `malformed`, never a default.

import type { DecisionQuestion } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { argmax, mapResponse } from '../mapping';
import { createTypesafeDecisionProvider } from '../provider';
import { BOOL_Q, json, okBody, stubFetch } from './stub';

const CHOICE: DecisionQuestion = {
  type: 'choice',
  instructions: 'Verdict?',
  criteria: { approve: 'safe', deny: 'unsafe', ask: 'unsure' },
};
const SCORE: DecisionQuestion = {
  type: 'score',
  instructions: 'How hard?',
  criteria: ['trivial', 'normal', 'hard'],
};

describe('boolean', () => {
  it.each([
    [0, 1],
    [0.5, 0],
    [1, 1],
    [0.97, 0.94],
  ])('p = %f → confidence %f', (p, confidence) => {
    const r = mapResponse(BOOL_Q, okBody({ injection: { type: 'noul', noul: p } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.answers.injection).toEqual({ type: 'boolean', p, confidence: expect.any(Number) });
    expect(r.answers.injection?.confidence).toBeCloseTo(confidence, 10);
  });
});

describe('score', () => {
  it('level is the argmax of probabilities; legend is dropped', () => {
    const r = mapResponse(
      { hard: SCORE },
      okBody({
        hard: {
          type: 'score',
          score: 1.6,
          legend: ['trivial', 'normal', 'hard'],
          probabilities: [0.1, 0.2, 0.7],
          confidence: 0.7,
        },
      }),
    );
    expect(r).toMatchObject({
      ok: true,
      answers: {
        hard: {
          type: 'score',
          level: 2,
          score: 1.6,
          probabilities: [0.1, 0.2, 0.7],
          confidence: 0.7,
        },
      },
    });
    if (r.ok) expect(r.answers.hard).not.toHaveProperty('legend');
  });

  it('argmax takes the first of a tie', () => {
    expect(argmax([0.4, 0.4, 0.2])).toBe(0);
    expect(argmax([0.1, 0.2, 0.7])).toBe(2);
  });

  it('probabilities that do not match the asked levels → malformed', () => {
    const r = mapResponse(
      { hard: SCORE },
      okBody({ hard: { type: 'score', score: 1, probabilities: [0.5, 0.5], confidence: 0.5 } }),
    );
    expect(r).toMatchObject({ ok: false, code: 'malformed' });
  });
});

describe('choice', () => {
  it('is carried verbatim', () => {
    const answer = {
      type: 'choice',
      choice: 'ask',
      probabilities: { approve: 0.2, deny: 0.1, ask: 0.7 },
      confidence: 0.7,
    };
    const r = mapResponse({ verdict: CHOICE }, okBody({ verdict: answer }));
    expect(r).toEqual({
      ok: true,
      answers: { verdict: answer },
      model: 'jev-1.3',
      usage: { inputTokens: 120, outputTokens: 3 },
    });
  });

  it('a choice that was not offered → malformed', () => {
    const r = mapResponse(
      { verdict: CHOICE },
      okBody({ verdict: { type: 'choice', choice: 'maybe', probabilities: {}, confidence: 0.9 } }),
    );
    expect(r).toMatchObject({ ok: false, code: 'malformed' });
  });
});

describe('malformed, never a default', () => {
  it.each([
    ['wrong answer type', { injection: { type: 'choice', choice: 'x' } }],
    ['missing answer', {}],
    ['answer for another id only', { other: { type: 'noul', noul: 0.4 } }],
    ['probability above 1', { injection: { type: 'noul', noul: 1.2 } }],
    ['probability below 0', { injection: { type: 'noul', noul: -0.1 } }],
    ['probability as a string', { injection: { type: 'noul', noul: '0.5' } }],
  ])('%s → malformed', (_label, answers) => {
    expect(mapResponse(BOOL_Q, okBody(answers))).toMatchObject({ ok: false, code: 'malformed' });
  });

  it('non-finite numbers → malformed', () => {
    for (const noul of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = mapResponse(BOOL_Q, okBody({ injection: { type: 'noul', noul } }));
      expect(r).toMatchObject({ ok: false, code: 'malformed' });
    }
  });

  it('a choice probability outside 0..1 → malformed', () => {
    const r = mapResponse(
      { verdict: CHOICE },
      okBody({
        verdict: { type: 'choice', choice: 'ask', probabilities: { ask: 1.5 }, confidence: 0.7 },
      }),
    );
    expect(r).toMatchObject({ ok: false, code: 'malformed' });
  });

  it('missing model or usage → malformed', () => {
    const answers = { injection: { type: 'noul', noul: 0.9 } };
    expect(
      mapResponse(BOOL_Q, { answers, usage: { input_tokens: 1, output_tokens: 0 } }),
    ).toMatchObject({ ok: false, code: 'malformed' });
    expect(mapResponse(BOOL_Q, { model: 'jev-1', answers })).toMatchObject({
      ok: false,
      code: 'malformed',
    });
  });
});

describe('through the provider', () => {
  it('maps usage and reports the RESPONSE model, not the requested one (D8)', async () => {
    const stub = stubFetch(() =>
      json({
        model: 'jev-1.4.2',
        answers: { injection: { type: 'noul', noul: 0.1 } },
        usage: { input_tokens: 812, output_tokens: 1 },
      }),
    );
    const r = await createTypesafeDecisionProvider({ apiKey: 'k', fetch: stub.fetch }).decide({
      state: 's',
      questions: BOOL_Q,
    });
    expect(stub.requests[0]?.body.model).toBe('jev-latest');
    expect(r).toMatchObject({
      ok: true,
      model: 'jev-1.4.2',
      usage: { inputTokens: 812, outputTokens: 1 },
    });
  });

  it('a wrong-type answer from the wire → malformed', async () => {
    const stub = stubFetch(() =>
      json(
        okBody({ injection: { type: 'score', score: 1, probabilities: [1, 0], confidence: 1 } }),
      ),
    );
    const r = await createTypesafeDecisionProvider({ apiKey: 'k', fetch: stub.fetch }).decide({
      state: 's',
      questions: BOOL_Q,
    });
    expect(r).toMatchObject({ ok: false, code: 'malformed' });
  });
});
