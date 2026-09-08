// Cron run progress — the record of what a scheduled run was DOING, kept
// separate from what it SAID.
//
// A tool reports progress via `ctx.emit({ type: 'progress', … })`, which the
// agent loop surfaces as a `tool_progress` AgentEvent. Interactive surfaces
// render those live; a cron run has no one watching, so without this module
// every stage marker a long unattended job emits is dropped on the floor.
//
// Two invariants this module exists to hold:
//
//  1. The Phase 30.2 audience boundary (see CLAUDE.md). Only
//     `audience === 'user'` events are recorded. `'internal'` progress is
//     framework-facing (logs, telemetry, dev TUI) and a persisted run record
//     an agent can read back with `cron { action: 'read_run' }` is not that.
//     `CronProgressRecorder.record` is the single gate.
//
//  2. Progress NEVER joins the run's `output` string. `output` is delivered
//     verbatim to the originating channel, and `decideEscalation`
//     (./heartbeat.ts) suppresses delivery with `/^\s*\[SILENT\]/i` — anchored
//     at position 0. Interleaving progress into `output` would push noise into
//     every delivered message AND break the `[SILENT]` convention for every
//     job that uses it. Progress travels as its own field on `CronRunResult`
//     and is persisted to its own sidecar file.

import type { AgentEvent } from '@ethosagent/types';

/** One recorded `tool_progress` event from a cron run. */
export interface CronRunProgress {
  /** ISO-8601 wall-clock stamp taken when the event was recorded. */
  at: string;
  toolName: string;
  message: string;
  percent?: number;
}

/**
 * Retention caps. A pathological tool can emit thousands of progress events
 * in one run; a run record must not grow without limit. The strategy is
 * head-and-tail: the first `PROGRESS_HEAD_LIMIT` entries (what the run set out
 * to do) and the last `PROGRESS_TAIL_LIMIT` (where it actually got to, which
 * is the whole reason to read this after a stall), with a single elision entry
 * in between saying how many were dropped. Individual messages are truncated
 * at `PROGRESS_MESSAGE_MAX_CHARS`.
 *
 * Worst case on disk is therefore bounded at roughly
 * (50 + 50 + 1) × (500 + envelope) ≈ 60 KB per run.
 */
export const PROGRESS_HEAD_LIMIT = 50;
export const PROGRESS_TAIL_LIMIT = 50;
export const PROGRESS_MESSAGE_MAX_CHARS = 500;

/** Marker `toolName` on the synthetic entry standing in for dropped events. */
export const PROGRESS_ELISION_TOOL = '(elided)';

function truncate(message: string): string {
  return message.length <= PROGRESS_MESSAGE_MAX_CHARS
    ? message
    : `${message.slice(0, PROGRESS_MESSAGE_MAX_CHARS)}…[truncated]`;
}

/**
 * Collects `audience: 'user'` progress from a cron run's event stream.
 *
 * Memory is bounded during the run, not just on disk: the recorder keeps the
 * head window and a rolling tail window, so a runaway tool costs a fixed
 * number of retained entries however many it emits.
 */
export class CronProgressRecorder {
  private readonly head: CronRunProgress[] = [];
  private readonly tail: CronRunProgress[] = [];
  private dropped = 0;
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  /**
   * Offer one event. Anything that is not a `tool_progress` event, and any
   * `tool_progress` whose audience is not exactly `'user'` (including an
   * absent one), is ignored — that is the audience boundary.
   */
  record(event: AgentEvent): void {
    if (event.type !== 'tool_progress') return;
    if (event.audience !== 'user') return;

    const entry: CronRunProgress = {
      at: this.now().toISOString(),
      toolName: event.toolName,
      message: truncate(event.message),
      ...(typeof event.percent === 'number' ? { percent: event.percent } : {}),
    };

    if (this.head.length < PROGRESS_HEAD_LIMIT) {
      this.head.push(entry);
      return;
    }
    this.tail.push(entry);
    if (this.tail.length > PROGRESS_TAIL_LIMIT) {
      this.tail.shift();
      this.dropped += 1;
    }
  }

  /** The retained entries, in order, with an elision marker if any were dropped. */
  snapshot(): CronRunProgress[] {
    if (this.dropped === 0) return [...this.head, ...this.tail];
    const marker: CronRunProgress = {
      at: this.head[PROGRESS_HEAD_LIMIT - 1]?.at ?? this.now().toISOString(),
      toolName: PROGRESS_ELISION_TOOL,
      message: `${this.dropped} progress event${this.dropped === 1 ? '' : 's'} elided`,
    };
    return [...this.head, marker, ...this.tail];
  }
}

/**
 * Parse a persisted sidecar body into entries. Never throws: an unreadable or
 * malformed sidecar means "no progress recorded", not a failed read of the run.
 * Records written before this feature existed have no sidecar at all and land
 * here as `null`, which reads the same as empty.
 */
export function parseRunProgress(raw: string | null): CronRunProgress[] {
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: CronRunProgress[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.at !== 'string' || typeof rec.message !== 'string') continue;
    out.push({
      at: rec.at,
      toolName: typeof rec.toolName === 'string' ? rec.toolName : 'unknown',
      message: rec.message,
      ...(typeof rec.percent === 'number' ? { percent: rec.percent } : {}),
    });
  }
  return out;
}

/**
 * Filename suffix of a run's progress sidecar. Deliberately not `.md`, so
 * `CronScheduler.listRuns` — which enumerates runs by `.md` — never mistakes a
 * sidecar for a run of its own.
 */
export const PROGRESS_SUFFIX = '.progress.json';

/** The sidecar path for a run's `<ts>.md` output path. */
export function progressPathFor(outputPath: string): string {
  return outputPath.endsWith('.md')
    ? `${outputPath.slice(0, -'.md'.length)}${PROGRESS_SUFFIX}`
    : `${outputPath}${PROGRESS_SUFFIX}`;
}

/** Render entries for a human/agent reader. Returns '' for no entries. */
export function formatRunProgress(entries: CronRunProgress[]): string {
  if (entries.length === 0) return '';
  const lines = entries.map((e) => {
    const pct = typeof e.percent === 'number' ? ` (${e.percent}%)` : '';
    return `- ${e.at} ${e.toolName}${pct}: ${e.message}`;
  });
  return `## Progress\n\n${lines.join('\n')}`;
}
