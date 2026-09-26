import type Database from '@ethosagent/sqlite';
import type { AgentEvent, StoredDecision } from '@ethosagent/types';

// Decision rows for `SQLiteSessionStore.appendDecision` / `getDecisions` (plan
// decision-provider-personality §15.5, PD18). One `settled` `decision` event
// per row, in sessions.db on the store's own handle — so it shares the store's
// `synchronous = FULL` posture (CLAUDE.md "SQLite durability posture") and its
// `foreign_keys = ON`, which is what makes `ON DELETE CASCADE` take a session's
// rows with it on `deleteSession` and `pruneOldSessions`. The in-memory twin is
// `InMemorySessionStore` (packages/core); both are pinned by
// src/__tests__/session-decisions.test.ts.
//
// Additive: `CREATE ... IF NOT EXISTS`, no `ALTER` of the STRICT `messages`
// table and no `user_version` bump — the store_meta precedent in `migrate()`.
// `trace_id` / `tool_call_id` are copies of the event's fields, held as columns
// so a page of messages can select the rows it anchors without parsing JSON.

type DecisionEvent = Extract<AgentEvent, { type: 'decision' }>;

export const SESSION_DECISIONS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS session_decisions (
    session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq          INTEGER NOT NULL,
    trace_id     TEXT,
    tool_call_id TEXT,
    event        TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS idx_session_decisions_trace ON session_decisions(session_id, trace_id);
`;

interface DecisionRow {
  session_id: string;
  seq: number;
  event: string;
  created_at: string;
}

/**
 * Insert one row. `seq` is MAX()+1 for the session, computed inside the
 * single INSERT ... SELECT statement, so two writers on one file cannot take
 * the same number (the PK would refuse it anyway).
 */
export function appendDecisionRow(
  db: Database.Database,
  sessionId: string,
  event: DecisionEvent,
): StoredDecision {
  const createdAt = new Date();
  const row = db
    .prepare(
      `INSERT INTO session_decisions (session_id, seq, trace_id, tool_call_id, event, created_at)
       SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ? FROM session_decisions WHERE session_id = ?
       RETURNING seq`,
    )
    .get(
      sessionId,
      event.traceId ?? null,
      event.toolCallId ?? null,
      JSON.stringify(event),
      createdAt.toISOString(),
      sessionId,
    ) as { seq: number };
  return { sessionId, seq: row.seq, event, createdAt };
}

export function readDecisionRows(
  db: Database.Database,
  sessionId: string,
  filter?: { toolCallIds?: readonly string[]; traceIds?: readonly string[] },
): StoredDecision[] {
  const params: string[] = [sessionId];
  let where = '';
  if (filter) {
    const toolCallIds = filter.toolCallIds ?? [];
    const traceIds = filter.traceIds ?? [];
    if (toolCallIds.length === 0 && traceIds.length === 0) return [];
    const clauses: string[] = [];
    if (toolCallIds.length > 0) {
      clauses.push(`tool_call_id IN (${toolCallIds.map(() => '?').join(',')})`);
      params.push(...toolCallIds);
    }
    if (traceIds.length > 0) {
      clauses.push(`trace_id IN (${traceIds.map(() => '?').join(',')})`);
      params.push(...traceIds);
    }
    where = ` AND (${clauses.join(' OR ')})`;
  }
  const rows = db
    .prepare(
      `SELECT session_id, seq, event, created_at FROM session_decisions
       WHERE session_id = ?${where} ORDER BY seq ASC`,
    )
    .all(...params) as DecisionRow[];
  const out: StoredDecision[] = [];
  for (const r of rows) {
    const event = parseEvent(r.event);
    // A row that no longer parses is skipped, not fatal: one bad row must not
    // take the session's history down with it (the session-cards posture).
    if (event) {
      out.push({ sessionId: r.session_id, seq: r.seq, event, createdAt: new Date(r.created_at) });
    }
  }
  return out;
}

function parseEvent(text: string): DecisionEvent | null {
  try {
    const value = JSON.parse(text) as { type?: unknown } | null;
    return value && typeof value === 'object' && value.type === 'decision'
      ? (value as DecisionEvent)
      : null;
  } catch {
    return null;
  }
}
