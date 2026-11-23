// durable-background-jobs D9 — the completion notice of a job that was resumed
// says so; the resume itself sends nothing. Pins WakeReviews.buildWakeNotice.

import type { BackgroundJob } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { WakeReviews, type WakeReviewsDeps } from '../wake-review';

// buildWakeNotice only reads `deps.observability`; an empty deps object is enough.
const reviews = new WakeReviews({} as unknown as WakeReviewsDeps);

function job(over: Partial<BackgroundJob>): BackgroundJob {
  return {
    id: 'abcdef1234567890',
    owner: 'o',
    parentSessionKey: 'p',
    rootSessionKey: 'r',
    childSessionKey: 'c',
    depth: 1,
    status: 'done',
    prompt: 'x',
    spendUsd: 0,
    createdAt: 0,
    summary: 'all good',
    ...over,
  } as BackgroundJob;
}

describe('buildWakeNotice — resumed jobs', () => {
  it('a resumed done job says so after "finished"', () => {
    const text = reviews.buildWakeNotice(job({ resumeCount: 1, label: 'crawl' }));
    expect(
      text.startsWith('background job abcdef12 "crawl" finished (resumed after a restart)'),
    ).toBe(true);
  });

  it('a resumed failed job says so before the logs pointer', () => {
    const text = reviews.buildWakeNotice(job({ status: 'failed', error: 'boom', resumeCount: 2 }));
    expect(text).toContain('failed (resumed after a restart) — ethos process logs');
  });

  it('resumeCount 0 or undefined leaves the text unchanged', () => {
    expect(reviews.buildWakeNotice(job({ resumeCount: 0 }))).toMatch(
      /^background job abcdef12 finished\n/,
    );
    expect(reviews.buildWakeNotice(job({}))).toMatch(/^background job abcdef12 finished\n/);
  });

  it('an aborted job keeps its text', () => {
    const text = reviews.buildWakeNotice(job({ status: 'aborted', resumeCount: 2 }));
    expect(text).toBe(
      'background job abcdef12 was interrupted by a restart or config change — ask again to rerun',
    );
  });
});
