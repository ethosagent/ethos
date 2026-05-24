export interface ParseResult {
  cron: string;
  human: string;
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

function parseTime(raw: string): { hour: number; minute: number } | null {
  const lower = raw.toLowerCase().trim();

  if (lower === 'noon') return { hour: 12, minute: 0 };
  if (lower === 'midnight') return { hour: 0, minute: 0 };

  const match = lower.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!match) return null;

  let hour = Number.parseInt(match[1], 10);
  const minute = match[2] ? Number.parseInt(match[2], 10) : 0;
  const period = match[3];

  if (period === 'pm' && hour < 12) hour += 12;
  if (period === 'am' && hour === 12) hour = 0;

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function formatHour(hour: number, minute: number): string {
  const period = hour >= 12 ? 'PM' : 'AM';
  const h = hour % 12 || 12;
  const m = minute.toString().padStart(2, '0');
  return `${h}:${m} ${period}`;
}

function isRawCron(input: string): boolean {
  return input.trim().split(/\s+/).length === 5;
}

function describeCron(cron: string): string {
  const [minute, hour, , , dow] = cron.split(' ');

  const timeStr =
    minute === '*' && hour === '*'
      ? 'every minute'
      : hour?.startsWith('*/')
        ? `every ${hour.slice(2)} hours`
        : minute?.startsWith('*/')
          ? `every ${minute.slice(2)} minutes`
          : formatHour(Number(hour), Number(minute));

  if (minute?.startsWith('*/') || (minute === '*' && hour === '*')) {
    return `Every ${minute === '*' ? 'minute' : `${minute.slice(2)} minutes`}`;
  }

  if (hour?.startsWith('*/')) {
    return `Every ${hour.slice(2)} hours`;
  }

  if (dow === '*') return `Every day at ${timeStr}`;
  if (dow === '1-5') return `Every weekday at ${timeStr}`;

  const dayNum = Number(dow);
  if (dayNum >= 0 && dayNum <= 6) {
    return `Every ${WEEKDAY_NAMES[dayNum]} at ${timeStr}`;
  }

  return `${cron}`;
}

export function parseScheduleInput(input: string): ParseResult | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;

  if (isRawCron(input.trim())) {
    return { cron: input.trim(), human: describeCron(input.trim()) };
  }

  // "every N minutes"
  const minutesMatch = trimmed.match(/^every\s+(\d+)\s+minutes?$/);
  if (minutesMatch) {
    const n = minutesMatch[1];
    return { cron: `*/${n} * * * *`, human: `Every ${n} minutes` };
  }

  // "every hour"
  if (trimmed === 'every hour') {
    return { cron: '0 * * * *', human: 'Every hour' };
  }

  // "every N hours"
  const hoursMatch = trimmed.match(/^every\s+(\d+)\s+hours?$/);
  if (hoursMatch) {
    const n = hoursMatch[1];
    return { cron: `0 */${n} * * *`, human: `Every ${n} hours` };
  }

  // "every morning"
  if (trimmed === 'every morning') {
    return { cron: '0 9 * * *', human: 'Every day at 9:00 AM' };
  }

  // "every evening"
  if (trimmed === 'every evening') {
    return { cron: '0 18 * * *', human: 'Every day at 6:00 PM' };
  }

  // "every night"
  if (trimmed === 'every night') {
    return { cron: '0 22 * * *', human: 'Every day at 10:00 PM' };
  }

  // "every day at TIME"
  const dayAtMatch = trimmed.match(/^every\s+day\s+at\s+(.+)$/);
  if (dayAtMatch) {
    const time = parseTime(dayAtMatch[1]);
    if (!time) return null;
    return {
      cron: `${time.minute} ${time.hour} * * *`,
      human: `Every day at ${formatHour(time.hour, time.minute)}`,
    };
  }

  // "every weekday at TIME"
  const weekdayAtMatch = trimmed.match(/^every\s+weekday\s+at\s+(.+)$/);
  if (weekdayAtMatch) {
    const time = parseTime(weekdayAtMatch[1]);
    if (!time) return null;
    return {
      cron: `${time.minute} ${time.hour} * * 1-5`,
      human: `Every weekday at ${formatHour(time.hour, time.minute)}`,
    };
  }

  // "every WEEKDAY at TIME"
  const namedDayMatch = trimmed.match(/^every\s+(\w+)\s+at\s+(.+)$/);
  if (namedDayMatch) {
    const dayName = namedDayMatch[1];
    const dayNum = WEEKDAYS[dayName];
    if (dayNum === undefined) return null;
    const time = parseTime(namedDayMatch[2]);
    if (!time) return null;
    return {
      cron: `${time.minute} ${time.hour} * * ${dayNum}`,
      human: `Every ${WEEKDAY_NAMES[dayNum]} at ${formatHour(time.hour, time.minute)}`,
    };
  }

  return null;
}
