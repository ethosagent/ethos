# @ethosagent/tools-memory

Tools for reading and writing the agent's persistent memory (`MEMORY.md`, `USER.md`, team topics) and searching session history.

## Capabilities

All tools in this package declare empty capabilities (`{}`). They use framework-provided domain stores and require no direct side-effect access.

## Why this exists

Memory and session history are part of the system prompt by default, but the LLM also needs to act on them mid-turn — to recall a user preference before answering, to record a new fact, or to find a past conversation about a specific topic. These tools surface the existing `MemoryProvider` and `SessionStore` capabilities to the model directly.

## Tools provided

| Tool name | Toolset | Purpose |
|---|---|---|
| `memory_read` | `memory` | Read `MEMORY.md`, `USER.md`, or both with `MemoryProvider.read`, or one personality-scope entry by exact `key`. |
| `memory_write` | `memory` | Apply a single `MemoryUpdate` (`add` / `replace` / `remove`) to either store. |
| `session_search` | `memory` | Full-text search across persisted session messages, scoped to the current session id. |

## How it works

`createMemoryReadTool` reads through `MemoryProvider.read`, never `prefetch`. `store: 'memory'` reads `MEMORY.md` from the turn's `memoryScopeId`, which is always `personality:<id>`. `store: 'user'` reads `USER.md` from `userScopeId` when the turn carries a user id (a gateway sender the identity map resolved), and from the personality scope otherwise. `both` joins the two under `## About You` and `## Memory`; `key` reads one personality-scope entry by exact name. A context with no `memoryScopeId` falls back to the scope id `global`, which the built-in backends reject (`buildMemoryContext` / `buildUserMemoryContext`).

`createMemoryWriteTool` validates `store` and `action` against their enums, then forwards a single-element `MemoryUpdate[]` keyed `MEMORY.md` or `USER.md` to `memory.sync`, routing `store: 'user'` to the user scope the same way `memory_read` does. `substring_match` is renamed to `substringMatch` to match the `MemoryUpdate` field shape. The result string is just a confirmation (`Appended to MEMORY.md`, etc.) — the actual file write is the provider's responsibility.

`createSessionSearchTool` caps `limit` at 50 (`Math.min(limit ?? 10, 50)`) and pins the search to `ctx.sessionId` so cross-session leaks don't happen by accident. Each result is rendered as `N. [YYYY-MM-DDTHH:MM] <snippet>` for the LLM to scan.

## Gotchas

- `memory_write` only supports a single update per call; the LLM can't batch.
- `memory_read` has `maxResultChars: 20_000`.
- `session_search` requires the wired `SessionStore` to implement `search()` — the in-memory store returns `[]`, so this tool is only useful with `@ethosagent/session-sqlite` (which has FTS5).

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | The tool factories, the scope-context helpers, and the `createMemoryTools(memory, session)` / `createTeamMemoryTools(teamMemory)` aggregate factories. |
