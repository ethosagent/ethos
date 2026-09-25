// `createDecisionToolDecide` (plan/phases/decision-tool.md D4, T2): validate →
// redact → decide under `decisions.timeoutMs` with the call's signal → one
// record. Never throws.

import type {
  DecisionProvider,
  DecisionQuestion,
  DecisionRequest,
  DecisionResult,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import type { DecisionProviderHandle } from '../decision-provider';
import { createDecisionToolDecide, type DecisionToolCallRecord } from '../decision-tool';

const KEY = `sk-${'a'.repeat(48)}`;

const Q: Record<string, DecisionQuestion> = {
  buy: { type: 'boolean', instructions: 'Is this a buy?' },
};

function okResult(): DecisionResult {
  return {
    ok: true,
    answers: { buy: { type: 'boolean', p: 0.8, confidence: 0.6 } },
    model: 'jev-1.13.0',
    usage: { inputTokens: 1000, outputTokens: 1 },
  };
}

function harness(respond: (req: DecisionRequest) => Promise<DecisionResult> | DecisionResult) {
  const requests: DecisionRequest[] = [];
  const decide = vi.fn(async (req: DecisionRequest) => {
    requests.push(req);
    return respond(req);
  });
  const provider: DecisionProvider = { name: 'typesafe', calibrated: true, decide };
  const get = vi.fn(async () => provider);
  const records: DecisionToolCallRecord[] = [];
  let t = 1000;
  const fn = createDecisionToolDecide({
    provider: { get },
    providerName: 'typesafe',
    timeoutMs: 2500,
    recorder: { recordDecisionToolCall: (r) => records.push(r) },
    now: () => {
      t += 10;
      return t;
    },
  });
  return { fn, decide, get, requests, records };
}

const signal = () => new AbortController().signal;

describe('createDecisionToolDecide', () => {
  it('an invalid request (score with one level) is refused; the provider is never called', async () => {
    const h = harness(okResult);
    const out = await h.fn({
      state: 's',
      questions: { q: { type: 'score', instructions: 'grade', criteria: ['only'] } },
      signal: signal(),
    });
    expect(out).toMatchObject({ ok: false, code: 'invalid' });
    expect(h.decide).not.toHaveBeenCalled();
    expect(h.get).not.toHaveBeenCalled();
    expect(h.records).toEqual([
      expect.objectContaining({ outcome: 'invalid', provider: 'typesafe', questionCount: 1 }),
    ]);
  });

  it.each([
    ['string', `the key is ${KEY} ok`],
    ['object', { command: `curl -H "x: ${KEY}"`, nested: [KEY] }],
    ['array', [`token ${KEY}`, { k: KEY }]],
  ])('a secret in %s state never reaches the provider', async (_label, state) => {
    const h = harness(okResult);
    await h.fn({ state, questions: Q, signal: signal() });
    const sent = JSON.stringify(h.requests[0]);
    expect(sent).not.toContain(KEY);
    expect(sent).toContain('[REDACTED:openai-key]');
  });

  it('an undefined handle result (no key) → no_key, recorded', async () => {
    const records: DecisionToolCallRecord[] = [];
    const handle: DecisionProviderHandle = { get: async () => undefined };
    const fn = createDecisionToolDecide({
      provider: handle,
      providerName: 'typesafe',
      timeoutMs: 2000,
      recorder: { recordDecisionToolCall: (r) => records.push(r) },
    });
    const out = await fn({ state: 's', questions: Q, signal: signal() });
    expect(out).toMatchObject({ ok: false, code: 'no_key' });
    expect(records).toEqual([expect.objectContaining({ outcome: 'no_key' })]);
  });

  it('passes the call signal and decisions.timeoutMs through', async () => {
    const h = harness(okResult);
    const s = signal();
    await h.fn({ state: 's', questions: Q, signal: s });
    expect(h.requests[0]?.signal).toBe(s);
    expect(h.requests[0]?.timeoutMs).toBe(2500);
  });

  it('one record per call with the outcome, model, cost and ids', async () => {
    const h = harness(okResult);
    const out = await h.fn({
      state: 's',
      questions: Q,
      signal: signal(),
      personalityId: 'swing-trader',
      sessionId: 'sess',
    });
    expect(out).toMatchObject({ ok: true, model: 'jev-1.13.0', calibrated: true });
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({
      provider: 'typesafe',
      model: 'jev-1.13.0',
      inputTokens: 1000,
      questionCount: 1,
      outcome: 'ok',
      personalityId: 'swing-trader',
      sessionId: 'sess',
    });
    expect(h.records[0]?.latencyMs).toBeGreaterThan(0);
    if (out.ok) expect(h.records[0]?.estimatedCostUsd).toBe(out.costUsd);
  });

  it('a provider error is returned and recorded as its code', async () => {
    const h = harness(() => ({ ok: false, code: 'timeout', message: 'slow' }));
    const out = await h.fn({ state: 's', questions: Q, signal: signal() });
    expect(out).toEqual({ ok: false, code: 'timeout', message: 'slow' });
    expect(h.records).toEqual([
      expect.objectContaining({ outcome: 'timeout', estimatedCostUsd: 0 }),
    ]);
  });

  it('a throwing provider becomes unavailable; a throwing recorder is ignored', async () => {
    const provider: DecisionProvider = {
      name: 'typesafe',
      calibrated: true,
      decide: async () => {
        throw new Error('socket hang up');
      },
    };
    const fn = createDecisionToolDecide({
      provider: { get: async () => provider },
      providerName: 'typesafe',
      timeoutMs: 2000,
      recorder: {
        recordDecisionToolCall: () => {
          throw new Error('db locked');
        },
      },
    });
    await expect(fn({ state: 's', questions: Q, signal: signal() })).resolves.toEqual({
      ok: false,
      code: 'unavailable',
      message: 'socket hang up',
    });
  });
});
