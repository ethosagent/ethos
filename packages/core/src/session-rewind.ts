import type { Session, SessionStore, StoredMessage } from '@ethosagent/types';
import { EthosError } from '@ethosagent/types';
import { forkSession } from './session-fork';
import { VOICE_ORIGIN_TAG } from './voice-origin';

export interface RewindPoint {
  /** 1 = the latest `role: 'user'` row; `user_steer` rows are not prompts. */
  turnsBack: number;
  messageId: string;
  /** The prompt with the `<attachments>` and voice-origin annotations removed. */
  text: string;
  /** The row carried attachments (annotation or `contentBlocks`) that an edit will not re-send. */
  hadAttachments: boolean;
}

export type RewindTarget = { messageId: string } | { turnsBack: number };

export interface RewindSessionResult {
  session: Session;
  idMap: Map<string, StoredMessage>;
  point: RewindPoint;
}

// Shapes written by buildAttachmentAnnotation (attachment-annotation.ts) and
// buildVoiceOriginAnnotation (voice-origin.ts); the context assembler joins each
// annotation to the next part with a blank line.
const ATTACHMENTS_BLOCK = /^<attachments>\n[\s\S]*?\n<\/attachments>(?:\n\n|$)/;
const VOICE_BLOCK = new RegExp(`^<${VOICE_ORIGIN_TAG} [^\\n]*/>\\n[^\\n]*(?:\\n\\n|$)`);

/**
 * The text a user would edit: the stored prompt without the leading
 * `<attachments>` and voice-origin annotation blocks, trimmed. Inline
 * attachment text after the annotations stays in `text`.
 */
export function editablePromptText(
  content: string,
  contentBlocks?: readonly unknown[],
): { text: string; hadAttachments: boolean } {
  let rest = content;
  let hadAttachments = (contentBlocks?.length ?? 0) > 0;
  for (;;) {
    const att = ATTACHMENTS_BLOCK.exec(rest);
    if (att) {
      hadAttachments = true;
      rest = rest.slice(att[0].length);
      continue;
    }
    const voice = VOICE_BLOCK.exec(rest);
    if (voice) {
      rest = rest.slice(voice[0].length);
      continue;
    }
    break;
  }
  return { text: rest.trim(), hadAttachments };
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
