import { hostTimeZone } from '@ethosagent/config';
import { describe, expect, it } from 'vitest';
import { digestTimeZone } from '../lib/initiative-tick';

describe('digestTimeZone', () => {
  it('uses notifications.timezone, the zone quiet hours use', () => {
    expect(digestTimeZone({ notifications: { timezone: 'Asia/Kolkata' } })).toBe('Asia/Kolkata');
  });

  it("falls back to the host's zone", () => {
    expect(digestTimeZone({})).toBe(hostTimeZone());
    expect(digestTimeZone({ notifications: { quietHours: '22:00-07:00' } })).toBe(hostTimeZone());
  });
});
