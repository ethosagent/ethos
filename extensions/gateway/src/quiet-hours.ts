// Quiet hours and per-lane mute for unprompted notices (plan openclaw-2026.9.6-gaps
// U11). Pure helpers; `Gateway.noticeHoldReason` is the one caller that decides.
//
// An operator setting, not personality identity: two deployments of the same
// personality can reasonably disagree about when their owner sleeps
// (CLAUDE.md "What does NOT belong on PersonalityConfig").

/** A daily window in minutes after local midnight. `start > end` crosses midnight. */
export interface QuietHoursWindow {
  startMinute: number;
  endMinute: number;
}

/**
 * Resolved quiet hours for a gateway (`GatewayConfig.quietHours`). `timeZone`
 * is always explicit — the wiring resolves `notifications.timezone`, else the
 * host's zone, before it gets here. `byBot` overrides `window` per botKey;
 * `null` turns quiet hours off for that bot.
 */
export interface GatewayQuietHours {
  timeZone: string;
  window?: QuietHoursWindow;
  byBot?: Record<string, QuietHoursWindow | null>;
}

/** The window that applies to `botKey`, or undefined when none does. */
export function quietWindowFor(
  quiet: GatewayQuietHours | undefined,
  botKey: string,
): QuietHoursWindow | undefined {
  if (!quiet) return undefined;
  if (quiet.byBot && Object.hasOwn(quiet.byBot, botKey)) {
    return quiet.byBot[botKey] ?? undefined;
  }
  return quiet.window;
}

/**
 * Minutes after local midnight in `timeZone` at `now`. Read from the zone's
 * wall clock each call rather than computed as an offset, so a DST change moves
 * the window with the clock on the wall.
 */
export function minuteOfDay(now: number, timeZone: string): number {
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

/** Whether `now` falls inside `window` in `timeZone`. An empty window (start = end) never does. */
export function inQuietHours(window: QuietHoursWindow, timeZone: string, now: number): boolean {
  const { startMinute: start, endMinute: end } = window;
  if (start === end) return false;
  const m = minuteOfDay(now, timeZone);
  return start < end ? m >= start && m < end : m >= start || m < end;
}

/** Longest `/mute` accepted: a mute is a pause, not a way to switch notices off. */
export const MAX_MUTE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * `/mute` argument → duration in ms, `'off'`, or null when unparseable.
 * Accepts `<n>m`, `<n>h`, `<n>d` (e.g. `30m`, `2h`, `1d`), capped at
 * {@link MAX_MUTE_MS}.
 */
export function parseMuteDuration(arg: string): number | 'off' | null {
  const value = arg.trim().toLowerCase();
  if (value === 'off') return 'off';
  const match = value.match(/^(\d+)\s*(m|h|d)$/);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  const unit = match[2] === 'm' ? 60_000 : match[2] === 'h' ? 3_600_000 : 86_400_000;
  return Math.min(n * unit, MAX_MUTE_MS);
}
