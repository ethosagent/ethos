// Heartbeat escalation policy — the single place where "should this cron run
// bother a human?" is decided. Formalizes the inline [SILENT] suppression
// that previously lived as two duplicated regex checks in the scheduler.

export type HeartbeatAction = 'escalate' | 'silent';

export interface HeartbeatDecision {
  action: HeartbeatAction;
  /** The run output (delivered verbatim when action === 'escalate'). */
  output: string;
}

const SILENT_PREFIX = /^\s*\[SILENT\]/i;

/**
 * Default escalate-vs-silent policy for heartbeat runs.
 *
 * Output beginning with `[SILENT]` (case-insensitive, optional leading
 * whitespace — `/^\s*\[SILENT\]/i`) → `'silent'`: the run is audited and
 * persisted but never delivered to the originating channel. Anything else →
 * `'escalate'`: the output is delivered verbatim.
 */
export function decideEscalation(output: string): HeartbeatDecision {
  return { action: SILENT_PREFIX.test(output) ? 'silent' : 'escalate', output };
}
