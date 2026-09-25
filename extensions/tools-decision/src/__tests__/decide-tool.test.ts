import type { DecisionErrorCode, ToolContext } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import {
  createDecideTool,
  DECIDE_MAX_QUESTIONS,
  DECIDE_MAX_STATE_CHARS,
  type DecideFn,
  type DecideOutcome,
} from '../index';

function ctx(): ToolContext {
  return {
    sessionId: 'sess-1',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir: '/tmp',
    personalityId: 'swing-trader',
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
  };
}

const OK: DecideOutcome = {
  ok: true,
  answers: {
    buy: { type: 'boolean', p: 0.82, confidence: 0.71 },
    setup: {
      type: 'choice',
      choice: 'breakout',
      probabilities: { range: 0.22, breakout: 0.64, reversal: 0.14 },
      confidence: 0.58,
    },
    quality: {
      type: 'score',
      level: 2,
      score: 0.61,
      probabilities: [0.05, 0.1, 0.5, 0.25, 0.1],
      confidence: 0.66,
    },
  },
  model: 'jev-1.13.0',
  latencyMs: 412,
  calibrated: true,
  costUsd: 0.0012,
};

const QUESTIONS = {
  buy: {
    type: 'boolean',
    instructions: 'Is this a buy?',
    criteria: { true: 'enter now', false: 'wait' },
  },
  setup: {
    type: 'choice',
    instructions: 'Which setup?',
    criteria: { breakout: 'cleared resistance', range: 'in a range', reversal: 'turning' },
  },
  quality: {
    type: 'score',
    instructions: 'Grade the setup.',
    criteria: ['poor', 'weak', 'fair', 'good', 'excellent'],
  },
};

describe('createDecideTool', () => {
  it('declares the D3 shape: name, toolset, result cap', () => {
    const tool = createDecideTool({ decide: vi.fn() });
    expect(tool.name).toBe('decide');
    expect(tool.toolset).toBe('decision');
    expect(tool.maxResultChars).toBe(4000);
    expect(tool.description).toContain('ask Jev');
  });

  it('boolean, choice and score answers format per D9, with structured + cost_usd', async () => {
    const decide = vi.fn<DecideFn>(async () => OK);
    const tool = createDecideTool({ decide });
    const context = ctx();
    const result = await tool.execute({ state: { price: 2940 }, questions: QUESTIONS }, context);
    expect(result).toEqual({
      ok: true,
      value: [
        'buy: yes p=0.82 conf=0.71',
        'setup: breakout (breakout 0.64, range 0.22, reversal 0.14) conf=0.58',
        'quality: level 3/5 score=0.61 conf=0.66',
        'model=jev-1.13.0 latency=412ms calibrated=true',
      ].join('\n'),
      structured: {
        answers: OK.answers,
        model: 'jev-1.13.0',
        latencyMs: 412,
        calibrated: true,
      },
      cost_usd: 0.0012,
    });
    expect(decide).toHaveBeenCalledWith({
      state: { price: 2940 },
      questions: QUESTIONS,
      signal: context.abortSignal,
      personalityId: 'swing-trader',
      sessionId: 'sess-1',
    });
  });

  it('a boolean below 0.5 reads "no"', async () => {
    const tool = createDecideTool({
      decide: async () => ({
        ...OK,
        answers: { buy: { type: 'boolean', p: 0.3, confidence: 0.9 } },
      }),
    });
    const result = await tool.execute({ state: 's', questions: { buy: QUESTIONS.buy } }, ctx());
    expect(result.ok && result.value.split('\n')[0]).toBe('buy: no p=0.30 conf=0.90');
  });

  it('over-cap question count → input_invalid, decide never called', async () => {
    const decide = vi.fn<DecideFn>(async () => OK);
    const tool = createDecideTool({ decide });
    const questions = Object.fromEntries(
      Array.from({ length: DECIDE_MAX_QUESTIONS + 1 }, (_, i) => [`q${i}`, QUESTIONS.buy]),
    );
    const result = await tool.execute({ state: 's', questions }, ctx());
    expect(result).toMatchObject({ ok: false, code: 'input_invalid', field: 'questions' });
    expect(decide).not.toHaveBeenCalled();
  });

  it.each([
    ['string', 'x'.repeat(DECIDE_MAX_STATE_CHARS + 1)],
    ['object', { blob: 'x'.repeat(DECIDE_MAX_STATE_CHARS) }],
  ])('over-cap %s state → input_invalid, decide never called', async (_label, state) => {
    const decide = vi.fn<DecideFn>(async () => OK);
    const tool = createDecideTool({ decide });
    const result = await tool.execute({ state, questions: { buy: QUESTIONS.buy } }, ctx());
    expect(result).toMatchObject({ ok: false, code: 'input_invalid', field: 'state' });
    expect(decide).not.toHaveBeenCalled();
  });

  it.each([
    [{ questions: { buy: QUESTIONS.buy } }, 'state'],
    [{ state: 42, questions: { buy: QUESTIONS.buy } }, 'state'],
    [{ state: 's', questions: {} }, 'questions'],
    [{ state: 's', questions: [] }, 'questions'],
  ])('malformed args %j → input_invalid on %s', async (args, field) => {
    const decide = vi.fn<DecideFn>(async () => OK);
    const result = await createDecideTool({ decide }).execute(args, ctx());
    expect(result).toMatchObject({ ok: false, code: 'input_invalid', field });
    expect(decide).not.toHaveBeenCalled();
  });

  const MAPPING: Array<[DecisionErrorCode | 'no_key', string]> = [
    ['invalid', 'input_invalid'],
    ['too_large', 'input_invalid'],
    ['auth', 'not_available'],
    ['unavailable', 'not_available'],
    ['breaker_open', 'not_available'],
    ['no_key', 'not_available'],
    ['rate_limited', 'execution_failed'],
    ['overloaded', 'execution_failed'],
    ['timeout', 'execution_failed'],
    ['aborted', 'execution_failed'],
    ['malformed', 'execution_failed'],
  ];

  it.each(MAPPING)('provider code %s → %s with the Jev-failed text (D10)', async (code, mapped) => {
    const tool = createDecideTool({
      decide: async () => ({ ok: false, code, message: 'boom' }),
    });
    const result = await tool.execute({ state: 's', questions: { buy: QUESTIONS.buy } }, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(mapped);
    expect(result.error.startsWith(`Jev failed (${code}): boom`)).toBe(true);
    expect(
      result.error.endsWith(
        "Tell the user Jev did not answer; do not substitute your own judgement as Jev's.",
      ),
    ).toBe(true);
  });
});
