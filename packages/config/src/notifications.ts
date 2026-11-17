/** `notifications.*` (U11). Raw strings, validated at parse. */
export interface NotificationsConfig {
  /** `HH:MM-HH:MM` in `timezone`. */
  quietHours?: string;
  /** IANA zone name. Absent = the host's zone (`hostTimeZone`). */
  timezone?: string;
  /** Per-botKey override: a window, or `off`. */
  bots?: Record<string, { quietHours: string }>;
}

/**
 * `HH:MM-HH:MM` → minutes after local midnight, or null when malformed. A start
 * later than the end crosses midnight (`22:00-07:00`). The ONE parser for the
 * `notifications.quietHours` grammar: the config parser validates with it and
 * the gateway wiring resolves with it.
 */
export function parseQuietHoursSpec(
  spec: string,
): { startMinute: number; endMinute: number } | null {
  const m = spec.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [h1, m1, h2, m2] = [m[1], m[2], m[3], m[4]].map(Number);
  if (h1 === undefined || m1 === undefined || h2 === undefined || m2 === undefined) return null;
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return null;
  return { startMinute: h1 * 60 + m1, endMinute: h2 * 60 + m2 };
}

/** Whether `timeZone` is an IANA zone this runtime knows. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The host's IANA zone — the `notifications.timezone` default. */
export function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function buildNotificationsConfig(
  kv: Record<string, string>,
  botsKv: Record<string, Record<string, string>>,
  warnings: string[],
): NotificationsConfig | undefined {
  const out: NotificationsConfig = {};
  const quiet = kv.quietHours;
  if (quiet !== undefined) {
    if (parseQuietHoursSpec(quiet)) out.quietHours = quiet;
    else
      warnings.push(
        `config.yaml: notifications.quietHours '${quiet}' is not HH:MM-HH:MM — quiet hours are off.`,
      );
  }
  const tz = kv.timezone;
  if (tz !== undefined) {
    if (isValidTimeZone(tz)) out.timezone = tz;
    else
      warnings.push(
        `config.yaml: notifications.timezone '${tz}' is not a known IANA time zone — using the host's zone.`,
      );
  }
  const bots: Record<string, { quietHours: string }> = {};
  for (const [botKey, entry] of Object.entries(botsKv)) {
    const spec = entry.quietHours;
    if (spec === undefined) continue;
    if (spec === 'off' || parseQuietHoursSpec(spec)) bots[botKey] = { quietHours: spec };
    else
      warnings.push(
        `config.yaml: notifications.bots.${botKey}.quietHours '${spec}' is not HH:MM-HH:MM or off — ignored.`,
      );
  }
  if (Object.keys(bots).length > 0) out.bots = bots;
  return Object.keys(out).length > 0 ? out : undefined;
}
