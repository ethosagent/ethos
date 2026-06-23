---
title: "Why does a dashboard see four layers of memory instead of one?"
description: "The four layers of agent memory — MEMORY.md, USER.md, session messages, and the session store — and which ones a dashboard may safely read or write."
kind: explanation
audience: developer
slug: sdk-memory-model
updated: 2026-05-13
---

## Context

An Ethos agent has multiple layers of state that a human would loosely call "memory." A dashboard builder needs to know which layers exist, which the SDK exposes, and which are safe to touch from outside the agent loop.

## The four layers

### 1. MEMORY.md — rolling project context

`MEMORY.md` is a Markdown file that the agent updates across sessions. It contains accumulated knowledge: project conventions, discovered facts, decisions made. `MarkdownFileMemoryProvider` reads it at the start of every turn via `prefetch()` and injects the content into the system prompt.

The SDK exposes it through the `memory` namespace. `memory.get({ store: 'memory' })` returns the current content. `memory.write({ store: 'memory', content })` overwrites it entirely. A dashboard can display it, let users edit it, and save changes.

The write is safe because the agent loop re-reads the file at prefetch time. A dashboard write between turns is picked up on the next turn. A dashboard write during an active turn has no effect on the in-flight system prompt — the agent already read the file.

### 2. USER.md — persistent user profile

`USER.md` is a Markdown file describing who the user is — preferences, background, communication style. It persists across sessions and personalities (unless `memoryScope` is `per-personality`, which scopes both files to the personality's own directory).

The SDK exposes it identically to MEMORY.md: `memory.get({ store: 'user' })` and `memory.write({ store: 'user', content })`. The same safety properties apply — writes are picked up at the next `prefetch()`.

A dashboard designed as a "profile editor" reads USER.md, presents it in a textarea, and saves changes. The agent sees the updated profile on its next turn.

### 3. Session messages — the conversation

Each session has a sequence of messages stored in the `SessionStore` (the default implementation is `SQLiteSessionStore` using WAL mode with FTS5 for full-text search). Messages are the turn-by-turn conversation: user inputs, assistant responses, tool calls, tool results.

The SDK exposes session messages read-only through `sessions.get({ id })`, which returns the `Session` metadata plus an array of `StoredMessage` objects. A dashboard renders these as the chat transcript.

A dashboard does not write messages directly. Messages are created by the agent loop during a turn: the user sends text via `chat.send`, the loop processes it, and messages are persisted as side effects. Injecting messages outside the loop would corrupt the conversation history — the LLM expects a strict alternation of user/assistant/tool_result blocks, and violations cause API errors.

### 4. SQLite session store — the persistence layer

`SQLiteSessionStore` in `@ethosagent/session-sqlite` is the backing store for sessions and messages. It uses `@ethosagent/sqlite` (a shim over Node 24's built-in `node:sqlite`) with STRICT tables, WAL journaling, and FTS5 for search.

The SDK does not expose the store directly. The `sessions` namespace provides list/get/fork/delete/update operations that go through the web API service layer, which in turn calls the store. A dashboard never connects to the SQLite file.

This is intentional. The store's internal schema (rowid ordering, FTS triggers, WAL checkpointing) is an implementation detail. A dashboard that opened the file directly would risk WAL conflicts with the running server process and would bypass the auth layer entirely.

## What is safe to read

| Layer | SDK endpoint | Safe to read | Notes |
|---|---|---|---|
| MEMORY.md | `memory.get({ store: 'memory' })` | Yes | Returns current Markdown content |
| USER.md | `memory.get({ store: 'user' })` | Yes | Returns current Markdown content |
| Session messages | `sessions.get({ id })` | Yes | Returns conversation transcript |
| Session list | `sessions.list({ q?, limit?, cursor? })` | Yes | Paginated, supports FTS5 search |

## What is safe to write

| Layer | SDK endpoint | Safe to write | Notes |
|---|---|---|---|
| MEMORY.md | `memory.write({ store: 'memory', content })` | Yes | Full overwrite; picked up at next prefetch |
| USER.md | `memory.write({ store: 'user', content })` | Yes | Full overwrite; picked up at next prefetch |
| Session title | `sessions.update({ id, title })` | Yes | Metadata only, does not affect messages |
| Session messages | None | No | Created by the agent loop only |

## The memory scope dimension

The `memoryScope` field on a personality config is either `'global'` or `'per-personality'`. When global, all personalities share the same MEMORY.md and USER.md files. When per-personality, each personality has its own copies under a scoped directory.

A dashboard that displays memory content should check the active personality's `memoryScope` to know which file it is reading. The `memory.get` endpoint handles the scoping server-side — the dashboard does not need to construct file paths.

## Vector mode

The `memory` config setting in `~/.ethos/config.yaml` can be `'markdown'` or `'vector'`. The current SDK surface is markdown-shaped: content is a string, writes are full overwrites. Vector-mode chunk CRUD is deferred to a later version.

A dashboard built today should treat memory content as Markdown text. When vector mode lands, the `memory` namespace will gain additional endpoints — but the existing `get` and `write` operations will remain stable (they are in the `@stable v1` tier).
