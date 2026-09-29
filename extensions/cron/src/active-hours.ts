// Active hours for a cron job (plan personality-presence-and-initiative §6):
// the daily window in which a scheduled run may happen at all. Outside it the
// occurrence is skipped BEFORE the turn — `CronScheduler.tick` is the one
// caller that decides (a manual `runJobNow` ignores the window).
//
// Not quiet hours. Quiet hours (`extensions/gateway/src/quiet-hours.ts`) hold
// the DELIVERY of a turn that already ran; active hours save the turn. The two
// share one grammar — `parseQuietHoursSpec` in `@ethosagent/config` — but not a
// clock: a window is read on the host's zone (`hostTimeZone`), the zone croner
// reads the job's schedule in, so `0 20 * * *` with `19:00-21:00` always runs.
// `notifications.timezone` moves quiet hours only. Not a shared module either:
// `extensions/` cannot import `extensions/gateway` (architecture.config.ts,
// rule `extensions-implement-contracts`), so the wall-clock read below mirrors
// the gateway's `minuteOfDay`.

import { parseQuietHoursSpec } from '@ethosagent/config';

/** A daily window in minutes after local midnight. `start > end` crosses midnight. */
export interface ActiveHoursWindow {
  startMinute: number;
  endMinute: number;
}

/**
 * `HH:MM-HH:MM` → the window, or null when malformed. The grammar is
 * `parseQuietHoursSpec`'s. An empty window (start = end) is refused too: it
 * reads equally as "never" and "always", and a job that never runs is a
 * mistake, not a setting.
 */
export function parseActiveHours(spec: string): ActiveHoursWindow | null {
  const window = parseQuietHoursSpec(spec);
  if (!window || window.startMinute === window.endMinute) return null;
  return window;
}

/**
 * Minutes after local midnight in `timeZone` at `now`, read from the zone's
 * wall clock so a DST change moves the window with the clock on the wall.
 */
function minuteOfDay(now: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}

/** Whether `now` falls inside `window` in `timeZone`. Start inclusive, end exclusive. */
export function isActiveAt(window: ActiveHoursWindow, timeZone: string, now: number): boolean {
  const { startMinute: start, endMinute: end } = window;
  const m = minuteOfDay(now, timeZone);
  return start < end ? m >= start && m < end : m >= start || m < end;
}
