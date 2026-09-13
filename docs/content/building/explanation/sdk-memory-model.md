---
title: "Why does a dashboard see four layers of memory instead of one?"
description: "The four layers of agent memory — MEMORY.md, USER.md, session messages, and the session store — and which ones a dashboard may safely read or write."
kind: explanation
audience: developer
slug: sdk-memory-model
updated: 2026-09-13
---

## Context

An Ethos agent has multiple layers of state that a human would loosely call "memory." A dashboard builder needs to know which layers exist, which the SDK exposes, and which are safe to touch from outside the agent loop.

## The four layers

### 1. MEMORY.md — rolling project context

`MEMORY.md` is a Markdown file that the agent updates across sessions. It contains accumulated knowledge: project conventions, discovered facts, decisions made. `MarkdownFileMemoryProvider` reads it at the start of every turn via `prefetch()` and injects the content into the system prompt.

The SDK exposes it through the `memory` namespace. `memory.get({ store: 'memory', personalityId })` returns the current content. `memory.write({ store: 'memory', content, personalityId })` overwrites it entirely. `personalityId` is required on both: every personality has its own `MEMORY.md`. A dashboard can display it, let users edit it, and save changes.

The write is safe because the agent loop re-reads the file at prefetch time. A dashboard write between turns is picked up on the next turn. A dashboard write during an active turn has no effect on the in-flight system prompt — the agent already read the file.

### 2. USER.md — persistent user profile

`USER.md` is a Markdown file describing who the user is — preferences, background, communication style. It persists across sessions. Like `MEMORY.md`, the default copy belongs to one personality — `personalities/<id>/USER.md` under the markdown backend — so switching personality switches profile. A person the gateway has resolved to a `userId` also has a profile of their own at `users/<userId>/USER.md`.

The SDK exposes it identically to MEMORY.md: `memory.get({ store: 'user', personalityId })` and `memory.write({ store: 'user', content, personalityId })`. Add `userId` to either call to read or write that person's profile instead. The same safety properties apply — writes are picked up at the next `prefetch()`.

A dashboard designed as a "profile editor" reads USER.md, presents it in a textarea, and saves changes. The agent sees the updated profile on its next turn.

### 3. Session messages — the conversation

Each session has a sequence of messages stored in the `SessionStore` (the default implementation is `SQLiteSessionStore` using WAL mode with FTS5 for full-text search). Messages are the turn-by-turn conversation: user inputs, assistant responses, tool calls, tool results.

The SDK exposes session messages read-only through `sessions.get({ id })`, which returns the `Session` metadata plus an array of `StoredMessage` objects. A dashboard renders these as the chat transcript. For a long session, `sessions.messages({ id, before?, turns? })` returns the history one page of whole turns at a time, newest first, with a `nextCursor` for the next-older page.

A dashboard does not write messages directly. Messages are created by the agent loop during a turn: the user sends text via `chat.send`, the loop processes it, and messages are persisted as side effects. Injecting messages outside the loop would corrupt the conversation history — the LLM expects a strict alternation of user/assistant/tool_result blocks, and violations cause API errors.

### 4. SQLite session store — the persistence layer

`SQLiteSessionStore` in `@ethosagent/session-sqlite` is the backing store for sessions and messages. It uses `@ethosagent/sqlite` (a shim over Node 24's built-in `node:sqlite`) with STRICT tables, WAL journaling, and FTS5 for search.

The SDK does not expose the store directly. The `sessions` namespace provides list/get/fork/delete/update operations that go through the web API service layer, which in turn calls the store. A dashboard never connects to the SQLite file.

This is intentional. The store's internal schema (rowid ordering, FTS triggers, WAL checkpointing) is an implementation detail. A dashboard that opened the file directly would risk WAL conflicts with the running server process and would bypass the auth layer entirely.

## What is safe to read

| Layer | SDK endpoint | Safe to read | Notes |
|---|---|---|---|
| MEMORY.md | `memory.get({ store: 'memory', personalityId })` | Yes | Returns current Markdown content |
| USER.md | `memory.get({ store: 'user', personalityId, userId? })` | Yes | The personality's copy, or the person's when `userId` is passed |
| Session messages | `sessions.get({ id })`, `sessions.messages({ id, before? })` | Yes | Whole transcript, or one page of turns at a time |
| Session list | `sessions.list({ q?, limit?, cursor? })` | Yes | Paginated, supports FTS5 search |

## What is safe to write

| Layer | SDK endpoint | Safe to write | Notes |
|---|---|---|---|
| MEMORY.md | `memory.write({ store: 'memory', content, personalityId })` | Yes | Full overwrite; picked up at next prefetch |
| USER.md | `memory.write({ store: 'user', content, personalityId, userId? })` | Yes | Full overwrite; picked up at next prefetch |
| Session title | `sessions.update({ id, title })` | Yes | Metadata only, does not affect messages |
| Session messages | None | No | Created by the agent loop only |

## The memory scope dimension

There is no memory scope setting on a personality. Every memory read and write carries a scope id, and the web API derives it from the call: `personality:<personalityId>` for both stores, or `user:<userId>` when `store` is `'user'` and a `userId` is passed (`scopeIdFor` in `apps/web-api/src/services/memory.service.ts`). The markdown backend maps those to `personalities/<id>/` and `users/<userId>/` under `~/.ethos/` and throws on any other prefix (`resolveScopeDir` in `extensions/memory-markdown/src/index.ts`). No setting makes two personalities share a file; memory that crosses personalities is team memory, reached only through the `team_memory_*` tools.

A dashboard therefore names the personality on every `memory.get` and `memory.write`, and re-fetches after the user switches personality. To show what the agent sees about a person, pass that person's `userId`: a turn carrying one reads `USER.md` from `user:<userId>` and, when that file is non-empty, drops the personality's copy from the prompt (`packages/core/src/agent-loop/stages/context-assembly.ts`). The gateway passes a `userId` for every sender its identity map resolves; `ethos chat` passes none. The endpoint builds every path server-side — the dashboard never constructs one.

## Vector mode

The `memory` config setting in `~/.ethos/config.yaml` can be `'markdown'`, `'vector'` or `'vault'`. The current SDK surface is markdown-shaped: content is a string, writes are full overwrites. Vector-mode chunk CRUD is deferred to a later version.

A dashboard built today should treat memory content as Markdown text. When vector mode lands, the `memory` namespace will gain additional endpoints — but the existing `get` and `write` operations will remain stable (they are in the `@stable v1` tier).
