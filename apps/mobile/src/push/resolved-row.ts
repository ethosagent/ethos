import * as Notifications from 'expo-notifications';
import { clock } from '../lib/row';

// The resolved-row replacement (T4 done-when, D15, case 19): once a notified
// approval settles — decided here, decided elsewhere, or timed out — the app
// schedules a LOCAL notification that REPLACES the original push banner in
// place, by reusing the identifier the push's `collapseId` carried
// (`identifier = approvalId`) and the thread the push's `threadId` carried
// (`threadId = sessionId`, R9d). No actions, no sound, no haptic; it
// auto-dismisses itself 60 s later.

export type ResolvedApproval =
  | { kind: 'allowed-once'; toolName: string }
  | { kind: 'denied'; toolName: string }
  | { kind: 'elsewhere' }
  | { kind: 'auto-denied' };

export function resolvedRowText(resolved: ResolvedApproval, now: number): string {
  switch (resolved.kind) {
    case 'allowed-once':
      return `✓ allowed once · ${resolved.toolName} · ${clock(now)}`;
    case 'denied':
      return `✗ denied · ${resolved.toolName}`;
    case 'elsewhere':
      return 'resolved elsewhere';
    case 'auto-denied':
      return `✗ auto-denied at ${clock(now)}`;
  }
}

// `NotificationContentInput` doesn't declare `threadIdentifier` (a gap in the
// installed package's .d.ts — the native iOS bridge record
// (`NotificationContentRecord` in expo-notifications' Swift source) carries
// it for both scheduling input and reading), so it is widened locally.
type ContentWithThread = Notifications.NotificationContentInput & { threadIdentifier?: string };

/** Pure builder, so the shape is testable without mocking the scheduler. */
export function buildResolvedNotificationInput(
  approvalId: string,
  sessionId: string,
  resolved: ResolvedApproval,
  now: number,
): Notifications.NotificationRequestInput {
  const content: ContentWithThread = {
    title: 'Ethos',
    body: resolvedRowText(resolved, now),
    data: { category: 'approvals', approvalId, resolved: resolved.kind },
    sound: false, // expo-notifications' silent flag — the plan's "sound: null"
    categoryIdentifier: undefined, // no category → no interactive actions
    threadIdentifier: sessionId,
  };
  return { identifier: approvalId, content, trigger: null };
}

export const DISMISS_AFTER_MS = 60_000;

export async function scheduleResolvedNotification(
  approvalId: string,
  sessionId: string,
  resolved: ResolvedApproval,
  now: number = Date.now(),
): Promise<void> {
  await Notifications.scheduleNotificationAsync(
    buildResolvedNotificationInput(approvalId, sessionId, resolved, now),
  );
  setTimeout(() => {
    void Notifications.dismissNotificationAsync(approvalId).catch(() => undefined);
  }, DISMISS_AFTER_MS);
}
