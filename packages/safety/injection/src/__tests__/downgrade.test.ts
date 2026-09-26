import { describe, expect, it } from 'vitest';
import { DOWNGRADE_REJECTION_MESSAGE, resolveDowngradedTools } from '../downgrade';

describe('resolveDowngradedTools', () => {
  it('returns the default set for `auto`', () => {
    const tools = resolveDowngradedTools('auto');
    expect(tools.has('terminal')).toBe(true);
    expect(tools.has('write_file')).toBe(true);
    expect(tools.has('browse_url')).toBe(true);
  });

  it('returns the default set for undefined (no config)', () => {
    expect(resolveDowngradedTools(undefined).has('terminal')).toBe(true);
  });

  it('returns the explicit list when provided', () => {
    const tools = resolveDowngradedTools(['only_this_tool']);
    expect(tools.has('only_this_tool')).toBe(true);
    expect(tools.has('terminal')).toBe(false);
    expect(tools.size).toBe(1);
  });

  it('returns an empty set when given an empty array', () => {
    const tools = resolveDowngradedTools([]);
    expect(tools.size).toBe(0);
  });
});

describe('DOWNGRADE_REJECTION_MESSAGE', () => {
  it('mentions the post-untrusted-read context', () => {
    expect(DOWNGRADE_REJECTION_MESSAGE).toMatch(/untrusted/i);
  });

  // A goal attempt never gets a user message; the old text told the model to
  // wait for one, and the goal gave up. The pause lifts after N model steps.
  it('states the automatic expiry, not a user-message requirement', () => {
    expect(DOWNGRADE_REJECTION_MESSAGE).not.toMatch(/user message/i);
    expect(DOWNGRADE_REJECTION_MESSAGE).toMatch(/lifts on its own/i);
    expect(DOWNGRADE_REJECTION_MESSAGE).toMatch(/retry/i);
  });
});
