import type { BackgroundJob, BackgroundJobEvent } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { resumeContextFor, resumePrompt } from '../resume';

let nextId = 1;
function ev(
  eventType: BackgroundJobEvent['eventType'],
  payload: Record<string, unknown> = {},
): BackgroundJobEvent {
  const id = nextId++;
  return { id, jobId: 'j1', seq: id, eventType, payload, createdAt: id };
}

describe('resumePrompt', () => {
  it('names the interrupted tools after a restart and asks to verify them', () => {
    const p = resumePrompt({
      attempt: 1,
      reason: 'restart',
      interruptedTools: ['terminal', 'write_file'],
    });
    expect(p).toContain('interrupted by a restart while running: terminal, write_file');
    expect(p).toContain('Verify what they changed');
    expect(p.toLowerCase()).toContain('then continue the original task');
  });

  it('words a crash and a manual resume differently', () => {
    expect(resumePrompt({ attempt: 1, reason: 'crash', interruptedTools: [] })).toContain(
      'the process stopped unexpectedly',
    );
    expect(resumePrompt({ attempt: 0, reason: 'manual', interruptedTools: [] })).toContain(
      'resumed by the user',
    );
  });

  it('with no interrupted tools says to check the work already done before repeating any step', () => {
    const p = resumePrompt({ attempt: 1, reason: 'restart', interruptedTools: [] });
    expect(p).toContain('check the work already done before repeating any step');
    expect(p.toLowerCase()).toContain('then continue the original task');
  });
});

describe('resumeContextFor', () => {
  const job = (over: Partial<BackgroundJob>): BackgroundJob =>
    ({ id: 'j1', ...over }) as BackgroundJob;

  it('is undefined for a row that was never requeued', () => {
    expect(resumeContextFor(job({}), [ev('claimed')])).toBeUndefined();
  });

  it('reads reason and attempt from the newest requeued event', () => {
    const events = [
      ev('requeued', { reason: 'restart', attempt: 1, interruptedTools: ['old'] }),
      ev('requeued', { reason: 'crash', attempt: 2, interruptedTools: ['terminal'] }),
      ev('claimed'),
    ];
    expect(resumeContextFor(job({ requeuedAt: 5 }), events)).toEqual({
      reason: 'crash',
      attempt: 2,
      interruptedTools: ['terminal'],
    });
  });

  it('falls back to the row resumeCount and a restart reason on a malformed payload', () => {
    const out = resumeContextFor(job({ requeuedAt: 5, resumeCount: 3 }), [
      ev('requeued', { reason: 7, interruptedTools: [1, 'x'] }),
    ]);
    expect(out?.attempt).toBe(3);
    expect(out?.reason).toBe('restart');
    expect(out?.interruptedTools).toEqual(['x']);
  });
});
