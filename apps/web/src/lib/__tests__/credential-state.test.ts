import { describe, expect, it } from 'vitest';
import {
  type CredentialProbeInput,
  describeCredentialState,
  secretNameFromRef,
} from '../credential-state';

// Case 19 — describeCredentialState maps the probe onto the three states of
// §10.2 / D11, including that global-personality reads as overridden-here.

function probe(
  partial: Partial<CredentialProbeInput> & Pick<CredentialProbeInput, 'key'>,
): CredentialProbeInput {
  return {
    present: false,
    rung: 'tool-default',
    ref: `providers/xai/${partial.key}`,
    toolNames: ['x_search'],
    ...partial,
  };
}

describe('secretNameFromRef', () => {
  it('takes the last path segment', () => {
    expect(secretNameFromRef('providers/xai/seoMain')).toBe('seoMain');
    expect(secretNameFromRef('providers/dataforseo/apiKey')).toBe('apiKey');
  });

  it('returns undefined when there is no segment', () => {
    expect(secretNameFromRef('')).toBeUndefined();
    expect(secretNameFromRef('noslash')).toBeUndefined();
    expect(secretNameFromRef('trailing/')).toBeUndefined();
  });
});

describe('describeCredentialState', () => {
  it.each([
    {
      name: 'unset via present:false',
      input: probe({
        key: 'dataforseo',
        present: false,
        rung: 'tool-default',
        ref: 'providers/dataforseo/apiKey',
        toolNames: ['serp_lookup', 'keyword_metrics'],
      }),
      state: 'unset' as const,
      message: 'dataforseo needs a key. serp_lookup, keyword_metrics use it.',
      secretName: undefined,
    },
    {
      name: 'unset via origin',
      input: probe({
        key: 'x_search',
        present: true,
        rung: 'tool-default',
        origin: 'unset',
        ref: 'providers/xai/apiKey',
        toolNames: ['x_search'],
      }),
      state: 'unset' as const,
      message: 'x_search needs a key. x_search use it.',
      secretName: undefined,
    },
    {
      name: 'inherited from global-default',
      input: probe({
        key: 'engine_ask',
        present: true,
        rung: 'global-default',
        ref: 'providers/xai/seoMain',
        toolNames: ['engine_ask'],
      }),
      state: 'inherited' as const,
      message: 'Using the global key seoMain.',
      secretName: 'seoMain',
    },
    {
      name: 'inherited from tool-default',
      input: probe({
        key: 'engine_ask',
        present: true,
        rung: 'tool-default',
        origin: 'inherited',
        ref: 'providers/xai/apiKey',
        toolNames: ['engine_ask'],
      }),
      state: 'inherited' as const,
      message: 'Using the global key apiKey.',
      secretName: 'apiKey',
    },
    {
      name: 'overridden at personality rung',
      input: probe({
        key: 'web_search',
        present: true,
        rung: 'personality',
        ref: 'providers/exa/seoAcme',
        toolNames: ['web_search'],
      }),
      state: 'overridden' as const,
      message: 'This personality uses seoAcme.',
      secretName: 'seoAcme',
    },
    {
      name: 'global-personality is overridden, not inherited',
      input: probe({
        key: 'x_search',
        present: true,
        rung: 'global-personality',
        ref: 'providers/xai/builtInKey',
        toolNames: ['x_search'],
      }),
      state: 'overridden' as const,
      message: 'This personality uses builtInKey.',
      secretName: 'builtInKey',
    },
    {
      name: 'origin set-here wins over a global-default rung',
      input: probe({
        key: 'x_search',
        present: true,
        rung: 'global-default',
        origin: 'set-here',
        ref: 'providers/xai/forced',
        toolNames: ['x_search'],
      }),
      state: 'overridden' as const,
      message: 'This personality uses forced.',
      secretName: 'forced',
    },
  ])('$name', ({ input, state, message, secretName }) => {
    const described = describeCredentialState(input);
    expect(described.state).toBe(state);
    expect(described.message).toBe(message);
    expect(described.secretName).toBe(secretName);
  });
});
