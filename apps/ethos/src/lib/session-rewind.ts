import { parseRewindArg, REWIND_NOTICE } from '@ethosagent/surface-kit';
import { EthosError, type SessionStore } from '@ethosagent/types';
import {
  forkSessionKey,
  listRewindPoints,
  type RewindPoint,
  rewindSession,
} from '@ethosagent/wiring';

export interface PendingRewind {
  messageId: string;
  text: string;
  hadAttachments: boolean;
  turnsBack: number;
}

const NOTHING_TO_REWIND = 'Nothing to rewind yet — send a message first.';

/** Every prompt the session at `sessionKey` can be rewound to, newest first. */
export async function rewindPointsFor(
  store: SessionStore,
  sessionKey: string,
): Promise<RewindPoint[]> {
  const current = await store.getSessionByKey(sessionKey);
  return current ? listRewindPoints(store, current.id) : [];
}

/**
 * Resolve `/rewind [N]` to the prompt to edit. Read-only: the branch is created
 * by `commitRewind` when the edited prompt is sent, so cancelling leaves no
 * orphan branch (plan decision 2).
 */
export async function prepareRewind(
  store: SessionStore,
  arg: string,
  sessionKey: string,
): Promise<{ message: string; pending?: PendingRewind }> {
  const parsed = parseRewindArg(arg);
  if (!parsed.ok) return { message: parsed.message };
  const points = await rewindPointsFor(store, sessionKey);
  if (points.length === 0) return { message: NOTHING_TO_REWIND };
  const point = points.find((p) => p.turnsBack === parsed.turnsBack);
  if (!point) {
    return {
      message: `Only ${points.length} prompt${points.length === 1 ? '' : 's'} in this session.`,
    };
  }
  const attachments = point.hadAttachments ? ' Attached files are not re-sent.' : '';
  return {
    message: `Editing prompt ${point.turnsBack} back. Enter runs it on a new branch; an empty line or any /command cancels. ${REWIND_NOTICE}${attachments}`,
    pending: {
      messageId: point.messageId,
      text: point.text,
      hadAttachments: point.hadAttachments,
      turnsBack: point.turnsBack,
    },
  };
}

/**
 * Create the rewound branch: keyed under the current session's key (plan
 * decision 7, so incognito cleanup by key prefix covers it) and parented at the
 * family root by `rewindSession`. Throws EthosError for an unknown session or a
 * prompt that is no longer in it.
 */
export async function commitRewind(
  store: SessionStore,
  sessionKey: string,
  messageId: string,
): Promise<{ message: string; switchTo: { sessionKey: string; personalityId?: string } }> {
  const current = await store.getSessionByKey(sessionKey);
  if (!current) {
    throw new EthosError({
      code: 'SESSION_NOT_FOUND',
      cause: NOTHING_TO_REWIND,
      action: 'Send a message first.',
    });
  }
  const { session } = await rewindSession(store, current.id, {
    key: forkSessionKey(current.key),
    target: { messageId },
  });
  return {
    message: 'Rewound — now on a new branch. /branches lists them, /branch <n> switches.',
    switchTo: {
      sessionKey: session.key,
      ...(session.personalityId ? { personalityId: session.personalityId } : {}),
    },
  };
}
