// CLI chat's background-completion notice ignores `deliver` (plan
// openclaw-9.5-adoption item 6, D29): the parent review turn is a gateway
// feature, and in the REPL the user is already in the parent session.

import type { BackgroundJob, JobSteer } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { backgroundCompletionLines } from '../chat';

function job(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    id: 'job-1234abcd-rest',
    owner: 'proc-1',
    parentSessionKey: 'cli:repo',
    rootSessionKey: 'cli:repo',
    childSessionKey: 'cli:repo:job:task:1',
    depth: 1,
    status: 'done',
    prompt: 'check the build',
    summary: 'all green',
    spendUsd: 0,
    createdAt: 0,
    ...overrides,
  };
}

describe('CLI chat — background completion notice', () => {
  it("renders a deliver: 'parent' job exactly like a 'user' one", () => {
    const user = backgroundCompletionLines(job({ deliver: 'user' }));
    expect(user).toEqual(['╭─ background [bg:job-1234] done', '│ all green', '╰─']);
    expect(backgroundCompletionLines(job({ deliver: 'parent' }))).toEqual(user);
    expect(backgroundCompletionLines(job())).toEqual(user);
  });

  it('stays silent for an aborted job and shows the error for a failed one', () => {
    expect(backgroundCompletionLines(job({ status: 'aborted' }))).toBeNull();
    expect(backgroundCompletionLines(job({ status: 'failed', error: 'boom' }))?.[0]).toBe(
      '╭─ background [bg:job-1234] error: boom',
    );
  });

  it('appends unread steers before the footer, capped at 3 lines of 120 chars plus a count', () => {
    const steer = (id: number, text: string): JobSteer => ({
      id,
      jobId: 'job-1234abcd-rest',
      text,
      state: 'unread',
      source: 'cli',
      createdAt: 0,
    });
    const lines = backgroundCompletionLines(job(), [
      steer(1, 'skip the tests'),
      steer(2, 'x'.repeat(300)),
      steer(3, 'third'),
      steer(4, 'fourth'),
      steer(5, 'fifth'),
    ]);
    expect(lines?.slice(0, 2)).toEqual(['╭─ background [bg:job-1234] done', '│ all green']);
    expect(lines?.[2]).toBe('│ unread steer: skip the tests');
    expect(lines?.[3]).toBe(`│ unread steer: ${'x'.repeat(119)}…`);
    expect(lines?.[4]).toBe('│ unread steer: third');
    expect(lines?.[5]).toBe('│ ... and 2 more unread steers');
    expect(lines?.at(-1)).toBe('╰─');
  });

  it('renders no steer lines when there are none', () => {
    expect(backgroundCompletionLines(job(), [])).toEqual([
      '╭─ background [bg:job-1234] done',
      '│ all green',
      '╰─',
    ]);
  });
});
