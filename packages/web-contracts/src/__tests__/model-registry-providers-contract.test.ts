import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { contract } from '../index';

// The chain import (D11a) and provider-entry writes on the `modelRegistry`
// namespace, plus `config.update`'s `adoptedModels`. Zod objects STRIP unknown
// keys, so every assertion is a round trip: a dropped field fails the deep-equal.

function schemaOf(procedure: unknown, field: 'inputSchema' | 'outputSchema'): z.ZodType {
  const def = (procedure as { '~orpc'?: Record<string, unknown> })['~orpc'];
  const schema = def?.[field];
  if (!(schema instanceof z.ZodType)) throw new Error(`contract has no ${field}`);
  return schema;
}

const roundTrips = (schema: z.ZodType, value: unknown) =>
  expect(schema.parse(value)).toEqual(value);

const refusal = {
  ok: false,
  code: 'referenced',
  message: 'Provider entry "local" is used by the model qwen.',
  problems: [],
  aliases: ['qwen'],
};

describe('modelRegistry.list chainModels', () => {
  const listOut = schemaOf(contract.modelRegistry.list, 'outputSchema');
  const listing = {
    chainModels: [
      {
        providerKey: 'codex-gpt-terra',
        index: 0,
        provider: 'codex',
        modelId: 'gpt-5.6-terra',
        suggestedAlias: 'gpt-5-6-terra',
        idIsExplicit: true,
      },
    ],
    entries: [],
    default: null,
    roles: { trivial: null, default: null, deep: null, dreaming: null },
    providerEntries: [],
    routing: {},
    problems: [],
  };

  it('round-trips a chain model and requires the field', () => {
    roundTrips(listOut, listing);
    const { chainModels: _dropped, ...without } = listing;
    expect(() => listOut.parse(without)).toThrow();
  });
});

describe('modelRegistry.list providerEntries', () => {
  const listOut = schemaOf(contract.modelRegistry.list, 'outputSchema');
  const view = {
    key: 'bedrock-us',
    index: 1,
    provider: 'bedrock',
    id: 'bedrock-us',
    explicitId: true,
    model: null,
    failover: true,
    apiVersion: null,
    region: 'us-west-2',
    awsProfile: 'sso-dev',
    credential: 'not_needed',
    referenceable: true,
    reason: null,
  };
  const listing = (entry: Record<string, unknown>) => ({
    chainModels: [],
    entries: [],
    default: null,
    roles: { trivial: null, default: null, deep: null, dreaming: null },
    providerEntries: [entry],
    routing: {},
    problems: [],
  });

  it('round-trips apiVersion, region and awsProfile, each nullable and required', () => {
    roundTrips(listOut, listing(view));
    roundTrips(listOut, listing({ ...view, provider: 'azure', apiVersion: '2024-10-21' }));
    for (const field of ['apiVersion', 'region', 'awsProfile']) {
      const without = Object.fromEntries(Object.entries(view).filter(([k]) => k !== field));
      expect(() => listOut.parse(listing(without)), field).toThrow();
    }
  });

  it('carries no key field: a stray apiKey is stripped, never passed through', () => {
    const parsed = listOut.parse(listing({ ...view, apiKey: 'sk-secret' }));
    expect(JSON.stringify(parsed)).not.toContain('sk-secret');
  });
});

describe('modelRegistry.importChain', () => {
  const input = schemaOf(contract.modelRegistry.importChain, 'inputSchema');
  const output = schemaOf(contract.modelRegistry.importChain, 'outputSchema');

  it('takes an optional provider-key filter', () => {
    roundTrips(input, {});
    roundTrips(input, { providerKeys: ['codex-gpt-terra'] });
    expect(() => input.parse({ providerKeys: [''] })).toThrow();
  });

  it('answers what was adopted, or a registry refusal', () => {
    roundTrips(output, {
      ok: true,
      adopted: [
        { alias: 'gpt-5-6-terra', providerKey: 'codex-gpt-terra', modelId: 'gpt-5.6-terra' },
      ],
      defaultSet: 'gpt-5-6-terra',
      idsWritten: ['openai-1'],
    });
    roundTrips(output, {
      ok: false,
      code: 'config_missing',
      message: 'No config found.',
      problems: [],
      referents: [],
    });
  });
});

describe('config.update adoptedModels', () => {
  const output = schemaOf(contract.config.update, 'outputSchema');

  it('is optional and round-trips when present', () => {
    roundTrips(output, { ok: true });
    roundTrips(output, {
      ok: true,
      adoptedModels: [{ alias: 'gpt-4o', providerKey: 'openai', modelId: 'gpt-4o' }],
    });
  });
});

describe('modelRegistry provider writes', () => {
  it('addProvider takes a provider with its models and answers the final aliases', () => {
    const input = schemaOf(contract.modelRegistry.addProvider, 'inputSchema');
    const output = schemaOf(contract.modelRegistry.addProvider, 'outputSchema');
    roundTrips(input, {
      provider: 'openrouter',
      id: 'router',
      apiKey: 'sk-router',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiVersion: '2024-10-21',
      region: 'us-east-1',
      awsProfile: 'sso',
      failover: false,
      models: [
        { modelId: 'meta/llama-4' },
        {
          modelId: 'qwen',
          alias: 'qwen-router',
          label: 'via router',
          contextWindow: 131072,
          costPer1kInput: 0.001,
          costPer1kOutput: 0.002,
        },
      ],
    });
    expect(() => input.parse({ provider: 'openrouter', id: 'router' })).toThrow();
    roundTrips(output, {
      ok: true,
      providerKey: 'router',
      index: 3,
      models: [{ alias: 'meta-llama-4', providerKey: 'router', modelId: 'meta/llama-4' }],
    });
    roundTrips(output, { ...refusal, code: 'duplicate_id', aliases: [] });
  });

  it('the key-addressed writes take their inputs and share one output', () => {
    const inputs: Array<[unknown, unknown]> = [
      [
        contract.modelRegistry.updateProvider,
        { key: 'local', apiKey: 'sk', baseUrl: '', apiVersion: 'v', region: '', awsProfile: 'p' },
      ],
      [contract.modelRegistry.removeProvider, { key: 'local' }],
      [contract.modelRegistry.moveProvider, { key: 'local', direction: 'up' }],
      [contract.modelRegistry.setProviderFailover, { key: 'local', failover: false }],
      [contract.modelRegistry.setFallbackModel, { key: 'local', alias: 'qwen' }],
      [contract.modelRegistry.setFallbackModel, { key: 'local', alias: null }],
    ];
    for (const [procedure, value] of inputs) {
      roundTrips(schemaOf(procedure, 'inputSchema'), value);
      const output = schemaOf(procedure, 'outputSchema');
      roundTrips(output, { ok: true, providerKey: 'local', index: 1 });
      roundTrips(output, refusal);
    }
    const move = schemaOf(contract.modelRegistry.moveProvider, 'inputSchema');
    expect(() => move.parse({ key: 'local', direction: 'sideways' })).toThrow();
    const remove = schemaOf(contract.modelRegistry.removeProvider, 'inputSchema');
    expect(() => remove.parse({ key: '' })).toThrow();
    const out = schemaOf(contract.modelRegistry.removeProvider, 'outputSchema');
    expect(() => out.parse({ ...refusal, code: 'nope' })).toThrow();
  });

  it('every refusal code the service can answer is in the contract', () => {
    const out = schemaOf(contract.modelRegistry.removeProvider, 'outputSchema');
    for (const code of [
      'config_missing',
      'unknown_provider',
      'invalid_provider',
      'invalid_id',
      'duplicate_id',
      'invalid_model',
      'duplicate_alias',
      'referenced',
      'last_provider',
      'cannot_move',
      'not_in_chain',
      'unknown_alias',
      'cross_provider_alias',
    ]) {
      roundTrips(out, { ...refusal, code });
    }
  });

  it('testProvider takes a provider key and answers the model-test union', () => {
    const input = schemaOf(contract.modelRegistry.testProvider, 'inputSchema');
    const output = schemaOf(contract.modelRegistry.testProvider, 'outputSchema');
    roundTrips(input, { providerKey: 'anthropic-work' });
    expect(() => input.parse({ providerKey: '' })).toThrow();
    roundTrips(output, {
      state: 'ok',
      providerKey: 'anthropic-work',
      provider: 'anthropic',
      modelId: 'claude-sonnet-5',
      latencyMs: 12,
    });
    roundTrips(output, {
      state: 'unconfigured',
      providerKey: 'openai-2',
      reason: 'no model to probe with',
      fix: 'Add a model.',
    });
    roundTrips(output, { state: 'rate_limited', providerKey: 'x', retryAfterSeconds: 9 });
  });
});
