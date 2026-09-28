import type { MessageContent, SessionStore } from '@ethosagent/types';

// UBP-019 / V-CP-3 — which replayed image/document blocks the provider
// REJECTED. A user row persists its inline blocks before the LLM call; when the
// call fails and no assistant row follows, the next turn would resend them.
// That is right after a transient failure (an overload, a 429, a timeout, an
// abort — the user's "try again" should carry the screenshot) and wrong after a
// deterministic one (a PDF over the page limit fails the same way every time).
// So the loop records the rows of a deterministically rejected call here
// (called from `streamStep`'s llm_error path, stages/stream-step.ts), and
// context assembly degrades exactly those rows (`degradeRejectedRows`,
// vision-aging.ts). Pinned by __tests__/vision-replay-rejected.test.ts.

/** `Session.metadata` key holding the ids of rows whose blocks were rejected. */
export const VISION_REJECTED_KEY = 'visionRejectedMessageIds';

/** Newest ids kept; an older row is long past the vision recency window. */
const MAX_REJECTED_IDS = 32;

/** Rows read back to find the failed call's unanswered tail. */
const TAIL_ROWS = 50;

/**
 * A 4xx that says "this request is wrong", which resending cannot fix. 401/403
 * (credentials) and 404 (model) are about the deployment, not the attachment;
 * 408/429/5xx are transient. The structured `status`/`statusCode` an SDK error
 * carries wins; without one, only a whole-token status in the message counts.
 */
const REJECTION_STATUSES = new Set([400, 413, 415, 422]);

function statusOf(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null) {
    for (const field of ['status', 'statusCode']) {
      const value: unknown = (err as Record<string, unknown>)[field];
      const n = typeof value === 'number' ? value : Number.NaN;
      if (n >= 100 && n <= 599) return n;
    }
  }
  const msg = err instanceof Error ? err.message : String(err);
  const token = /\b([1-5]\d\d)\b/.exec(msg);
  return token ? Number(token[1]) : undefined;
}

export function isDeterministicRejection(err: unknown): boolean {
  const status = statusOf(err);
  return status !== undefined && REJECTION_STATUSES.has(status);
}

/** The recorded ids, defensively read (metadata is a JSON column). */
export function readVisionRejected(metadata: Record<string, unknown> | undefined): Set<string> {
  const raw = metadata?.[VISION_REJECTED_KEY];
  return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []);
}

function hasVisionBlock(blocks: MessageContent[] | undefined): boolean {
  return (blocks ?? []).some((b) => b.type === 'image' || b.type === 'document');
}

/**
 * Record the rows whose blocks the failed call carried unanswered: every
 * `user`/`user_steer` row with an image/document block after the last
 * assistant row. A block an earlier call of the same turn already got an
 * answer for is not the cause and is not recorded. Read-merge-write, because
 * `updateSession` replaces `metadata` wholesale (same as `persistLoaded`,
 * stages/tool-search.ts).
 */
export async function recordVisionRejection(
  session: SessionStore,
  sessionId: string,
): Promise<void> {
  const tail = await session.getMessages(sessionId, { limit: TAIL_ROWS });
  const ids: string[] = [];
  for (let i = tail.length - 1; i >= 0; i--) {
    const row = tail[i];
    if (!row || row.role === 'assistant') break;
    if ((row.role === 'user' || row.role === 'user_steer') && hasVisionBlock(row.contentBlocks)) {
      ids.push(row.id);
    }
  }
  if (ids.length === 0) return;
  const current = await session.getSession(sessionId);
  const known = readVisionRejected(current?.metadata);
  const merged = [...known, ...ids.reverse().filter((id) => !known.has(id))];
  await session.updateSession(sessionId, {
    metadata: {
      ...(current?.metadata ?? {}),
      [VISION_REJECTED_KEY]: merged.slice(-MAX_REJECTED_IDS),
    },
  });
}
