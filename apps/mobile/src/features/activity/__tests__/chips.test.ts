import { describe, expect, it } from 'vitest';
import { chipKey, HISTORY_PAGE, historyInput } from '../chips';

describe('activity chips', () => {
  it('the agent chip narrows the server query', () => {
    expect(historyInput({ kind: 'agent', personalityId: 'engineer' })).toEqual({
      personalityId: 'engineer',
      limit: 50,
    });
    expect(HISTORY_PAGE).toBe(50);
  });

  it('All agents omits the filter entirely', () => {
    const input = historyInput({ kind: 'all' });
    expect(input).toEqual({ limit: 50 });
    expect('personalityId' in input).toBe(false);
  });

  it('each chip is its own query key, so switching chips refetches rather than filtering a loaded array', () => {
    const keys = [
      chipKey({ kind: 'all' }),
      chipKey({ kind: 'agent', personalityId: 'engineer' }),
      chipKey({ kind: 'agent', personalityId: 'researcher' }),
    ];
    expect(new Set(keys).size).toBe(3);
    expect(chipKey({ kind: 'agent', personalityId: 'engineer' })).toBe('agent:engineer');
    expect(chipKey({ kind: 'all' })).toBe('all');
  });
});
