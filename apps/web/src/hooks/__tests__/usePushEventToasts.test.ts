// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { pushEventId, pushEventSummary } from '../usePushEventToasts';

// W4 (ux-feedback plan) — `memory.captured` is a trail row (`✓ remembered ·
// "…"` in the chat reducer), never a toast: feedback rows are rows, not
// toasts (DESIGN.md "Feedback & activity" item 6). The push-toast layer keeps
// the genuinely session-external events.

describe('pushEventSummary — what still toasts', () => {
  it('memory.captured no longer produces a toast', () => {
    expect(pushEventSummary({ type: 'memory.captured', summary: 'prefers pnpm' })).toBeNull();
    expect(pushEventId({ type: 'memory.captured', summary: 'prefers pnpm' })).toBeNull();
  });

  it('cron / mesh / evolve events keep their toasts', () => {
    expect(
      pushEventSummary({
        type: 'cron.fired',
        jobId: 'job-1',
        ranAt: '2026-09-26T00:00:00Z',
        outputPath: null,
      }),
    ).toMatchObject({ deepLink: '/cron' });
    expect(
      pushEventSummary({
        type: 'evolve.skill_pending',
        skillId: 'sk1',
        personalityId: null,
        proposedAt: '2026-09-26T00:00:00Z',
      }),
    ).toMatchObject({ deepLink: '/skills' });
  });
});
