// A config.yaml with no `model:` line resolves to the same model setup,
// desktop and the catalog call the Anthropic default (`getDefaultModel`).
// packages/config cannot import the catalog (it sits below wiring), so the
// literal in `parseConfigYaml` is pinned here instead.

import { parseConfigYaml } from '@ethosagent/config';
import { describe, expect, it } from 'vitest';
import { getDefaultModel } from '../model-catalog';

describe('parseConfigYaml default model', () => {
  it('matches the catalog Anthropic default when no model is configured', () => {
    const expected = getDefaultModel('anthropic')?.modelId;
    expect(expected).toBe('claude-opus-5-5');
    expect(parseConfigYaml('provider: anthropic\n').model).toBe(expected);
    expect(parseConfigYaml('').model).toBe(expected);
  });
});
