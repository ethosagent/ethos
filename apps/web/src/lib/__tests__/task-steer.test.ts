import type { BackgroundJobEventWire } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import { runCardView } from '../pi-run-reducer';
import { canInterruptRun, canSteerJob, transcriptLines } from '../task-steer';

const caps = (steer: boolean) => ({ steer });

describe('canInterruptRun — the run card gate', () => {
  const running = runCardView('running').buttons;

  it('shows interrupt for a running row whose runner takes steers', () => {
    expect(canInterruptRun(running, caps(true))).toBe(true);
  });

  it('hides interrupt when capabilities.steer is false', () => {
    expect(canInterruptRun(running, caps(false))).toBe(false);
  });

  it('hides interrupt when capabilities are unknown (null or not loaded yet)', () => {
    expect(canInterruptRun(running, null)).toBe(false);
    expect(canInterruptRun(running, undefined)).toBe(false);
  });

  it('hides interrupt in a state whose table does not list it, even with steer', () => {
    expect(canInterruptRun(runCardView('done').buttons, caps(true))).toBe(false);
    expect(canInterruptRun(runCardView('blocked').buttons, caps(true))).toBe(false);
  });
});

describe('canSteerJob — the Tasks drawer gate', () => {
  it('allows running and blocked jobs with steer, nothing else', () => {
    expect(canSteerJob('running', caps(true))).toBe(true);
    expect(canSteerJob('blocked', caps(true))).toBe(true);
    expect(canSteerJob('queued', caps(true))).toBe(false);
    expect(canSteerJob('done', caps(true))).toBe(false);
    expect(canSteerJob('running', caps(false))).toBe(false);
    expect(canSteerJob('running', null)).toBe(false);
  });
});

describe('transcriptLines', () => {
  const ev = (
    id: number,
    eventType: BackgroundJobEventWire['eventType'],
    payload: Record<string, unknown>,
  ): BackgroundJobEventWire => ({ id, jobId: 'j', seq: id, eventType, payload, createdAt: 0 });

  it('keeps text, tool headlines and steers in order, and drops the rest', () => {
    const lines = transcriptLines([
      ev(1, 'text', { text: 'reading' }),
      ev(2, 'tool_headline', { toolName: 'read_file', arg: 'a.ts' }),
      ev(3, 'heartbeat', {}),
      ev(4, 'steer', { steerId: 1, chars: 12, source: 'web' }),
      ev(5, 'runner_log', { lines: [] }),
    ]);
    expect(lines.map((l) => [l.kind, l.text])).toEqual([
      ['text', 'reading'],
      ['tool', 'read_file a.ts'],
      ['steer', 'you steered (12 chars)'],
    ]);
  });
});
