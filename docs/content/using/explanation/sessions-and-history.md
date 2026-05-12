---
title: "Why are sessions scoped per working directory?"
description: "CLI sessions key on cwd basename — each project gets its own history. SQLite + WAL + FTS5 stores it; getMessages returns the newest N, not the oldest."
kind: explanation
audience: user
slug: sessions-and-history
updated: 2026-05-12
---

## Context

A [session](../../getting-started/glossary.md#session) in Ethos is a persistent conversation history identified by a session key. Restart the CLI and your context comes back. Switch from CLI to Telegram with the same key and the same conversation continues. The session is the *thread of work*, not the process.

That raises an obvious design question: when does a thread start, and when does it end? The choice Ethos makes is to scope sessions per working directory. `ethos chat` in `~/projects/api` is a different session from `ethos chat` in `~/projects/site`. Both persist independently. Neither pollutes the other.

This page explains why that key shape, why `/new` clears, and what the storage layer guarantees about message order.

## Discussion

### Sessions key on `cli:<cwd-basename>`

The CLI computes its session key by taking the basename of the current working directory and prefixing it with `cli:`. Running `ethos chat` from `~/projects/api` produces session key `cli:api`. Running it from `~/projects/site` produces `cli:site`. They are two rows in the `sessions` table, with two independent message histories.

This is a deliberate choice, not an accident. Three properties fall out of it:

- **Same project, same thread.** Quitting and re-running `ethos chat` in `~/projects/api` finds `cli:api` already there. The agent has yesterday's context. The user does not re-explain.
- **Different projects, different threads.** When you switch repos, you do not want the previous project's API decisions surfacing as context for the new one. Per-cwd scoping enforces this without asking the user to remember.
- **Resumption is cheap.** No "select a session" UI. The cwd is a path you already know; the basename is the key.

The same logic extends to channel adapters with their own keying — `telegram:<chat-id>`, `discord:<channel-id>` — and a single conversation can span keys when the gateway routes them together. The cwd-basename rule applies specifically to the CLI surface.

### `/new` clears by appending a timestamp

When the user runs `/new` mid-chat, the next message uses a key of `cli:<cwd-basename>:<Date.now()>`. The original session row still exists; the new key is a fresh row. The chat now sees only the new turns. The dedup cache for the previous key is also flushed so the same response text can be sent again under the new key without colliding with the 30-second TTL.

The reason to keep the old session row (instead of deleting it) is that history is durable. A user who started over does not want to lose the previous conversation in case it mattered after all. `ethos session list` surfaces both rows; the timestamped one is the new thread.

`/personality <id>` does *not* fork the session. The conversation thread stays continuous; only the role changes. That separation is intentional — switching hats does not start a new task.

### The storage layer — SQLite, WAL, FTS5

The default [session store](../../getting-started/glossary.md#session-store) is `SQLiteSessionStore`. It opens a database under `~/.ethos/sessions.db` and configures three things:

- **`journal_mode = WAL`.** Write-ahead logging. Readers do not block writers; writers do not block readers. The agent can stream tool output to disk while a search query reads the same table. Crash recovery is also faster than with the default rollback journal.
- **`STRICT` tables.** Both `sessions` and `messages` use SQLite's strict mode. Type enforcement is real — inserting a string into an integer column throws on the spot instead of silently coercing. The schema is part of the contract.
- **FTS5 with a porter-tokenised external-content index.** The `messages_fts` virtual table is kept in sync with `messages` via three triggers. Full-text search runs `bm25(messages_fts)` over the body and joins back to the row by rowid. No external search service, no indexing daemon — the index lives in the same `.db` file.

The "external content" pattern is load-bearing here. The FTS index holds rowids, not row copies; it stays in sync with the `messages` table via the `messages_ai`, `messages_ad`, and `messages_au` triggers. Updating a message's content updates the FTS index in the same transaction. A vacuumed `.db` file is one artefact to back up.

### The newest-N contract

`SessionStore.getMessages(sessionId, { limit })` returns the *most-recent* `limit` messages in chronological order. The tail of the history, not the head.

This is the answer to a question the LLM has on every turn: given the conversation so far, what context should I see? Showing the head is wrong — the model wants the latest decisions and the latest user prompt, not the introductions from three days ago. Showing the head was a bug in early versions; the symptom is the agent losing recent context on long conversations.

The query shape is: order by timestamp descending, limit N, then reverse to ascending for the model to read. The outer reversal is critical — the model expects chronological order, not reverse-chronological.

When several messages share the same `timestamp` (common in fast insert loops and tests), descending order alone is non-deterministic. The store breaks the tie with the `rowid` pseudo-column: `ORDER BY timestamp DESC, rowid DESC` inside, `ORDER BY timestamp ASC, rowid ASC` outside. `rowid` is SQLite's implicit integer row ID; it is monotonic for inserts in the same table. The combination of timestamp and rowid is a total order that survives same-millisecond bursts.

A surprise the implementation handles: `SELECT *` does not include `rowid`. The outer `ORDER BY rowid` would fail with `no such column: rowid`. The fix is to alias it explicitly in the inner query — `SELECT *, rowid AS _row FROM messages` — so the outer can sort on `_row`. This is a SQLite footgun, not a portability issue with other databases.

### Search via FTS5

`SessionStore.search(query, { limit, sessionId? })` runs a full-text query against `messages_fts`. The query is wrapped in double quotes to treat it as a phrase; internal quotes are escaped. The bm25 score is flipped (FTS5 returns negative scores; the result type uses higher-is-better) and the snippet is the slice of the message body around the first match.

This is how `session_search` — a tool exposed to `researcher`, `reviewer`, and `coach` — answers "have we talked about X before". The data model is the same as the rest of the agent: the messages table is the source of truth, the FTS index is a search-time accelerator, and both live in the same `.db` file.

### How a session is created

The first message under a new key triggers `createSession` on the store. The row records the key, the platform, the model and provider in use for this turn, the personality id, the working directory, an empty usage block, and timestamps. The agent then appends messages to that session as they arrive.

There is no manual "open a session" step. The user sends a message; if the key already exists, history loads; if it does not, a new row appears. The session is a *consequence* of the first message, not a precondition for it.

Sessions accumulate `usage` deltas as turns happen. Input tokens, output tokens, cache reads, cache creations, estimated cost in USD, API call counts, compaction counts — all roll up onto the `sessions` row via `updateUsage`. This is the data that powers `/usage` in chat: per-session running totals you can inspect without computing them from scratch.

### Cross-platform continuity

The CLI keys on `cli:<cwd-basename>`. Channel adapters key on their own platform-appropriate identifiers — `telegram:<chat-id>`, `discord:<channel-id>`. A multi-channel deployment shares the session store; conversations on different platforms keep their own threads.

A separate gateway layer can route messages from one user across surfaces so the same conversation continues from Telegram into the CLI. That routing is a [gateway](../../getting-started/glossary.md#gateway) concern, not a session-store concern. The store just provides the persistence; the gateway decides which session a given inbound message belongs to.

### The streaming and persistence boundary

A session is a *durable* record. The agent's response is *streaming*. The boundary between them is the AgentLoop's append point: each completed message (user input, assistant response, tool call, tool result) is appended to the messages table as a whole row. The stream of `text_delta` events the CLI renders is not what is persisted — the persisted message is the assembled text at the end of the turn.

This matters when a turn fails mid-stream. The user message is already in the table; the assistant's partial output is not. On retry, the agent sees the user message and re-runs the turn. No partial-state recovery to manage; the database is always in a consistent state.

Tool calls are persisted as messages with `role: 'tool'`, a `tool_call_id`, a `tool_name`, and a serialised `tool_calls` JSON when relevant. The same shape the Anthropic message contract expects on the next turn. Reconstruction is faithful — the LLM sees the same conversation state on resume as it had at the end of the previous turn.

### What sessions do *not* include

A session is conversation history. It is *not* memory. The two are different stores with different lifecycles.

- **Session** = the literal back-and-forth in this thread. Lives in SQLite. Recent N read into the prompt.
- **Memory** = `MEMORY.md` and `USER.md` in `~/.ethos/`. Distilled, durable context the agent decides to keep.

Switching personalities does not clear the session. Running `/new` does not clear memory. The two stores serve different needs, and they are persisted separately so they can be reasoned about separately. See [Why MEMORY.md and USER.md?](memory-model.md) for the memory side.

## Trade-offs

**Per-cwd keying is cwd-aware, not project-aware.** If you `cd` into a subdirectory and run `ethos chat`, the basename changes; the session changes. If two unrelated projects happen to have the same basename (`api`, `site`), they collide. Both are real costs. The workaround is to set an explicit session key, or to keep `ethos chat` to the project root.

**SQLite is one file.** Backup and restore are trivial; concurrency is bounded. Two processes can read and write the same `.db` under WAL, but the workload is not designed for many concurrent writers. For the single-user CLI and a small number of channel adapters, this is the right shape. For a multi-tenant deployment, a different `SessionStore` implementation — Postgres, Redis — is one interface implementation away.

**The newest-N contract is opinionated.** The model sees the latest context, never the oldest. Long-running threads lose their introductions. This is the correct default — the agent should not derail on five-day-old setup — but tools that genuinely want the head of a thread have to query around `getMessages` or page explicitly with `offset`.

**`/new` does not delete history.** It starts a fresh row. The old row stays in `sessions.db` until explicitly pruned via `pruneOldSessions(olderThan)`. The trade is durability over tidiness; a forgotten `/new` is recoverable, a deleted history is not.

Alternatives considered:

- One global session per user. Rejected: every project's context bleeds into every other. Per-cwd is the smallest scope that matches how users actually work.
- A separate `.db` file per session. Rejected: the FTS index across all sessions becomes hard to maintain. One file with a session column is the simpler shape.
- A session "checkpoint" model (save, branch, restore). Rejected for v1: the operations the user actually wanted were "start fresh" and "resume" — both already covered.
- Returning the oldest N from `getMessages`. Rejected: tested in early versions, produced agents that lost recent context on long threads. The newest-N contract was the fix.

## See also

- [Why MEMORY.md and USER.md?](memory-model.md) — the other persistence store, with a different contract
- [Why is personality the unit?](what-is-a-personality.md) — what does *not* change when you switch
- [Slash commands reference](../reference/slash-commands.md) — `/new`, `/personality`, and friends
- [CLI reference](../reference/cli.md) — `ethos session list` and related subcommands
