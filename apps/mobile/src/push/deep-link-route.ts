import { parseDeepLink } from '../auth/deep-link';
import { taskPath } from '../features/teams/routes';

export interface PushTapInput {
  /** `content.data.category` — one of the server's five `PushCategory`
   *  values (`apps/web-api/src/services/push-dispatcher.ts`). */
  category?: unknown;
  /** `content.data.deepLink` — an `ethos://` string, or `null`/absent
   *  (always `null` for a cron-failure push, D11). */
  deepLink?: unknown;
  /** `content.threadIdentifier` — the session an approval/clarify push
   *  belongs to. The payload's own `deepLink` names only the personality
   *  (D11's minimal payload never carries a session id), so this is
   *  preferred when present. iOS-only: Android has no thread grouping, so
   *  it is always empty there and the `deepLink` fallback below is what
   *  Android actually uses. */
  sessionId?: string;
}

/**
 * Maps a plain-tap push notification to an expo-router path, or `null` for no
 * navigation (an unrecognized/empty payload — leave the app wherever the OS
 * foregrounded it).
 */
export function deepLinkToRoute(input: PushTapInput): string | null {
  const category = typeof input.category === 'string' ? input.category : undefined;

  if (category === 'approvals' || category === 'clarify') {
    if (input.sessionId) return `/chat/${encodeURIComponent(input.sessionId)}`;
    const deepLink = typeof input.deepLink === 'string' ? input.deepLink : null;
    const link = deepLink ? parseDeepLink(deepLink) : null;
    return link?.kind === 'chat'
      ? `/chat/new?personalityId=${encodeURIComponent(link.personalityId)}`
      : '/chat';
  }
  // A team-attention push names its task (`ethos://t/<team>/task/<id>`) and
  // lands there, as a `task` OS link does (`app/+native-intent.ts`); one
  // without a parseable link opens Teams.
  if (category === 'teamAttention') {
    const deepLink = typeof input.deepLink === 'string' ? input.deepLink : null;
    const link = deepLink ? parseDeepLink(deepLink) : null;
    return link?.kind === 'task' ? taskPath(link.team, link.taskId) : '/teams';
  }
  // Cron-failure and run-finished pushes have no chat context: Activity.
  if (category === 'cronFailures' || category === 'runFinished') {
    return '/activity';
  }
  return null;
}
