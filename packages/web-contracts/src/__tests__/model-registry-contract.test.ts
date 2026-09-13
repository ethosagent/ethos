import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { contract, ModelRegistryTestOutput } from '../index';

// The `modelRegistry` namespace (T1.24 of plan/phases/model-registry.md).
//
// Zod object schemas STRIP unknown keys rather than rejecting them, so an
// omission here is silent: the handler returns a field, the schema drops it,
// and the browser never sees it with nothing thrown anywhere. Every assertion
// below is therefore a ROUND TRIP — a dropped field fails the deep-equal.

function schemaOf(procedure: unknown, field: 'inputSchema' | 'outputSchema'): z.ZodType {
  const def = (procedure as { '~orpc'?: Record<string, unknown> })['~orpc'];
  const schema = def?.[field];
  if (!(schema instanceof z.ZodType)) throw new Error(`contract has no ${field}`);
  return schema;
}

const testIn = schemaOf(contract.modelRegistry.test, 'inputSchema');
const testOut = schemaOf(contract.modelRegistry.test, 'outputSchema');

describe('modelRegistry namespace', () => {
  it('mounts on the root contract with `test` as its only member', () => {
    // T2.2 extends this namespace with list/upsert/remove/setDefault/setRole —
    // it must EXTEND what T1.24 created, not create it a second time.
    expect(Object.keys(contract.modelRegistry)).toEqual(['test']);
  });

  it('takes an alias and refuses an empty one', () => {
    expect(testIn.parse({ alias: 'opus' })).toEqual({ alias: 'opus' });
    expect(() => testIn.parse({ alias: '' })).toThrow();
    expect(() => testIn.parse({})).toThrow();
  });
});

describe('modelRegistry.test output', () => {
  it('round-trips a pass with its latency and echoed model', () => {
    const value = {
      state: 'ok',
      alias: 'opus',
      providerKey: 'anthropic-work',
      provider: 'anthropic',
      modelId: 'claude-opus-5',
      latencyMs: 340,
      echoedModel: 'claude-opus-5-20260114',
    };
    expect(testOut.parse(value)).toEqual(value);
  });

  it('accepts a pass with no echoed model — the absent case is the common one', () => {
    const value = {
      state: 'ok',
      alias: 'opus',
      providerKey: 'anthropic-work',
      provider: 'anthropic',
      modelId: 'claude-opus-5',
      latencyMs: 12,
    };
    expect(testOut.parse(value)).toEqual(value);
  });

  it('round-trips the vendor body unaltered, however long', () => {
    const error = `401 {"error":{"message":"invalid x-api-key"}}\n${'z'.repeat(20_000)}`;
    const value = {
      state: 'rejected',
      alias: 'opus',
      providerKey: 'anthropic-work',
      provider: 'anthropic',
      modelId: 'claude-opus-5',
      error,
      fix: 'Replace the key on provider entry "anthropic-work".',
    };
    const parsed = testOut.parse(value) as { error: string };
    expect(parsed).toEqual(value);
    // The one property the schema must never quietly acquire: a length cap.
    expect(parsed.error.length).toBe(error.length);
  });

  it('keeps unreachable a distinct state, never a flavour of rejected', () => {
    const value = {
      state: 'unreachable',
      alias: 'opus',
      providerKey: 'anthropic-work',
      provider: 'anthropic',
      modelId: 'claude-opus-5',
      error: 'timed out after 10s',
    };
    expect(testOut.parse(value)).toEqual(value);
    expect(() => testOut.parse({ ...value, state: 'nope' })).toThrow();
  });

  it('round-trips the unconfigured state, with and without a fix', () => {
    const bare = { state: 'unconfigured', alias: 'opus', reason: 'No registry alias "opus".' };
    expect(testOut.parse(bare)).toEqual(bare);
    const withFix = { ...bare, fix: 'Set `providers.<n>.id` on the entry.' };
    expect(testOut.parse(withFix)).toEqual(withFix);
  });

  it('carries the refusal as a STATE with the seconds remaining, not as an error', () => {
    // The 10s limit is enforced in the handler (D19), so a refusal is a normal
    // answer the UI renders — not a thrown ORPCError the client has to catch.
    const value = { state: 'rate_limited', alias: 'opus', retryAfterSeconds: 8 };
    expect(testOut.parse(value)).toEqual(value);
    expect(() => testOut.parse({ state: 'rate_limited', alias: 'opus' })).toThrow();
  });

  it('is exported so a host can validate what it returns', () => {
    expect(ModelRegistryTestOutput).toBeDefined();
    expect(
      ModelRegistryTestOutput.parse({ state: 'rate_limited', alias: 'a', retryAfterSeconds: 1 }),
    ).toEqual({ state: 'rate_limited', alias: 'a', retryAfterSeconds: 1 });
  });
});
