import type { DecisionErrorCode } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  DecisionsListOutput,
  DecisionsTestInput,
  DecisionsTestOutput,
  DecisionTestErrorCodeSchema,
} from '../index';

// The `decisions` namespace — Settings › Models › decision models
// (plan/phases/decision-provider-jev.md §7). Object schemas STRIP unknown keys,
// so the round trips below are deep-equal on fully populated values: a field
// dropped from a schema fails here instead of vanishing on the way to the page.

describe('decisions.list', () => {
  it('round-trips a provider row with an R6-downgraded site', () => {
    const value = {
      providers: [
        {
          id: 'typesafe',
          label: 'Jev',
          vendor: 'TypeSafe',
          configured: true,
          keyRef: 'providers/typesafe/apiKey',
          keyPresent: true,
          keyPreview: '…6789',
          model: 'jev-latest',
          baseUrl: 'https://api.typesafe.ai',
          host: 'api.typesafe.ai',
          getKeyUrl: 'https://console.typesafe.ai',
          sites: [
            { site: 'injection', requested: 'on', effective: 'shadow', missingThresholds: ['x'] },
            { site: 'approver', requested: 'off', effective: 'off', missingThresholds: [] },
          ],
        },
      ],
    };
    expect(DecisionsListOutput.parse(value)).toEqual(value);
  });

  it('refuses a provider it does not know', () => {
    expect(() => DecisionsListOutput.parse({ providers: [{ id: 'other' }] })).toThrow();
  });
});

describe('decisions.test', () => {
  it('round-trips a success with the redacted message', () => {
    const value = {
      ok: true,
      providerName: 'typesafe',
      model: 'jev-1.13.0',
      answer: { p: 0.97, confidence: 0.94, containsInstructions: true },
      latencyMs: 212,
      inputTokens: 38,
      estimatedCostUsd: 0.0000016,
      redactedMessage: '[REDACTED:aws-key]',
    };
    expect(DecisionsTestOutput.parse(value)).toEqual(value);
  });

  it('round-trips the service rate limit with its retry hint', () => {
    const value = { ok: false, code: 'rate_limited', message: 'wait', retryAfterSeconds: 7 };
    expect(DecisionsTestOutput.parse(value)).toEqual(value);
  });

  it('accepts every DecisionErrorCode plus no_key', () => {
    const codes = [
      'auth',
      'invalid',
      'rate_limited',
      'overloaded',
      'timeout',
      'aborted',
      'malformed',
      'too_large',
      'unavailable',
    ] as const satisfies readonly DecisionErrorCode[];
    expect([...DecisionTestErrorCodeSchema.options].sort()).toEqual([...codes, 'no_key'].sort());
  });

  it('bounds the message only at the transport limit — the 8k cap is the service answer', () => {
    expect(
      DecisionsTestInput.safeParse({ providerId: 'typesafe', message: 'x'.repeat(9000) }).success,
    ).toBe(true);
    expect(
      DecisionsTestInput.safeParse({ providerId: 'typesafe', message: 'x'.repeat(70_000) }).success,
    ).toBe(false);
  });
});
