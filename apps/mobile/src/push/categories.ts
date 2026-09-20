import * as Notifications from 'expo-notifications';

// The `expo-notifications` categories (D11, T4). `categoryId` strings must
// match the server's exactly (`apps/web-api/src/services/push-dispatcher.ts`):
// approvals use `'approval'`. Clarify carries NO actions — a deliberate
// deviation from the plan's "≤3 options become notification actions" (D11):
// an iOS category's action titles must be registered before the notification
// ever arrives, so a button could only ever read "Option 1/2/3", never the
// real option text, and the server's minimal payload (D11's payload-privacy
// rule) never carries that text either. A lock-screen button that cannot name
// what it picks is worse than no button, so a clarify push opens the app
// instead, where the real options are rendered and answered. Pinned by
// `__tests__/categories.test.ts` ("registers clarify with no actions").
// Cron failures, team attention, run finished and clarify carry no
// `categoryId` server-side (no interactive actions), but are registered
// anyway so a future payload can opt in without a client release.

export const APPROVAL_CATEGORY = 'approval';
export const ALLOW_ONCE_ACTION = 'allow-once';
export const DENY_ACTION = 'deny';

const NO_ACTION_CATEGORIES = ['clarify', 'cronFailures', 'teamAttention', 'runFinished'];

/** Registered on every app start (idempotent) so a reinstall or an update
 *  always has the current set (§T4). **Allow once** requires Face ID or the
 *  passcode (R10); **Deny** does not. */
export async function registerPushCategories(): Promise<void> {
  await Promise.all([
    Notifications.setNotificationCategoryAsync(APPROVAL_CATEGORY, [
      {
        identifier: ALLOW_ONCE_ACTION,
        buttonTitle: 'Allow once',
        options: { isAuthenticationRequired: true, opensAppToForeground: false },
      },
      {
        identifier: DENY_ACTION,
        buttonTitle: 'Deny',
        options: { isDestructive: true, opensAppToForeground: false },
      },
    ]),
    ...NO_ACTION_CATEGORIES.map((id) => Notifications.setNotificationCategoryAsync(id, [])),
  ]);
}
