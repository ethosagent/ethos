import { Cron } from 'croner';

// Parse relative delays: 30m, 2h, 90s, 1d
const RELATIVE_RE = /^(\d+)\s*(s|m|h|d)$/i;
// Parse recurring intervals: every 2h, every 30m, every 1d
const INTERVAL_RE = /^every\s+(\d+)\s*(s|m|h|d)$/i;
function parseTimeUnit(value, unit) {
  switch (unit.toLowerCase()) {
    case 's':
      return value * 1000;
    case 'm':
      return value * 60_000;
    case 'h':
      return value * 3_600_000;
    case 'd':
      return value * 86_400_000;
    default:
      return 0;
  }
}
export function parseSchedule(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Try relative delay: 30m, 2h, 90s
  const relMatch = trimmed.match(RELATIVE_RE);
  if (relMatch) {
    const ms = parseTimeUnit(Number(relMatch[1]), relMatch[2] ?? 's');
    return ms > 0 ? { kind: 'relative', delayMs: ms } : null;
  }
  // Try recurring interval: every 2h, every 30m
  const intMatch = trimmed.match(INTERVAL_RE);
  if (intMatch) {
    const ms = parseTimeUnit(Number(intMatch[1]), intMatch[2] ?? 'm');
    return ms > 0 ? { kind: 'interval', intervalMs: ms } : null;
  }
  // Try ISO-8601 timestamp: 2026-06-01T09:00:00Z
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
    const date = new Date(trimmed);
    if (!Number.isNaN(date.getTime())) return { kind: 'iso', date };
    return null;
  }
  // Try 5-field cron expression
  try {
    new Cron(trimmed, { maxRuns: 1 });
    return { kind: 'cron', expression: trimmed };
  } catch {
    return null;
  }
}
export function isValidSchedule(raw) {
  return parseSchedule(raw) !== null;
}
/**
 * Compute the next run time strictly after `after` for the given parsed schedule.
 * Returns null when a one-shot schedule has already passed.
 */
export function nextRunFromParsed(parsed, after, createdAt) {
  switch (parsed.kind) {
    case 'cron': {
      try {
        return new Cron(parsed.expression).nextRun(after) ?? null;
      } catch {
        return null;
      }
    }
    case 'relative': {
      const fireAt = new Date((createdAt ?? after).getTime() + parsed.delayMs);
      return fireAt > after ? fireAt : null;
    }
    case 'interval': {
      const base = createdAt ?? after;
      const elapsed = after.getTime() - base.getTime();
      const periods = Math.floor(elapsed / parsed.intervalMs) + 1;
      return new Date(base.getTime() + periods * parsed.intervalMs);
    }
    case 'iso': {
      return parsed.date > after ? parsed.date : null;
    }
  }
}
/** Convenience: parse + compute next run in one call. */
export function nextRunForSchedule(raw, after, createdAt) {
  const parsed = parseSchedule(raw);
  if (!parsed) return null;
  return nextRunFromParsed(parsed, after, createdAt);
}
/** Returns true if the schedule kind implies a one-shot job. */
export function isOneShotSchedule(raw) {
  const parsed = parseSchedule(raw);
  if (!parsed) return false;
  return parsed.kind === 'relative' || parsed.kind === 'iso';
}
