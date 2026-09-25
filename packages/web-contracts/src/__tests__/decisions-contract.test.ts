import type { DecisionErrorCode } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  contract,
  DecisionsListOutput,
  DecisionsTestInput,
  DecisionsTestOutput,
  DecisionTestErrorCodeSchema,
  PersonalitySchema,
} from '../index';

// The `decisions` namespace — Settings › Models › decision models
// (plan/phases/decision-provider-jev.md §7). Object schemas STRIP unknown keys,
// so the round trips below are deep-equal on fully populated values: a field
// dropped from a schema fails here instead of vanishing on the way to the page.

describe('decisions.list', () => {
  it('round-trips the catalog and a provider row whose usedBy carries an R6-downgraded site', () => {
    const value = {
      catalog: [
        {
          id: 'typesafe',
          label: 'Jev',
          vendor: 'TypeSafe',
          description: 'Answers typed questions with a probability.',
          getKeyUrl: 'https://console.typesafe.ai',
          keyRef: 'providers/typesafe/apiKey',
          defaultModel: 'jev-latest',
          defaultBaseUrl: 'https://api.typesafe.ai',
        },
      ],
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
          usedBy: [
            {
              personalityId: 'researcher',
              name: 'Researcher',
              sites: [
                {
                  site: 'approver',
                  requested: 'on',
                  effective: 'shadow',
                  reason: 'threshold-missing',
                  missingThresholds: ['decisions.thresholds.approver.deny'],
                },
                {
                  site: 'injection',
                  requested: 'shadow',
                  effective: 'shadow',
                  missingThresholds: [],
                },
              ],
            },
            { personalityId: 'coder', name: 'Coder', sites: [] },
          ],
        },
      ],
    };
    expect(DecisionsListOutput.parse(value)).toEqual(value);
  });

  it('round-trips the empty state: a catalog and no added provider', () => {
    const value = { catalog: [], providers: [] };
    expect(DecisionsListOutput.parse(value)).toEqual(value);
  });

  it('requires usedBy, and refuses a site reason it does not know', () => {
    const row = {
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
    };
    expect(DecisionsListOutput.safeParse({ catalog: [], providers: [row] }).success).toBe(false);
    const site = { site: 'router', requested: 'on', effective: 'off', missingThresholds: [] };
    const withReason = (reason: string) => ({
      catalog: [],
      providers: [
        { ...row, usedBy: [{ personalityId: 'r', name: 'R', sites: [{ ...site, reason }] }] },
      ],
    });
    expect(DecisionsListOutput.safeParse(withReason('not-configured')).success).toBe(true);
    expect(DecisionsListOutput.safeParse(withReason('no-key')).success).toBe(false);
  });

  it('refuses a provider it does not know', () => {
    expect(() =>
      DecisionsListOutput.parse({ catalog: [], providers: [{ id: 'other' }] }),
    ).toThrow();
  });

  it('requires the catalog', () => {
    expect(DecisionsListOutput.safeParse({ providers: [] }).success).toBe(false);
  });
});

describe('decisions.remove', () => {
  // Reached through the contract, the way `backup-contract.test.ts` does.
  function schemaOf(procedure: unknown, field: 'inputSchema' | 'outputSchema'): z.ZodType {
    const def = (procedure as { '~orpc'?: Record<string, unknown> })['~orpc'];
    const schema = def?.[field];
    if (!(schema instanceof z.ZodType)) throw new Error(`decisions.remove has no ${field}`);
    return schema;
  }

  it('takes a known provider id and answers whether the provider line went', () => {
    const input = schemaOf(contract.decisions.remove, 'inputSchema');
    const output = schemaOf(contract.decisions.remove, 'outputSchema');
    expect(input.safeParse({ providerId: 'typesafe' }).success).toBe(true);
    expect(input.safeParse({ providerId: 'other' }).success).toBe(false);
    const value = { ok: true, providerRemoved: true };
    expect(output.parse(value)).toEqual(value);
    expect(output.safeParse({ ok: true }).success).toBe(false);
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
      'breaker_open',
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

// `PersonalityConfig.decisions` on the personality wire and in
// `personalities.update` (plan decision-provider-personality §9).
describe('personalities.decisions', () => {
  function schemaOf(procedure: unknown, field: 'inputSchema' | 'outputSchema'): z.ZodType {
    const def = (procedure as { '~orpc'?: Record<string, unknown> })['~orpc'];
    const schema = def?.[field];
    if (!(schema instanceof z.ZodType)) throw new Error(`no ${field}`);
    return schema;
  }

  it('the personality wire round-trips the declaration and the resolved sites', () => {
    const decisions = {
      provider: 'somewhere-else',
      sites: { injection: 'shadow', approver: 'on' },
      resolved: {
        configured: false,
        sites: [
          {
            site: 'injection',
            requested: 'shadow',
            effective: 'off',
            reason: 'not-configured',
            missingThresholds: [],
          },
          {
            site: 'approver',
            requested: 'on',
            effective: 'off',
            reason: 'not-configured',
            missingThresholds: [],
            inertApprovalMode: 'manual',
          },
        ],
      },
    };
    // A stored provider this machine does not know is carried verbatim.
    expect(PersonalitySchema.shape.decisions.parse(decisions)).toEqual(decisions);
    expect(PersonalitySchema.shape.decisions.parse(undefined)).toBeUndefined();
  });

  it('update accepts a catalog provider or "" and per-site modes', () => {
    const input = schemaOf(contract.personalities.update, 'inputSchema');
    const ok = (decisions: unknown) => input.safeParse({ id: 'agent', decisions }).success;
    expect(ok({ provider: 'typesafe', sites: { injection: 'on', approver: 'shadow' } })).toBe(true);
    expect(ok({ provider: '' })).toBe(true);
    expect(ok({ sites: { router: 'off' } })).toBe(true);
    expect(ok(undefined)).toBe(true);
  });

  it('update refuses an unknown provider, mode, site or key', () => {
    const input = schemaOf(contract.personalities.update, 'inputSchema');
    const ok = (decisions: unknown) => input.safeParse({ id: 'agent', decisions }).success;
    expect(ok({ provider: 'openai' })).toBe(false);
    expect(ok({ sites: { injection: 'always' } })).toBe(false);
    expect(ok({ sites: { summarizer: 'on' } })).toBe(false);
    expect(ok({ provider: 'typesafe', model: 'jev-latest' })).toBe(false);
  });
});
