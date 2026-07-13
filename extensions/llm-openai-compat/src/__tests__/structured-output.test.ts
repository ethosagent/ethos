// §3 — grammar-constrained structured output: the transport maps a
// `providerOptions['openai-compat'].responseFormat` into the per-dialect
// request field, and the provider surfaces the capability from its profile.

import { structuredOutputOption } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { OpenAICompatProvider } from '../index';
import { buildChatCompletionsParams } from '../transport';

const SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { meets: { type: 'boolean' } },
  required: ['meets'],
  additionalProperties: false,
};

const OPTS = structuredOutputOption(SCHEMA, { name: 'verdict' });

describe('transport — structured output dialect mapping', () => {
  it('openai dialect (default) → response_format json_schema', () => {
    const { oaiParams } = buildChatCompletionsParams([], [], { providerOptions: OPTS }, 'gpt-4o');
    expect(oaiParams.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'verdict', strict: true, schema: SCHEMA },
    });
  });

  it('ollama dialect → top-level format schema', () => {
    const { oaiParams } = buildChatCompletionsParams(
      [],
      [],
      { providerOptions: OPTS },
      'llama3.2',
      {
        structuredOutputDialect: 'ollama',
      },
    );
    expect((oaiParams as unknown as Record<string, unknown>).format).toEqual(SCHEMA);
    expect(oaiParams.response_format).toBeUndefined();
  });

  it('vllm dialect → guided_json schema', () => {
    const { oaiParams } = buildChatCompletionsParams([], [], { providerOptions: OPTS }, 'qwen', {
      structuredOutputDialect: 'vllm',
    });
    expect((oaiParams as unknown as Record<string, unknown>).guided_json).toEqual(SCHEMA);
    expect(oaiParams.response_format).toBeUndefined();
  });

  it('no responseFormat → no structured-output field is set (unchanged)', () => {
    const { oaiParams } = buildChatCompletionsParams([], [], {}, 'gpt-4o');
    expect(oaiParams.response_format).toBeUndefined();
    expect((oaiParams as unknown as Record<string, unknown>).format).toBeUndefined();
    expect((oaiParams as unknown as Record<string, unknown>).guided_json).toBeUndefined();
  });

  it('malformed responseFormat (no schema object) → no field set', () => {
    const { oaiParams } = buildChatCompletionsParams(
      [],
      [],
      { providerOptions: { 'openai-compat': { responseFormat: { name: 'x' } } } },
      'gpt-4o',
    );
    expect(oaiParams.response_format).toBeUndefined();
  });
});

describe('OpenAICompatProvider — structured-output capability', () => {
  it('advertises capabilities.structuredOutput when the profile sets it', () => {
    const provider = new OpenAICompatProvider({
      name: 'ollama',
      apiKey: 'k',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3.2',
      structuredOutput: true,
    });
    expect(provider.capabilities.structuredOutput).toBe(true);
  });

  it('leaves capabilities.structuredOutput unset when the profile is absent', () => {
    const provider = new OpenAICompatProvider({
      name: 'ollama',
      apiKey: 'k',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3.2',
    });
    expect(provider.capabilities.structuredOutput).toBeUndefined();
  });
});
