import { describe, expect, it } from 'vitest';
import { nextSlotAfter, slotsOnDay } from '../slots';

const DAY = Date.parse('2026-11-29T00:00:00Z');

describe('slotsOnDay', () => {
  it('"every 6h" lands on the exact 00/06/12/18 UTC boundaries', () => {
    expect(slotsOnDay(['every 6h'], DAY)).toEqual([
      '2026-11-29T00:00:00.000Z',
      '2026-11-29T06:00:00.000Z',
      '2026-11-29T12:00:00.000Z',
      '2026-11-29T18:00:00.000Z',
    ]);
  });

  it('several schedules merge sorted and de-duplicated', () => {
    expect(slotsOnDay(['every 12h', 'every 8h'], DAY)).toEqual([
      '2026-11-29T00:00:00.000Z',
      '2026-11-29T08:00:00.000Z',
      '2026-11-29T12:00:00.000Z',
      '2026-11-29T16:00:00.000Z',
    ]);
  });
});

describe('nextSlotAfter', () => {
  it('is strictly after now and rolls into the next UTC day', () => {
    expect(nextSlotAfter(['every 6h'], new Date('2026-11-29T06:00:00Z'))).toBe(
      '2026-11-29T12:00:00.000Z',
    );
    expect(nextSlotAfter(['every 12h'], new Date('2026-11-29T13:00:00Z'))).toBe(
      '2026-11-30T00:00:00.000Z',
    );
  });

  it('is null when no schedule is valid', () => {
    expect(nextSlotAfter(['not a schedule'], new Date('2026-11-29T10:00:00Z'))).toBeNull();
  });
});
