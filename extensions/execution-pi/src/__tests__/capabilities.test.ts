import { describe, expect, it } from 'vitest';
import { PI_RUNNER_CAPABILITIES } from '../capabilities';

// Pins the comment on `autoResume` in capabilities.ts: PiJobRunner ignores
// `ctx.resume` and re-sends the prompt, so Pi must never be auto-resumed nor
// offered a manual Resume (JobControl.resume and the web gate both read this flag).

describe('PI_RUNNER_CAPABILITIES', () => {
  it('resumes by session but declares no auto-resume', () => {
    expect(PI_RUNNER_CAPABILITIES).toMatchObject({ resume: 'session', autoResume: false });
  });
});
