import { nextRunForSchedule } from '@ethosagent/cron';

const DAY_MS = 86_400_000;
/** One slot per minute is the finest cron granularity, so a full UTC day always fits. */
const MAX_SLOTS_PER_SCHEDULE = 1440;

/**
 * Every start time of `schedules` inside the UTC day beginning at `dayStartMs`, as sorted ISO
 * strings. The day start is passed as `createdAt` so an "every Nh" interval counts from it and
 * lands on the exact boundary (00:00, 06:00, ...) rather than one ms before it
 * (pinned by `__tests__/slots.test.ts`). The tick and the config service share this one helper.
 */
export function slotsOnDay(schedules: readonly string[], dayStartMs: number): string[] {
  const dayStart = new Date(dayStartMs);
  const times = new Set<string>();
  for (const schedule of schedules) {
    let cursor = new Date(dayStartMs - 1);
    for (let i = 0; i < MAX_SLOTS_PER_SCHEDULE; i++) {
      const next = nextRunForSchedule(schedule, cursor, dayStart);
      if (next === null || next.getTime() >= dayStartMs + DAY_MS) break;
      times.add(next.toISOString());
      cursor = next;
    }
  }
  return [...times].sort();
}

/** The first slot strictly after `now`, looking today and tomorrow (UTC); null when none. */
export function nextSlotAfter(schedules: readonly string[], now: Date): string | null {
  const dayStart = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  for (const start of [dayStart, dayStart + DAY_MS]) {
    const hit = slotsOnDay(schedules, start).find((t) => Date.parse(t) > now.getTime());
    if (hit !== undefined) return hit;
  }
  return null;
}
