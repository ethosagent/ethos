// U11 (openclaw-9.6-gaps) — `notifications.*` resolves into the gateway's quiet
// hours with an explicit time zone: the configured one, else the host's.

import { hostTimeZone } from '@ethosagent/config';
import { describe, expect, it } from 'vitest';
import { resolveGatewayQuietHours } from '../commands/gateway';

describe('resolveGatewayQuietHours', () => {
  it('is undefined when no window is configured', () => {
    expect(resolveGatewayQuietHours(undefined)).toBeUndefined();
    expect(resolveGatewayQuietHours({ timezone: 'UTC' })).toBeUndefined();
  });

  it('parses the window and keeps the configured zone', () => {
    expect(resolveGatewayQuietHours({ quietHours: '22:00-07:00', timezone: 'Asia/Tokyo' })).toEqual(
      { timeZone: 'Asia/Tokyo', window: { startMinute: 1320, endMinute: 420 } },
    );
  });

  it('defaults the zone to the host’s and maps a per-bot off to null', () => {
    expect(
      resolveGatewayQuietHours({
        quietHours: '22:00-07:00',
        bots: { 'bot-a': { quietHours: 'off' }, 'bot-b': { quietHours: '23:00-06:00' } },
      }),
    ).toEqual({
      timeZone: hostTimeZone(),
      window: { startMinute: 1320, endMinute: 420 },
      byBot: { 'bot-a': null, 'bot-b': { startMinute: 1380, endMinute: 360 } },
    });
  });
});
