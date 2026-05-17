---
title: "Share knowledge across a team with team memory"
description: "Use team_memory_read, team_memory_write, and team_memory_search so a team's coordinator and specialists share durable knowledge across tasks."
kind: how-to
audience: user
slug: use-team-memory
time: "8 min"
updated: 2026-05-17
---

## Task

Give a [team](../../getting-started/glossary.md#team) shared, durable knowledge — architecture decisions, conventions, onboarding notes — that every member can read and update across tasks and restarts.

## Result

A populated `~/.ethos/teams/<name>/memory/` directory with one markdown file per topic, written by one team member and read by another on a later turn.

## Prereqs

- A running team. See [Run a team with a shared kanban board](./run-a-team-with-kanban).
- The team's members include the `team_memory` toolset in their `toolset.yaml`. The built-in `coordinator`, `engineer`, and `researcher` personalities already do.

## What team memory is

Team memory is a team-scoped key/value store backed by plain markdown files. The wiring layer instantiates a [MemoryProvider](../../getting-started/glossary.md#memory-provider) per running team, rooted at `~/.ethos/teams/<name>/memory/`. Each key is one file (`<key>.md`); each write is one file write. Files survive restarts and are visible to any tool that reads markdown — `cat`, `bat`, your editor.

Team memory is a distinct store from personality memory (`memory_read` / `memory_write`, which touch `MEMORY.md` and `USER.md` in `~/.ethos/`). Personality memory is per-personality state; team memory is the team's shared brain.

When the supervisor seeds a brand-new team, two empty topics are created: `onboarding.md` and `decisions.md`. The session-start injector lists available topic names in the system prompt so agents know what is on the shelf — content is loaded on demand.

## The three tools

All three are gated by the `team_memory` toolset and require a team context. Running solo (no `ctx.teamId`) returns `not_available`.

### `team_memory_write`

Update one topic file. Required: `action`, `key`. Conditionally required: `content`, `substring_match`.

| Field | Type | Required | Description |
|---|---|---|---|
| `action` | `"add" \| "replace" \| "remove" \| "delete"` | yes | `add` appends, `replace` overwrites, `remove` deletes matching lines, `delete` removes the topic file. |
| `key` | string | yes | Topic name. Alphanumeric, hyphens, underscores. Optional `.md` suffix; if absent, it is appended. |
| `content` | string | for `add` / `replace` | The text to append or the full file body to overwrite. |
| `substring_match` | string | for `remove` | Delete every line in the file that contains this substring. |

Key validation lives in `isSafeTopicKey` ([extensions/tools-memory/src/index.ts](https://github.com/ethosagent/ethos/blob/main/extensions/tools-memory/src/index.ts)). The first character must be alphanumeric; path separators and traversal sequences are rejected.

### `team_memory_read`

Fetch a single topic file. Required: `key`. Same key rules as `team_memory_write`. If the topic does not exist, the tool returns `No team memory entry for "<key>".` rather than erroring — a missing topic is a normal state, not a failure.

### `team_memory_search`

Search across topics. Required: `query`. Optional: `limit` (default 5, capped at 20), `mode` (`"keyword" \| "semantic" \| "hybrid"`, default `keyword`). Results return as a list of matching topics with their content under a `### <key>` heading.

## Walkthrough

The `coordinator` writes the team's API design conventions to a new topic, then a specialist reads it before starting an endpoint task.

Coordinator turn, after the team agrees on REST conventions:

```yaml
tool: team_memory_write
args:
  action: replace
  key: architecture
  content: |
    # API conventions

    - All endpoints under /v1, versioned by URL prefix.
    - Errors return { code, message, details? } with HTTP status as the source of truth.
    - Pagination: cursor-based (`?cursor=...&limit=...`); no offset pagination.
    - All timestamps are ISO 8601 UTC. No epoch ints in payloads.
```

The supervisor writes `~/.ethos/teams/<name>/memory/architecture.md`. The session-start injector picks up the new topic name on the next turn, so every member sees `architecture` in the topic index.

The next morning, `engineer` is assigned `t_a7: Add /v1/exports endpoint`. Before writing code, it reads the topic:

```yaml
tool: team_memory_read
args:
  key: architecture
```

The tool returns the file body. The engineer now knows the cursor pagination rule without re-asking the coordinator and without re-deriving it. When the endpoint ships, the engineer appends one line to `decisions`:

```yaml
tool: team_memory_write
args:
  action: add
  key: decisions
  content: |
    - 2026-05-17: /v1/exports added. Streams NDJSON; respects the cursor pagination rule.
```

That is the loop: write once, read on demand, append decisions as they land.

## Team memory vs personality memory

| | Team memory | Personality memory |
|---|---|---|
| Scope | One team, all members | One personality (or global, per its `memoryScope`) |
| Tools | `team_memory_read` / `_write` / `_search` | `memory_read` / `memory_write` |
| File location | `~/.ethos/teams/<name>/memory/<key>.md` | `~/.ethos/MEMORY.md` and `~/.ethos/USER.md` (or per-personality dir) |
| Shape | One file per topic, arbitrary keys | Two fixed files: `MEMORY.md` and `USER.md` |
| Use it for | Shared team conventions, architecture decisions, onboarding | Personal context the agent should remember; user identity |

Rule of thumb: if a second team member needs to read it, write it to team memory.

## Limits and gotchas

- **Team context required.** All three tools return `not_available` when called outside a team session. The `coordinator`, `engineer`, and `researcher` built-ins ship with the toolset; other personalities need it added to `toolset.yaml` before they can participate.
- **Keys are case-sensitive.** `architecture` and `Architecture` are two different files. Pick a convention and stick with it.
- **Files are on disk.** Anything in `~/.ethos/teams/<name>/memory/` is readable by any process the user can run. Do not store secrets there.
- **No versioning.** Every `replace` is the new truth; every `delete` removes the file. There is no built-in history. If you need durable history, commit the directory to git.
- **Concurrent writers race.** The provider does not lock across writes. In practice the dispatcher runs members serially per task, but two members both calling `team_memory_write` on the same key in the same tick will land last-write-wins.
- **Topic index is lazy.** The session-start injector lists topic *names*, not content. Agents call `team_memory_read` to load a topic — content is not preloaded into the prompt.

## Verify

- `ls ~/.ethos/teams/<name>/memory/` — at least `onboarding.md` and `decisions.md` exist after the first `ethos team start`.
- After a `team_memory_write` with `action: replace, key: architecture`, `cat ~/.ethos/teams/<name>/memory/architecture.md` shows the written content verbatim.
- A second team member calling `team_memory_read` with `key: architecture` returns the same content.

## See also

- [Run a team with a shared kanban board](./run-a-team-with-kanban) — the team setup this builds on.
- [Why MEMORY.md and USER.md, not a vector store?](../explanation/memory-model) — the personality-memory counterpart, and why plain markdown.
- [Built-in personalities](../explanation/built-in-personalities) — which members ship with `team_memory_*` in their toolset.
