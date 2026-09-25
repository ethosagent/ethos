// Plan §14 "Limits": DECISION_LIMITS through validateDecisionRequest, and the
// §5.3 size guard — all refused before any network call.

import type { DecisionQuestion, DecisionRequest } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createTypesafeDecisionProvider } from '../provider';
import { validateDecisionRequest } from '../validate';
import { json, okBody, stubFetch } from './stub';

function choiceWith(n: number): DecisionQuestion {
  const criteria: Record<string, string> = {};
  for (let i = 0; i < n; i++) criteria[`o${i}`] = `option ${i}`;
  return { type: 'choice', instructions: 'pick', criteria };
}

function scoreWith(n: number): DecisionQuestion {
  return {
    type: 'score',
    instructions: 'rate',
    criteria: Array.from({ length: n }, (_, i) => `l${i}`),
  };
}

function req(q: DecisionQuestion, state: DecisionRequest['state'] = 's'): DecisionRequest {
  return { state, questions: { q } };
}

describe('validateDecisionRequest', () => {
  it.each([
    ['256 choice options', choiceWith(256)],
    ['0 choice options', choiceWith(0)],
    ['1 score level', scoreWith(1)],
    ['11 score levels', scoreWith(11)],
    ['empty instructions', { type: 'boolean', instructions: '   ' } as DecisionQuestion],
  ])('refuses %s', (_label, q) => {
    expect(validateDecisionRequest(req(q))).toMatchObject({ ok: false, code: 'invalid' });
  });

  it.each([
    ['255 choice options', choiceWith(255)],
    ['1 choice option', choiceWith(1)],
    ['2 score levels', scoreWith(2)],
    ['10 score levels', scoreWith(10)],
  ])('accepts %s', (_label, q) => {
    expect(validateDecisionRequest(req(q))).toEqual({ ok: true });
  });

  it('refuses an empty questions map', () => {
    expect(validateDecisionRequest({ state: 's', questions: {} })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
  });

  it('refuses an unknown question type and a non-positive budget', () => {
    const bad = { type: 'noul', instructions: 'x' } as unknown as DecisionQuestion;
    expect(validateDecisionRequest(req(bad))).toMatchObject({ ok: false, code: 'invalid' });
    expect(validateDecisionRequest({ ...req(scoreWith(2)), timeoutMs: 0 })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
  });
});

describe('the adapter refuses before any network call', () => {
  function setup() {
    const stub = stubFetch(() => json(okBody({})));
    return { stub, p: createTypesafeDecisionProvider({ apiKey: 'k', fetch: stub.fetch }) };
  }

  it.each([choiceWith(256), scoreWith(1), scoreWith(11)])(
    'limit breach → invalid, no request',
    async (q) => {
      const { stub, p } = setup();
      expect(await p.decide(req(q))).toMatchObject({ ok: false, code: 'invalid' });
      expect(stub.requests).toHaveLength(0);
    },
  );

  it('state + longest question past 32k tokens → too_large, no request', async () => {
    const { stub, p } = setup();
    // 4 chars/token: 128_100 chars ≈ 32_025 tokens of state alone.
    const r = await p.decide(req({ type: 'boolean', instructions: 'x' }, 'a'.repeat(128_100)));
    expect(r).toMatchObject({ ok: false, code: 'too_large' });
    expect(stub.requests).toHaveLength(0);
  });

  it('state + all questions past 64k tokens → too_large, no request', async () => {
    const { stub, p } = setup();
    // State ≈ 10k tokens; five questions ≈ 12.5k tokens each. Each pair is
    // ≈ 22.5k (< 32k) but the total is ≈ 72.5k (> 64k).
    const questions: Record<string, DecisionQuestion> = {};
    for (let i = 0; i < 5; i++) {
      questions[`q${i}`] = { type: 'boolean', instructions: 'b'.repeat(50_000) };
    }
    const r = await p.decide({ state: 'a'.repeat(40_000), questions });
    expect(r).toMatchObject({ ok: false, code: 'too_large' });
    expect(r.ok === false && r.message).toContain('all questions');
    expect(stub.requests).toHaveLength(0);
  });

  it('object state is estimated as JSON text', async () => {
    const { stub, p } = setup();
    const r = await p.decide(
      req({ type: 'boolean', instructions: 'x' }, { blob: 'a'.repeat(128_100) }),
    );
    expect(r).toMatchObject({ ok: false, code: 'too_large' });
    expect(stub.requests).toHaveLength(0);
  });

  it('a request just under both limits goes to the network', async () => {
    const stub = stubFetch(() => json(okBody({ q: { type: 'noul', noul: 0.5 } })));
    const p = createTypesafeDecisionProvider({ apiKey: 'k', fetch: stub.fetch });
    const r = await p.decide(req({ type: 'boolean', instructions: 'x' }, 'a'.repeat(120_000)));
    expect(r.ok).toBe(true);
    expect(stub.requests).toHaveLength(1);
  });
});
