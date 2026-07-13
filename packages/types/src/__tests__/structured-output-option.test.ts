import { describe, expect, it } from 'vitest';
import { structuredOutputOption } from '../llm';

describe('structuredOutputOption (§3)', () => {
  const schema = {
    type: 'object',
    properties: { meets: { type: 'boolean' } },
    required: ['meets'],
    additionalProperties: false,
  };

  it('builds the openai-compat providerOptions bag with defaults', () => {
    expect(structuredOutputOption(schema)).toEqual({
      'openai-compat': {
        responseFormat: { name: 'response', strict: true, schema },
      },
    });
  });

  it('honors an explicit name + strict', () => {
    expect(structuredOutputOption(schema, { name: 'verdict', strict: false })).toEqual({
      'openai-compat': {
        responseFormat: { name: 'verdict', strict: false, schema },
      },
    });
  });
});
