import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-notifications', () => ({
  setNotificationCategoryAsync: vi.fn().mockResolvedValue(undefined),
}));

import * as Notifications from 'expo-notifications';
import { ALLOW_ONCE_ACTION, DENY_ACTION, registerPushCategories } from '../categories';

// The categoryId strings must match the server exactly
// (push-dispatcher.ts's `approvalNotification` uses `'approval'`).
describe('registerPushCategories', () => {
  it('registers the approval category with Allow once (auth required) and Deny (not)', async () => {
    await registerPushCategories();
    const calls = vi.mocked(Notifications.setNotificationCategoryAsync).mock.calls;
    const approval = calls.find(([id]) => id === 'approval');
    expect(approval).toBeDefined();
    const actions = approval?.[1] ?? [];
    const allow = actions.find((a) => a.identifier === ALLOW_ONCE_ACTION);
    const deny = actions.find((a) => a.identifier === DENY_ACTION);
    expect(allow?.options?.isAuthenticationRequired).toBe(true);
    expect(deny?.options?.isAuthenticationRequired).not.toBe(true);
  });

  // D11 deviation: a clarify push carries no notification actions (see
  // `../categories` for why — registered titles can't name a real option,
  // and the server never sends the option text anyway).
  it('registers clarify, cronFailures, teamAttention and runFinished with no actions', async () => {
    await registerPushCategories();
    const calls = vi.mocked(Notifications.setNotificationCategoryAsync).mock.calls;
    for (const id of ['clarify', 'cronFailures', 'teamAttention', 'runFinished']) {
      const entry = calls.find(([categoryId]) => categoryId === id);
      expect(entry?.[1]).toEqual([]);
    }
  });
});
