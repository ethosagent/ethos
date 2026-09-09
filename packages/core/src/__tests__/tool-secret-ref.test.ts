import { describe, expect, it } from 'vitest';
import { resolveToolSecretRef } from '../tool-secret-ref';

// Pins the semantics documented in packages/core/src/tool-secret-ref.ts:
// per-rung `isValidSecretName` with fall-through. This is `engine_ask`'s
// original behaviour, adopted for x_search and the YouTube pair by
// plan/phases/search-console.md §13 PR0 — a deliberate behaviour change for
// those two, so these cases are the record of what was chosen.

const PREFIX = 'providers/xai/';
const DEFAULT_REF = 'providers/xai/apiKey';

function resolve(rungs: Array<{ secret?: string } | undefined>): string {
  return resolveToolSecretRef({ rungs, prefix: PREFIX, defaultRef: DEFAULT_REF });
}

describe('resolveToolSecretRef', () => {
  it('rung 1 wins when it names a valid secret', () => {
    expect(
      resolve([{ secret: 'from-file' }, { secret: 'from-slot' }, { secret: 'from-default' }]),
    ).toBe('providers/xai/from-file');
  });

  it('an EMPTY rung-1 secret falls through to rung 2, then rung 3', () => {
    expect(resolve([{ secret: '' }, { secret: 'from-slot' }, { secret: 'from-default' }])).toBe(
      'providers/xai/from-slot',
    );
    expect(resolve([{ secret: '' }, { secret: '' }, { secret: 'from-default' }])).toBe(
      'providers/xai/from-default',
    );
  });

  it('a name failing isValidSecretName falls through instead of escaping the prefix', () => {
    expect(resolve([{ secret: '../openai/apiKey' }, { secret: 'from-slot' }])).toBe(
      'providers/xai/from-slot',
    );
    expect(resolve([{ secret: 'has space' }, { secret: 'from-slot' }])).toBe(
      'providers/xai/from-slot',
    );
  });

  it('a whitespace-only name is treated as absent', () => {
    expect(resolve([{ secret: '   ' }, { secret: 'from-slot' }])).toBe('providers/xai/from-slot');
  });

  it('surrounding whitespace is trimmed off an otherwise valid name', () => {
    expect(resolve([{ secret: '  xai-main  ' }])).toBe('providers/xai/xai-main');
  });

  it('returns the default ref when every rung is absent', () => {
    expect(resolve([undefined, undefined, undefined])).toBe(DEFAULT_REF);
    expect(resolve([{}, {}, {}])).toBe(DEFAULT_REF);
    expect(resolve([])).toBe(DEFAULT_REF);
  });

  it('returns the default ref when every rung is present but invalid', () => {
    expect(resolve([{ secret: '../escape' }, { secret: 'has space' }, { secret: '' }])).toBe(
      DEFAULT_REF,
    );
  });

  it('skips an undefined rung and keeps going', () => {
    expect(resolve([undefined, { secret: 'from-slot' }, { secret: 'from-default' }])).toBe(
      'providers/xai/from-slot',
    );
  });
});
