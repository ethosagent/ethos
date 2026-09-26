import type { Session } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import { branchOptions } from '../BranchSwitcher';

function fork(id: string, createdAt: string, title: string | null = null): Session {
  return {
    id,
    key: `web:${id}`,
    platform: 'web',
    model: 'm',
    provider: 'p',
    personalityId: null,
    parentSessionId: 'origin',
    workingDir: null,
    title,
    pinned: false,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      estimatedCostUsd: 0,
      apiCallCount: 0,
      compactionCount: 0,
    },
    createdAt,
    updatedAt: createdAt,
    version: 1,
  } as Session;
}

describe('branchOptions', () => {
  it('is empty until the session has a fork — the switcher stays hidden', () => {
    expect(branchOptions('origin', [])).toEqual([]);
  });

  it('numbers origin 1 and forks oldest first, as /branches does', () => {
    const options = branchOptions('origin', [
      fork('late', '2026-09-24T10:00:02.000Z'),
      fork('early', '2026-09-24T10:00:01.000Z', 'Try B'),
    ]);
    expect(options).toEqual([
      { value: 'origin', label: '1 · origin' },
      { value: 'early', label: '2 · Try B' },
      { value: 'late', label: '3 · fork' },
    ]);
  });
});
