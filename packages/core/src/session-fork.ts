import { randomBytes } from 'node:crypto';
import type { Session, SessionStore, StoredMessage } from '@ethosagent/types';
import { EthosError } from '@ethosagent/types';

export interface ForkSessionOptions {
  /** The new session's key. Caller-supplied so each surface keeps its own key convention. */
  key: string;
  /** Bind the fork to a different personality. Absent = inherit the source's. */
  personalityId?: string;
  /**
   * Copy history up to and INCLUDING this message, then stop. Absent = the full
   * history. Refused when the cut would leave a `tool_use` in the fork whose
   * `tool_result` sits after the cut.
   */
  upToMessageId?: string;
}

/**
 * A new fork's session key: `<prefix>:fork:<ms>-<8 hex>`. Every surface builds
 * its fork key here (web-api, the CLI/TUI `/fork`, the gateway `/fork`).
 *
 * The millisecond keeps the readable `…:fork:<ts>` convention; the random
 * suffix is what makes the key unique. `Date.now()` alone gave two forks of one
 * session in the same millisecond the same key, and the second hit the
 * sessions UNIQUE(key) constraint. A suffix rather than retry-on-conflict: the
 * stores report a duplicate key differently (session-sqlite throws a
 * constraint error, the in-memory store does not check at all), and a
 * look-then-create retry would still race a second process. Nothing parses a
 * fork key — `listBranches` finds forks through `parentSessionId` — so the
 * suffix changes no reader. Pinned by
 * extensions/session-sqlite/src/__tests__/fork-key.test.ts.
 */
export function forkSessionKey(prefix: string, now: number = Date.now()): string {
  return `${prefix}:fork:${now}-${randomBytes(4).toString('hex')}`;
}

export interface ForkSessionResult {
  session: Session;
  /**
   * Source message id → the message appended into the fork. A copy never keeps
   * its source id (`appendMessage` mints a fresh id and timestamp), so any
   * record keyed by a source message id — web-api's context log, for one —
   * needs this map to follow the copy.
   */
  idMap: Map<string, StoredMessage>;
}

/**
 * Fork `sourceId` into a new child session: the ONE copy of this logic, shared
 * by web-api, the ACP server, the CLI/TUI and the gateway (plan
 * openclaw-9.5-adoption D27).
 *
 * The fork inherits `platform/model/provider/personalityId/workingDir/title/
 * metadata`, points `parentSessionId` at the source, and starts with zero
 * usage. History is replayed in order with no limit, and every `StoredMessage`
 * field is carried over except the three the store owns (`id`, `sessionId`,
 * `timestamp`) — copied generically, so a field added to `StoredMessage` later
 * is not silently dropped. The decision rows the copied history anchors come
 * along (`copyDecisions`), as web-api copies a fork's cards. Pinned by
 * packages/core/src/__tests__/session-fork.test.ts.
 *
 * On a failure after the child session exists, the half-built child is deleted
 * before the error is rethrown.
 */
export async function forkSession(
  store: SessionStore,
  sourceId: string,
  opts: ForkSessionOptions,
): Promise<ForkSessionResult> {
  const source = await store.getSession(sourceId);
  if (!source) {
    throw new EthosError({
      code: 'SESSION_NOT_FOUND',
      cause: `session not found: ${sourceId}`,
      action: 'Check the session id and try again.',
    });
  }

  // No `limit`: both shipped stores return the whole history, oldest first.
  const all = await store.getMessages(source.id);
  const history = opts.upToMessageId ? cutHistory(all, opts.upToMessageId) : all;

  const personalityId = opts.personalityId ?? source.personalityId;
  const session = await store.createSession({
    key: opts.key,
    platform: source.platform,
    model: source.model,
    provider: source.provider,
    ...(personalityId ? { personalityId } : {}),
    parentSessionId: source.id,
    ...(source.workingDir ? { workingDir: source.workingDir } : {}),
    ...(source.title ? { title: source.title } : {}),
    ...(source.metadata ? { metadata: source.metadata } : {}),
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      estimatedCostUsd: 0,
      apiCallCount: 0,
      compactionCount: 0,
    },
  });

  const idMap = new Map<string, StoredMessage>();
  try {
    for (const message of history) {
      const { id, sessionId: _sessionId, timestamp: _timestamp, ...fields } = message;
      idMap.set(id, await store.appendMessage({ ...fields, sessionId: session.id }));
    }
    await copyDecisions(store, source.id, session.id, history);
  } catch (err) {
    await store.deleteSession(session.id).catch(() => {});
    throw err;
  }

  return { session, idMap };
}

/**
 * Copy the decision rows the copied history anchors (plan
 * decision-provider-personality §15.5): a row whose `toolCallId` is a copied
 * call, or whose `traceId` a copied message carries — the same anchors
 * `sessions.messages` pages them by. A copied message keeps its `toolCalls`,
 * `toolCallId` and `traceId`, so the copied rows' anchors still resolve in the
 * fork and its reload shows the same trail. A cut fork leaves behind the rows
 * of the turns it cut. A store without the optional decision methods has no
 * rows to copy.
 */
async function copyDecisions(
  store: SessionStore,
  sourceId: string,
  forkId: string,
  history: StoredMessage[],
): Promise<void> {
  if (!store.getDecisions || !store.appendDecision) return;
  const toolCallIds = new Set<string>();
  const traceIds = new Set<string>();
  for (const m of history) {
    if (m.toolCallId) toolCallIds.add(m.toolCallId);
    for (const call of m.toolCalls ?? []) toolCallIds.add(call.id);
    if (m.traceId) traceIds.add(m.traceId);
  }
  if (toolCallIds.size === 0 && traceIds.size === 0) return;
  const rows = await store.getDecisions(sourceId, {
    toolCallIds: [...toolCallIds],
    traceIds: [...traceIds],
  });
  for (const row of rows) await store.appendDecision(forkId, row.event);
}

function cutHistory(all: StoredMessage[], upToMessageId: string): StoredMessage[] {
  const index = all.findIndex((m) => m.id === upToMessageId);
  if (index === -1) {
    throw new EthosError({
      code: 'INVALID_INPUT',
      cause: `message ${upToMessageId} is not in this session`,
      action: 'Pick a message from the session being forked.',
    });
  }
  const kept = all.slice(0, index + 1);

  // Anthropic requires every tool_use to be answered by a tool_result in the
  // next user message. A call left unanswered inside the kept prefix is a split
  // only if its answer exists AFTER the cut — a call that was never answered at
  // all (an interrupted turn) is the source's own state and is copied as-is.
  const answered = new Set<string>();
  for (const m of kept) if (m.role === 'tool_result' && m.toolCallId) answered.add(m.toolCallId);
  const pending = new Set<string>();
  for (const m of kept)
    for (const call of m.toolCalls ?? []) if (!answered.has(call.id)) pending.add(call.id);
  const split = all
    .slice(index + 1)
    .some(
      (m) => m.role === 'tool_result' && m.toolCallId !== undefined && pending.has(m.toolCallId),
    );
  if (split) {
    throw new EthosError({
      code: 'INVALID_INPUT',
      cause: `forking at message ${upToMessageId} would separate a tool call from its result`,
      action: 'Fork at the last tool result of that step, or at the message before the tool call.',
    });
  }
  return kept;
}

/**
 * The branch family `/branches` and `/branch <n>` number: the session a branch
 * was forked from (or `sessionId` itself, when it is not a fork) followed by
 * that session's direct forks, oldest first. Reads children through
 * `listSessions({ parentSessionId })` — an indexed lookup in session-sqlite
 * (`idx_sessions_parent`), never a scan of every session. Empty when
 * `sessionId` does not exist.
 */
export async function listBranches(store: SessionStore, sessionId: string): Promise<Session[]> {
  const current = await store.getSession(sessionId);
  if (!current) return [];
  const anchor =
    (current.parentSessionId ? await store.getSession(current.parentSessionId) : null) ?? current;
  const children = await store.listSessions({ parentSessionId: anchor.id });
  children.sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.key.localeCompare(b.key),
  );
  return [anchor, ...children];
}
