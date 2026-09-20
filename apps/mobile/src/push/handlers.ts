import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { clientId } from '../features/chat/session';
import { useConnection } from '../state/connection';
import { ALLOW_ONCE_ACTION, DENY_ACTION } from './categories';
import { deepLinkToRoute } from './deep-link-route';
import { scheduleResolvedNotification } from './resolved-row';

// The one action path (T4): `addNotificationResponseReceivedListener` fires
// whether the app was foregrounded, backgrounded, or launched into the
// background by iOS to deliver a killed-app action. An identity string is
// never sent from here — the server stamps `human:key:<name>` from the
// bearer key (S9).

/** The server never sends the tool name in the push `data` (D11's minimal
 *  payload); the notification's own body carries it in the fallback text the
 *  dispatcher writes (`push-dispatcher.ts`'s `approvalNotification`, before
 *  any Notification Service Extension rewrite): `Wants to run <tool> · …`. */
function toolNameFromBody(body: string | null | undefined): string {
  return /Wants to run (.+?) ·/.exec(body ?? '')?.[1] ?? 'tool';
}

/** `push.test`'s fixture (`data.test: true`, `approvalId` prefixed `test-`):
 *  no server approval exists for it, so it resolves locally — the onboarding
 *  demo works without a real pending approval. */
function isTestApproval(approvalId: string): boolean {
  return approvalId.startsWith('test-');
}

async function decideApproval(approvalId: string, allow: boolean): Promise<void> {
  if (isTestApproval(approvalId)) return;
  const rpc = useConnection.getState().client?.rpc;
  if (!rpc) return;
  if (allow) await rpc.tools.approve({ approvalId, clientId: clientId(), scope: 'once' });
  else await rpc.tools.deny({ approvalId, clientId: clientId() });
}

async function handleApprovalAction(
  actionIdentifier: string,
  approvalId: string,
  sessionId: string,
  toolName: string,
): Promise<void> {
  if (actionIdentifier !== ALLOW_ONCE_ACTION && actionIdentifier !== DENY_ACTION) return;
  const allow = actionIdentifier === ALLOW_ONCE_ACTION;
  try {
    await decideApproval(approvalId, allow);
  } catch {
    // The resolved row only ever reflects a decision that actually landed;
    // a failed decide leaves the live banner as the truth.
    return;
  }
  await scheduleResolvedNotification(approvalId, sessionId, {
    kind: allow ? 'allowed-once' : 'denied',
    toolName,
  });
}

type NotificationResponse = Parameters<
  Parameters<typeof Notifications.addNotificationResponseReceivedListener>[0]
>[0];

// Dedup between the live listener and the cold-start check below (T4): a
// killed-app launch can hand the same tap to both `getLastNotificationResponseAsync`
// and, shortly after, the listener. Routing twice would push the same screen
// twice onto the stack.
let lastRoutedNotificationId: string | null = null;

function handleResponse(response: NotificationResponse): void {
  const { actionIdentifier, notification } = response;
  const content = notification.request.content;
  const data = (content.data ?? {}) as Record<string, unknown>;
  // `threadIdentifier` is iOS-only on `NotificationContent`'s union (Android
  // has no thread grouping); read defensively since this handler runs on
  // both platforms.
  const sessionId = (content as { threadIdentifier?: string | null }).threadIdentifier ?? '';
  // A clarify push carries no actions (D11, `./categories`): it has nothing
  // to do here and opens the app on tap like any other non-interactive
  // notification.
  if (data.category === 'approvals' && typeof data.approvalId === 'string') {
    void handleApprovalAction(
      actionIdentifier,
      data.approvalId,
      sessionId,
      toolNameFromBody(content.body),
    );
  }
  // A plain tap (not Allow once / Deny) navigates to the thing the
  // notification is about.
  if (actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
  const id = notification.request.identifier;
  if (id && id === lastRoutedNotificationId) return;
  const route = deepLinkToRoute({
    category: data.category,
    deepLink: data.deepLink,
    sessionId: sessionId || undefined,
  });
  if (!route) return;
  if (id) lastRoutedNotificationId = id;
  router.navigate(route);
}

/** Registered once at app start (`app/_layout.tsx`). Reads the connection's
 *  current client lazily on each response, so it can be registered before a
 *  connection is restored from the Keychain. */
export function registerNotificationResponseHandler(): () => void {
  const subscription = Notifications.addNotificationResponseReceivedListener(handleResponse);
  return () => subscription.remove();
}

/** Cold start (T4): a tap that launched the app from killed state never
 *  reaches the listener above — it delivers only through this one-shot check,
 *  which `app/_layout.tsx` calls once alongside registering the listener. */
export async function routeColdStartNotification(): Promise<void> {
  const response = await Notifications.getLastNotificationResponseAsync();
  if (response) handleResponse(response);
}
