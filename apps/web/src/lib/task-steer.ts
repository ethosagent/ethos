import { JOB_STEER_MAX_CHARS } from '@ethosagent/types';
import type { BackgroundJobEventWire, BackgroundJobStatusWire } from '@ethosagent/web-contracts';
import type { RunButton } from './pi-run-reducer';

/** The steer length cap (`JOB_STEER_MAX_CHARS`); the web-contracts input schema enforces it too. */
export const STEER_MAX_CHARS = JOB_STEER_MAX_CHARS;

interface SteerCaps {
  steer: boolean;
}

/**
 * The run card offers `interrupt` only when the state table lists it AND the
 * runner that executes the row can take a steer. An unresolved runner reports
 * `capabilities: null`, which is "unknown", so the button stays hidden.
 */
export function canInterruptRun(
  buttons: readonly RunButton[],
  capabilities: SteerCaps | null | undefined,
): boolean {
  return buttons.includes('interrupt') && capabilities?.steer === true;
}

/** The Tasks drawer's steer input: a live (running or parked) job whose runner takes steers. */
export function canSteerJob(
  status: BackgroundJobStatusWire,
  capabilities: SteerCaps | null | undefined,
): boolean {
  return (status === 'running' || status === 'blocked') && capabilities?.steer === true;
}

export interface TranscriptLine {
  key: number;
  kind: 'text' | 'tool' | 'steer';
  text: string;
}

/** Fold the cursor-polled event rows into transcript lines: model text, tool headlines between, steers inline. */
export function transcriptLines(events: readonly BackgroundJobEventWire[]): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const ev of events) {
    const p = ev.payload;
    if (ev.eventType === 'text' && typeof p.text === 'string') {
      lines.push({ key: ev.id, kind: 'text', text: p.text });
    } else if (ev.eventType === 'tool_headline') {
      const arg = typeof p.arg === 'string' && p.arg ? ` ${p.arg}` : '';
      lines.push({ key: ev.id, kind: 'tool', text: `${String(p.toolName ?? 'tool')}${arg}` });
    } else if (ev.eventType === 'steer') {
      lines.push({
        key: ev.id,
        kind: 'steer',
        text: `you steered (${String(p.chars ?? '?')} chars)`,
      });
    }
  }
  return lines;
}
