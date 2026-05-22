import { describe, expect, it } from 'vitest';
import { isOneShotSchedule, isValidSchedule, nextRunFromParsed, parseSchedule } from '../schedule';

// ---------------------------------------------------------------------------
// parseSchedule
// ---------------------------------------------------------------------------

describe('parseSchedule', () => {
  it('parses 5-field cron expression', () => {
    const result = parseSchedule('0 8 * * 1-5');
    expect(result).toEqual({ kind: 'cron', expression: '0 8 * * 1-5' });
  });

  it('parses relative delay — minutes', () => {
    const result = parseSchedule('30m');
    expect(result).toEqual({ kind: 'relative', delayMs: 1_800_000 });
  });

  it('parses relative delay — hours', () => {
    const result = parseSchedule('2h');
    expect(result).toEqual({ kind: 'relative', delayMs: 7_200_000 });
  });

  it('parses relative delay — seconds', () => {
    const result = parseSchedule('90s');
    expect(result).toEqual({ kind: 'relative', delayMs: 90_000 });
  });

  it('parses relative delay — days', () => {
    const result = parseSchedule('1d');
    expect(result).toEqual({ kind: 'relative', delayMs: 86_400_000 });
  });

  it('parses recurring interval', () => {
    const result = parseSchedule('every 2h');
    expect(result).toEqual({ kind: 'interval', intervalMs: 7_200_000 });
  });

  it('parses recurring interval — minutes', () => {
    const result = parseSchedule('every 30m');
    expect(result).toEqual({ kind: 'interval', intervalMs: 1_800_000 });
  });

  it('parses ISO-8601 timestamp', () => {
    const result = parseSchedule('2026-06-01T09:00:00Z');
    expect(result).toEqual({ kind: 'iso', date: new Date('2026-06-01T09:00:00Z') });
  });

  it('returns null for garbage input', () => {
    expect(parseSchedule('garbage')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseSchedule('')).toBeNull();
  });

  it('returns null for whitespace-only', () => {
    expect(parseSchedule('   ')).toBeNull();
  });

  it('returns null for invalid cron', () => {
    expect(parseSchedule('60 8 * * *')).toBeNull();
  });

  it('trims whitespace', () => {
    expect(parseSchedule('  30m  ')).toEqual({ kind: 'relative', delayMs: 1_800_000 });
  });
});

// ---------------------------------------------------------------------------
// isValidSchedule
// ---------------------------------------------------------------------------

describe('isValidSchedule', () => {
  it('returns true for cron', () => {
    expect(isValidSchedule('0 8 * * *')).toBe(true);
  });

  it('returns true for relative delay', () => {
    expect(isValidSchedule('30m')).toBe(true);
  });

  it('returns true for interval', () => {
    expect(isValidSchedule('every 5m')).toBe(true);
  });

  it('returns true for ISO timestamp', () => {
    expect(isValidSchedule('2026-06-01T09:00:00Z')).toBe(true);
  });

  it('returns false for garbage', () => {
    expect(isValidSchedule('nope')).toBe(false);
  });

  it('returns false for empty', () => {
    expect(isValidSchedule('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// nextRunFromParsed
// ---------------------------------------------------------------------------

describe('nextRunFromParsed', () => {
  const now = new Date('2026-05-21T12:00:00Z');

  it('computes next cron run after a given date', () => {
    const parsed = parseSchedule('0 8 * * *');
    if (!parsed) throw new Error('expected parsed');
    const next = nextRunFromParsed(parsed, now);
    expect(next).toBeInstanceOf(Date);
    if (next) {
      expect(next.getTime()).toBeGreaterThan(now.getTime());
    }
  });

  it('computes relative delay from createdAt', () => {
    const createdAt = new Date('2026-05-21T11:30:00Z');
    const parsed = parseSchedule('60m');
    if (!parsed) throw new Error('expected parsed');
    const next = nextRunFromParsed(parsed, now, createdAt);
    // createdAt + 60m = 12:30:00Z, which is after now (12:00:00Z)
    expect(next).toEqual(new Date('2026-05-21T12:30:00Z'));
  });

  it('returns null for relative delay that has already passed', () => {
    const createdAt = new Date('2026-05-21T10:00:00Z');
    const parsed = parseSchedule('30m');
    if (!parsed) throw new Error('expected parsed');
    // createdAt + 30m = 10:30, which is before now (12:00)
    const next = nextRunFromParsed(parsed, now, createdAt);
    expect(next).toBeNull();
  });

  it('computes interval next run', () => {
    const createdAt = new Date('2026-05-21T10:00:00Z');
    const parsed = parseSchedule('every 1h');
    if (!parsed) throw new Error('expected parsed');
    const next = nextRunFromParsed(parsed, now, createdAt);
    // base=10:00, elapsed=2h, periods=floor(2h/1h)+1=3, next=10:00+3h=13:00
    expect(next).toEqual(new Date('2026-05-21T13:00:00Z'));
  });

  it('computes ISO next run when in the future', () => {
    const parsed = parseSchedule('2026-06-01T09:00:00Z');
    if (!parsed) throw new Error('expected parsed');
    const next = nextRunFromParsed(parsed, now);
    expect(next).toEqual(new Date('2026-06-01T09:00:00Z'));
  });

  it('returns null for ISO date in the past', () => {
    const parsed = parseSchedule('2025-01-01T09:00:00Z');
    if (!parsed) throw new Error('expected parsed');
    const next = nextRunFromParsed(parsed, now);
    expect(next).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isOneShotSchedule
// ---------------------------------------------------------------------------

describe('isOneShotSchedule', () => {
  it('returns true for relative delay', () => {
    expect(isOneShotSchedule('30m')).toBe(true);
  });

  it('returns true for ISO timestamp', () => {
    expect(isOneShotSchedule('2026-06-01T09:00:00Z')).toBe(true);
  });

  it('returns false for cron expression', () => {
    expect(isOneShotSchedule('0 8 * * *')).toBe(false);
  });

  it('returns false for interval', () => {
    expect(isOneShotSchedule('every 2h')).toBe(false);
  });

  it('returns false for invalid schedule', () => {
    expect(isOneShotSchedule('garbage')).toBe(false);
  });
});
