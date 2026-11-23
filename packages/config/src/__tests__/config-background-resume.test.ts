import { describe, expect, it } from 'vitest';
import {
  backgroundDefaults,
  backgroundToLines,
  buildBackgroundConfig,
} from '../builders/cron-background';

// durable-background-jobs L6 — `background.resume_on_restart`, `max_resumes`,
// `resume_ttl_ms`. config.yaml only; no settings UI.

describe('background resume config', () => {
  it('defaults: resume on, three automatic resumes, a day to wait for a successor', () => {
    expect(backgroundDefaults()).toMatchObject({
      resumeOnRestart: true,
      maxResumes: 3,
      resumeTtlMs: 86_400_000,
    });
  });

  it('parses the three keys', () => {
    expect(
      buildBackgroundConfig(
        { resume_on_restart: 'false', max_resumes: '1', resume_ttl_ms: '60000' },
        {},
      ),
    ).toEqual({ resumeOnRestart: false, maxResumes: 1, resumeTtlMs: 60_000 });
  });

  it('leaves them unset when absent, and round-trips through backgroundToLines', () => {
    expect(buildBackgroundConfig({}, {})).toBeUndefined();
    const parsed = buildBackgroundConfig(
      { resume_on_restart: 'true', max_resumes: '2', resume_ttl_ms: '5000' },
      {},
    );
    expect(parsed).toBeDefined();
    const lines = backgroundToLines(parsed ?? {});
    expect(Object.fromEntries(lines)).toEqual({
      resume_on_restart: 'true',
      max_resumes: '2',
      resume_ttl_ms: '5000',
    });
    expect(buildBackgroundConfig(Object.fromEntries(lines), {})).toEqual(parsed);
  });
});
