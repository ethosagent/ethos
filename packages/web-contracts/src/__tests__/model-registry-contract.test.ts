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
  it('mounts on the root contract with the T1.24 test and the T2.2 members', () => {
    // T2.2 EXTENDS the namespace T1.24 created, rather than creating another.
    expect(Object.keys(contract.modelRegistry)).toEqual([
      'list',
      'upsert',
      'setDefault',
      'setRole',
      'setRouting',
      'remove',
      'test',
      'testAll',
      'importChain',
      'addProvider',
      'updateProvider',
      'removeProvider',
      'moveProvider',
      'setProviderFailover',
      'setFallbackModel',
      'testProvider',
    ]);
  });

  it('takes an alias, or an unsaved providerKey + modelId, and refuses an empty one', () => {
    expect(testIn.parse({ alias: 'opus' })).toEqual({ alias: 'opus' });
    expect(testIn.parse({ providerKey: 'local', modelId: 'qwen3' })).toEqual({
      providerKey: 'local',
      modelId: 'qwen3',
    });
    expect(() => testIn.parse({ alias: '' })).toThrow();
    expect(() => testIn.parse({ providerKey: 'local', modelId: '' })).toThrow();
    expect(() => testIn.parse({})).toThrow();
  });
});

describe('modelRegistry writes and listing', () => {
  const listOut = schemaOf(contract.modelRegistry.list, 'outputSchema');
  const upsertIn = schemaOf(contract.modelRegistry.upsert, 'inputSchema');
  const writeOut = schemaOf(contract.modelRegistry.upsert, 'outputSchema');
  const setRoleIn = schemaOf(contract.modelRegistry.setRole, 'inputSchema');
  const setRoutingIn = schemaOf(contract.modelRegistry.setRouting, 'inputSchema');
  const removeIn = schemaOf(contract.modelRegistry.remove, 'inputSchema');
  const removeOut = schemaOf(contract.modelRegistry.remove, 'outputSchema');
  const testAllOut = schemaOf(contract.modelRegistry.testAll, 'outputSchema');

  const referents = [
    { kind: 'personality', personalityId: 'reviewer', field: 'model', readOnly: false },
    { kind: 'personality', personalityId: 'engineer', field: 'model.deep', readOnly: true },
    { kind: 'role', role: 'deep' },
    { kind: 'default' },
    { kind: 'routing', personalityId: 'writer' },
    { kind: 'fallback', alias: 'opus-batch' },
  ];

  it('round-trips a full listing, credential status and referents included', () => {
    const value = {
      chainModels: [],
      entries: [
        {
          alias: 'opus',
          providerKey: 'anthropic-work',
          modelId: 'claude-opus-5',
          label: 'deep work',
          contextWindow: 200000,
          costPer1kInput: 0.015,
          costPer1kOutput: 0.075,
          fallbacks: [],
          credential: 'set',
          referents,
        },
        {
          alias: 'qwen',
          providerKey: 'local',
          modelId: 'qwen2.5-coder:32b',
          label: null,
          contextWindow: null,
          costPer1kInput: null,
          costPer1kOutput: null,
          fallbacks: [],
          credential: 'not_needed',
          referents: [],
        },
      ],
      default: 'opus',
      roles: { trivial: null, default: null, deep: 'opus', dreaming: null },
      providerEntries: [
        {
          key: 'openai-2',
          index: 2,
          provider: 'openai',
          id: null,
          explicitId: false,
          model: null,
          failover: true,
          apiVersion: null,
          region: null,
          awsProfile: null,
          credential: 'missing',
          referenceable: false,
          reason: 'Provider entry "openai-2" has no explicit id.',
        },
      ],
      routing: { writer: 'opus' },
      problems: [
        {
          code: 'derived_provider_key',
          alias: 'gpt',
          key: 'modelRegistry.gpt.provider',
          message: 'Model "gpt" names a derived key.',
          fix: 'providers.2.id: openai-2',
        },
      ],
    };
    expect(listOut.parse(value)).toEqual(value);
  });

  it('upsert takes create|update and leaves emptiness to the validator, not to the schema', () => {
    const value = {
      mode: 'create',
      alias: 'qwen',
      provider: '',
      modelId: '',
      contextWindow: 131072,
    };
    expect(upsertIn.parse(value)).toEqual(value);
    expect(() => upsertIn.parse({ ...value, mode: 'rename' })).toThrow();
    expect(() => upsertIn.parse({ ...value, alias: '' })).toThrow();
  });

  it('a refusal is a value carrying its problems and referents, beside `{ ok: true }`', () => {
    expect(writeOut.parse({ ok: true })).toEqual({ ok: true });
    const refusal = {
      ok: false,
      code: 'referenced',
      message: '"opus" is used by 6 referents.',
      problems: [],
      referents,
    };
    expect(writeOut.parse(refusal)).toEqual(refusal);
    expect(removeOut.parse(refusal)).toEqual(refusal);
  });

  it('setRole binds three roles and null deletes; `default` is setDefault, not a role binding', () => {
    expect(setRoleIn.parse({ role: 'deep', alias: null })).toEqual({ role: 'deep', alias: null });
    expect(() => setRoleIn.parse({ role: 'default', alias: 'opus' })).toThrow();
    expect(setRoutingIn.parse({ personalityId: 'writer', declaration: null })).toEqual({
      personalityId: 'writer',
      declaration: null,
    });
  });

  it('remove takes repointTo or force, and reports what it rewrote and what still needs attention', () => {
    expect(removeIn.parse({ alias: 'opus', repointTo: 'sonnet' })).toEqual({
      alias: 'opus',
      repointTo: 'sonnet',
    });
    const done = {
      ok: true,
      alias: 'opus',
      repointedTo: 'sonnet',
      rewritten: referents.slice(0, 1),
      needsAttention: referents.slice(1, 2),
    };
    expect(removeOut.parse(done)).toEqual(done);
  });

  it('testAll carries one outcome per provider entry, with an unsaved-style outcome allowed', () => {
    const value = {
      results: [
        {
          providerKey: 'local',
          aliases: ['qwen'],
          outcome: { state: 'rate_limited', alias: 'qwen', retryAfterSeconds: 3 },
        },
      ],
    };
    expect(testAllOut.parse(value)).toEqual(value);
    const unsaved = {
      state: 'ok',
      providerKey: 'local',
      provider: 'ollama',
      modelId: 'x',
      latencyMs: 1,
    };
    expect(testOut.parse(unsaved)).toEqual(unsaved);
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
