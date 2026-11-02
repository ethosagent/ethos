---
paths:
  - "extensions/session-sqlite/**"
  - "extensions/*-sqlite/**"
  - "packages/sqlite/**"
  - "apps/web-api/src/repositories/**"
---

# SQLite gotchas

Session key convention
CLI sessions use cli:<cwd-basename> as the session key. Different working directories get separate conversation histories. /new in chat appends :${Date.now()} to force a fresh session.

SQLite getMessages(sessionId, { limit }) returns the most-recent limit messages in chronological order (using rowid DESC in the inner query, then reversing). This is intentional — the LLM sees the latest context, not the oldest.


STRICT SQLite tables — both sessions and messages use STRICT mode. All column types must match exactly.
@ethosagent/sqlite (node:sqlite shim) is synchronous — all SessionStore methods wrap it in async but never actually await I/O. Keep query logic tight; no async operations inside the synchronous db.prepare().run() calls.

SQLite + FTS5: rowid is a pseudo-column
SELECT * does not include rowid. The FTS5 external content table uses triggers that reference new.rowid — this works because rowid is SQLite's implicit integer row ID, distinct from any TEXT PRIMARY KEY you declare. When you need rowid in a subquery result (e.g. for tie-breaking), you must explicitly select it: SELECT *, rowid AS _row FROM messages. The outer query can then ORDER BY _row.

The symptom when you forget: SqliteError: no such column: rowid on the outer ORDER BY.

SQLite: same-timestamp inserts need rowid tie-breaking
getMessages(sessionId, { limit }) returns the most-recent N messages in chronological order. The inner query sorts DESC to pick the tail, the outer reverses to ASC. When multiple messages share the same timestamp (common in tests and fast insert loops), the DESC order is non-deterministic without a secondary key. Always use ORDER BY timestamp DESC, rowid DESC in the inner query and ORDER BY timestamp ASC, rowid ASC in the outer.

STRICT tables in SQLite
Both sessions and messages use STRICT mode. This means column type enforcement is real — inserting a TEXT into an INTEGER column throws immediately instead of silently coercing. Keep all values properly typed when calling .run().

getMessages returns newest N, not oldest N
The SessionStore.getMessages(sessionId, { limit }) contract returns the most-recent limit messages in chronological order. This is the tail of the history, not the head. The in-memory and SQLite implementations both use a DESC-then-reverse pattern. If you see the agent losing recent context on long conversations, this is the first thing to check.

SQLite — @ethosagent/sqlite wraps node:sqlite
@ethosagent/sqlite wraps Node 24's built-in node:sqlite (DatabaseSync) with a synchronous API. No native dependencies — no prebuild downloads, no C++ compilation needed. Import: `import Database from '@ethosagent/sqlite'`.
