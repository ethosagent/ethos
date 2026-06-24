import { describe, expect, it } from 'vitest';
import { intersectToolGrants } from '../index';

describe('intersectToolGrants', () => {
  it('returns personalityToolset when commandTools is undefined', () => {
    const result = intersectToolGrants(undefined, ['read_file', 'bash']);
    expect(result).toEqual(['read_file', 'bash']);
  });

  it('returns commandTools when personalityToolset is undefined', () => {
    const result = intersectToolGrants(['read_file', 'bash'], undefined);
    expect(result).toEqual(['read_file', 'bash']);
  });

  it('returns undefined when both are undefined', () => {
    const result = intersectToolGrants(undefined, undefined);
    expect(result).toBeUndefined();
  });

  it('returns intersection of both sets', () => {
    const result = intersectToolGrants(
      ['read_file', 'bash', 'web_search'],
      ['read_file', 'write_file', 'bash'],
    );
    expect(result).toEqual(['read_file', 'bash']);
  });

  it('returns empty array when no overlap', () => {
    const result = intersectToolGrants(['web_search'], ['read_file', 'bash']);
    expect(result).toEqual([]);
  });
});
