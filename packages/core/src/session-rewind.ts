import type { Session, SessionStore, StoredMessage } from '@ethosagent/types';
import { EthosError, editablePromptText } from '@ethosagent/types';
import { forkSession } from './session-fork';

export interface RewindPoint {
  /** 1 = the latest `role: 'user'` row; `user_steer` rows are not prompts. */
  turnsBack: number;
  messageId: string;
  /** The prompt with the `<attachments>` and voice-origin annotations removed. */
  text: string;
  /** The row carried attachments (annotation or `contentBlocks`) that an edit will not re-send. */
  hadAttachments: boolean;
}

// The annotation stripper lives in contracts so the browser can use it too.
export { editablePromptText };

export type RewindTarget = { messageId: string } | { turnsBack: number };

export interface RewindSessionResult {
  session: Session;
  idMap: Map<string, StoredMessage>;
  point: RewindPoint;
}

/**
 * Every prompt a session can be rewound to, newest first; [] for an unknown
 * session. Reads the whole history like `forkSession` does. Soft-deleted
 * (`/undo`) rows are not returned by `getMessages`, so they are neither listed
 * nor counted. Pinned by packages/core/src/__tests__/session-rewind.test.ts and
 * extensions/session-sqlite/src/__tests__/rewind-points.test.ts.
 */
export async function listRewindPoints(
  store: SessionStore,
  sessionId: string,
): Promise<RewindPoint[]> {
  const session = await store.getSession(sessionId);
  if (!session) return [];
  const rows = (await store.getMessages(session.id)).filter((m) => m.role === 'user');
  return rows.reverse().map((m, i) => ({
    turnsBack: i + 1,
    messageId: m.id,
    ...editablePromptText(m.content, m.contentBlocks),
  }));
}

/**
 * Fork `sessionId` just before a chosen prompt, parented at the family root so
 * the flat branch list shows the origin. Throws INVALID_INPUT for an
 * out-of-range `turnsBack` or a `messageId` that is not a prompt, and
 * SESSION_NOT_FOUND for an unknown session (via forkSession). Pinned by
 * packages/core/src/__tests__/session-rewind.test.ts and
 * extensions/session-sqlite/src/__tests__/rewind-points.test.ts.
 */
export async function rewindSession(
  store: SessionStore,
  sessionId: string,
  opts: { key: string; target: RewindTarget },
): Promise<RewindSessionResult> {
  const source = await store.getSession(sessionId);
  if (!source) {
    throw new EthosError({
      code: 'SESSION_NOT_FOUND',
      cause: `session not found: ${sessionId}`,
      action: 'Check the session id and try again.',
    });
  }
  const points = await listRewindPoints(store, source.id);
  const { target } = opts;
  const point =
    'messageId' in target
      ? points.find((p) => p.messageId === target.messageId)
      : points.find((p) => p.turnsBack === target.turnsBack);
  if (!point) {
    throw new EthosError({
      code: 'INVALID_INPUT',
      cause:
        'messageId' in target
          ? `message ${target.messageId} is not a user prompt in this session`
          : `turnsBack ${target.turnsBack} is outside 1..${points.length}`,
      action:
        points.length > 0
          ? `Pick a prompt between 1 and ${points.length} back.`
          : 'This session has no prompts to rewind to.',
    });
  }
  const { session, idMap } = await forkSession(store, source.id, {
    key: opts.key,
    beforeMessageId: point.messageId,
    parentSessionId: source.parentSessionId ?? source.id,
  });
  return { session, idMap, point };
}
