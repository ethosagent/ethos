import { describe, expect, it } from 'vitest';
import { contract } from '../index';

// `plugins.install` carries an optional `personalityId` — the RPC form of
// `ethos plugin install --personality <id>`. Present, the install also writes that
// personality's `plugins.lock` entry; absent, it records only the grant. No current
// web caller sends it. The id
// becomes a path segment under `personalities/`, so a non-plain identifier is
// refused here, before the handler (and npm) ever runs.

const schema = contract.plugins.install['~orpc'].inputSchema;

describe('plugins.install input', () => {
  it('accepts an input without a personalityId', () => {
    expect(schema?.['~standard'].validate({ packageSpec: 'my-plugin' })).toEqual({
      value: { packageSpec: 'my-plugin' },
    });
  });

  it('accepts a plain personalityId', () => {
    expect(
      schema?.['~standard'].validate({ packageSpec: 'my-plugin', personalityId: 'researcher' }),
    ).toEqual({ value: { packageSpec: 'my-plugin', personalityId: 'researcher' } });
  });

  it.each([
    ['a path traversal', '../evil'],
    ['a nested path', 'a/b'],
    ['an empty string', ''],
    ['a leading dot', '.hidden'],
    ['whitespace', 'my personality'],
    ['an over-long id', 'a'.repeat(215)],
  ])('rejects %s', (_label, personalityId) => {
    const result = schema?.['~standard'].validate({ packageSpec: 'my-plugin', personalityId });
    expect(result).toHaveProperty('issues');
  });
});
