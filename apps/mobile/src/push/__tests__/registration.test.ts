import type { EthosClient } from '@ethosagent/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `registerForPush` is awaited by fire-and-forget handlers (ob-notify's
// Enable, the Settings toggles), each of which renders its result as a row.
// So it never rejects: offline, the Expo token fetch fails like any fetch.

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0', extra: {} } } }));
vi.mock('expo-notifications', () => ({
  setNotificationChannelAsync: vi.fn(),
  setNotificationCategoryAsync: vi.fn().mockResolvedValue(undefined),
  requestPermissionsAsync: vi.fn().mockResolvedValue({ status: 'granted' }),
  getExpoPushTokenAsync: vi.fn().mockResolvedValue({ data: 'ExponentPushToken[x]' }),
  AndroidImportance: { HIGH: 4 },
}));

import * as Notifications from 'expo-notifications';
import { getCachedPushToken, registerForPush } from '../registration';

let leaked: unknown[] = [];
const collect = (reason: unknown) => leaked.push(reason);

beforeEach(() => {
  leaked = [];
  process.on('unhandledRejection', collect);
});
afterEach(() => {
  process.off('unhandledRejection', collect);
});

function rpc(register: () => Promise<unknown>): EthosClient['rpc'] {
  return { push: { register } } as unknown as EthosClient['rpc'];
}

describe('registerForPush with no network', () => {
  it('a failed Expo token fetch is a reason, not a rejection', async () => {
    vi.mocked(Notifications.getExpoPushTokenAsync).mockRejectedValueOnce(
      new TypeError('Could not connect to the server'),
    );
    const register = vi.fn(async () => ({ ok: true }));
    const result = await registerForPush(rpc(register));
    expect(result).toEqual({ registered: false, reason: 'Could not connect to the server' });
    expect(register).not.toHaveBeenCalled();
    expect(getCachedPushToken()).toBeNull();
    expect(leaked).toEqual([]);
  });

  it('an unreachable Ethos server on push.register is a reason too', async () => {
    const result = await registerForPush(
      rpc(async () => {
        throw new TypeError('Could not connect to the server');
      }),
    );
    expect(result).toEqual({ registered: false, reason: 'Could not connect to the server' });
    expect(getCachedPushToken()).toBeNull();
    expect(leaked).toEqual([]);
  });
});
