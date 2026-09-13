import type Database from '@ethosagent/sqlite';
import type { MessagePage, MessagePageOptions, StoredMessage } from '@ethosagent/types';

// Turn-based keyset paging for `SQLiteSessionStore.getMessagePage`. Page
// semantics live on `MessagePageOptions` (packages/types/src/session.ts); the
// in-memory twin is `InMemorySessionStore.getMessagePage` and both are pinned
// by src/__tests__/message-page.test.ts, which also asserts every query below
// is a SEARCH through `idx_messages_session` (the cursor lookup uses the PK).
//
// Position is `(timestamp, rowid)` — the same order `getMessages` uses. The
// row-value comparison `(timestamp, rowid) < (?, ?)` is a range on
// `idx_messages_session (session_id, timestamp)`, whose implicit trailing rowid
// also satisfies `ORDER BY timestamp DESC, rowid DESC` without a temp B-tree.

/** Resolve a cursor row to its position. Deliberately ignores `deleted_at`. */
export const messagePageCursorSql =
  'SELECT timestamp, rowid AS _row FROM messages WHERE id = ? AND session_id = ?';

const BEFORE = 'AND (timestamp, rowid) < (?, ?)';

/**
 * The Nth-newest live user row before the cursor, plus the one older than it.
 * Params: sessionId, [cursorTimestamp, cursorRowid], turns - 1.
 */
export function messagePageBoundarySql(hasCursor: boolean): string {
  return `SELECT timestamp, rowid AS _row FROM messages
    WHERE session_id = ? AND deleted_at IS NULL AND role = 'user' ${hasCursor ? BEFORE : ''}
    ORDER BY timestamp DESC, rowid DESC LIMIT 2 OFFSET ?`;
}

/**
 * Live rows between the boundary (inclusive) and the cursor (exclusive), newest
 * first. Params: sessionId, [cursorTimestamp, cursorRowid], [lowTimestamp, lowRowid].
 */
export function messagePageRangeSql(hasCursor: boolean, hasLowerBound: boolean): string {
  return `SELECT *, rowid AS _row FROM messages
    WHERE session_id = ? AND deleted_at IS NULL ${hasCursor ? BEFORE : ''}
      ${hasLowerBound ? 'AND (timestamp, rowid) >= (?, ?)' : ''}
    ORDER BY timestamp DESC, rowid DESC`;
}

interface Position {
  timestamp: string;
  _row: number;
}

/** The columns the page walk reads; the full row is handed to `toMessage`. */
interface PageRow {
  role: string;
  content: string;
  tool_calls: string | null;
}

export function readMessagePage<R extends PageRow>(
  db: Database.Database,
  sessionId: string,
  options: MessagePageOptions,
  toMessage: (row: R) => StoredMessage,
): MessagePage | null {
  const { turns, beforeMessageId, maxBytes } = options;
  if (!Number.isInteger(turns) || turns < 1) {
    throw new RangeError(`turns must be an integer >= 1, got ${turns}`);
  }

  let cursor: Position | undefined;
  if (beforeMessageId !== undefined) {
    cursor = db.prepare(messagePageCursorSql).get(beforeMessageId, sessionId) as
      | Position
      | undefined;
    if (!cursor) return null;
  }
  const cursorParams = cursor ? [cursor.timestamp, cursor._row] : [];

  // Two rows back means a user row older than the Nth exists, so the page
  // starts exactly at the Nth. Fewer means the page reaches the start of the
  // session and takes any rows before the first user message with it.
  const boundary = db
    .prepare(messagePageBoundarySql(cursor !== undefined))
    .all(sessionId, ...cursorParams, turns - 1) as Position[];
  const lower = boundary.length === 2 ? boundary[0] : undefined;
  const lowerParams = lower ? [lower.timestamp, lower._row] : [];

  const accepted: R[][] = [];
  let turn: R[] = [];
  let turnBytes = 0;
  let total = 0;
  let hasMore = lower !== undefined;

  const rows = db
    .prepare(messagePageRangeSql(cursor !== undefined, lower !== undefined))
    .iterate(sessionId, ...cursorParams, ...lowerParams) as Iterable<R>;
  for (const row of rows) {
    turn.push(row);
    turnBytes +=
      Buffer.byteLength(row.content) + (row.tool_calls ? Buffer.byteLength(row.tool_calls) : 0);
    if (row.role !== 'user') continue;
    if (accepted.length > 0 && maxBytes !== undefined && total + turnBytes > maxBytes) {
      hasMore = true;
      turn = [];
      break;
    }
    accepted.push(turn);
    total += turnBytes;
    turn = [];
    turnBytes = 0;
  }

  // Rows left over are older than every user row read, which only happens when
  // the range ran to the start of the session: they count toward the oldest turn.
  if (turn.length > 0) {
    const oldest = accepted.at(-1);
    if (!oldest) {
      accepted.push(turn);
    } else if (accepted.length === 1 || maxBytes === undefined || total + turnBytes <= maxBytes) {
      oldest.push(...turn);
    } else {
      accepted.pop();
      hasMore = true;
    }
  }

  return { messages: accepted.flat().reverse().map(toMessage), hasMore };
}
