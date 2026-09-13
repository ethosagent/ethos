# @ethosagent/memory-markdown

`MemoryProvider` backed by two flat markdown files: `MEMORY.md` (rolling project memory) and `USER.md` (who the human is).

## Why this exists

Ethos personalities need persistent context across sessions but don't always need a database. This provider writes plain markdown that the user can open in any editor, version-control, or copy between machines. It's the default memory backend, built in `packages/wiring/src/memory-backend.ts` unless `memory: vault` is configured. Core hands it an opaque scope id; mapping that id to a directory is done here, not in core.

## What it provides

- `MarkdownFileMemoryProvider` — implements `MemoryProvider` from `@ethosagent/types`.
- `MarkdownMemoryConfig` — `{ dir?, storage, charLimits? }`. `dir` defaults to `~/.ethos`; `charLimits.memory` and `charLimits.user` each default to 512K characters.

## How it works

`prefetch()` reads `MEMORY.md` and `USER.md` from the one directory `resolveScopeDir()` picks for the context's `scopeId`: `personality:<id>` → `<dir>/personalities/<id>/`, `user:<userId>` → `<dir>/users/<userId>/`, `team:<id>` → `<dir>` itself (the team provider is constructed with the team's own directory). Any other prefix throws. Both files come from that same directory, so under `personality:<id>` the `USER.md` read is the personality's own copy. The agent loop reads a per-user profile separately, from `user:<userId>`, on turns that carry a `userId`, and that copy replaces the personality-scope one in the prompt (`packages/core/src/agent-loop/stages/context-assembly.ts`). Returns `null` when both files are empty or absent so the system prompt skips the memory section entirely.

When a write pushes a key past its character limit, `applyUpdates` keeps the *tail* and appends the trimmed-away head to `memory-archive.md` in the same scope directory. The most recent memory lives at the end of the file, so trimming the head loses the least signal, and nothing is destroyed.

`sync()` groups updates by key, resolves every key inside the scope directory, then applies each key's updates in order (distinct keys run concurrently). The four update actions in `applyUpdates`:

- `add` — appends after a blank line, normalising trailing whitespace.
- `replace` — overwrites the file with the new content.
- `remove` — line-level filter; drops any line containing `substringMatch`.
- `delete` — removes the file.

Scope ids are validated by `isSafePersonalityId` — only `[a-zA-Z0-9_-]+` — and an invalid one throws rather than risking path traversal. Keys are validated by `isSafeKey`: an unsafe key throws on `sync()` and returns `null` on `read()`.

`readGlobalEntry()` / `writeGlobalEntry()` read and write `<dir>/MEMORY.md` and `<dir>/USER.md` at the root, for the web Memory tab's whole-file editor.

## Gotchas

- `USER.md` is not shared across personalities by this provider: under `personality:<id>` it lives at `<dir>/personalities/<id>/USER.md`. A cross-personality profile is the `user:<userId>` scope, which a turn reads only when it carries a `userId`.
- `remove` matches by substring on each line. There is no regex support, no multi-line matching, and the match is case-sensitive.
- Truncation keeps the *tail*. If you want head-biased retention, use a different provider.
- `prefetch` returns `null` when both files are empty or absent. `AgentLoop` treats null as "no memory section" rather than an empty one.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | `MarkdownFileMemoryProvider`, scope resolution, update application, ID validation. |
