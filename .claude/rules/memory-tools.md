---
paths:
  - "extensions/tools-memory/**"
  - "extensions/memory-*/**"
  - "packages/wiring/src/index.ts"
---

# Memory tool reference

Memory tool reference
Six tools ship in `@ethosagent/tools-memory`. They are registered at wiring time and gated by personality toolset.

**Personality memory** (toolset: `memory`)

| Tool | Required params | Optional params | Behaviour |
|---|---|---|---|
| `memory_read` | — | `store: 'memory' \| 'user' \| 'both'` (default: `'both'`) | Reads `MEMORY.md`, `USER.md`, or both via `prefetch()`. Returns formatted content or an empty notice. |
| `memory_write` | `store: 'memory' \| 'user'`, `action: 'add' \| 'replace' \| 'remove'`, `content` | `substring_match` | Writes to `MEMORY.md` (`store='memory'`) or `USER.md` (`store='user'`). For `action='remove'`, uses `substring_match` if supplied, otherwise uses `content` as the match string. |
| `session_search` | `query` | `limit` (default 10, max 50) | Full-text search over session history. Returns timestamped snippets. |

**Team memory** (toolset: `team_memory`, requires `ctx.teamId`)

On first team boot, wiring auto-seeds two empty bootstrap topics — `onboarding.md` and `decisions.md` — so the team memory directory is never empty when an agent first looks at it (see `seedTeamMemory` in `packages/wiring/src/index.ts`). At session start, a lazy index injector (`createTeamMemoryIndexInjector`, same file) injects just the topic names (not content) into the system prompt; agents load each topic on demand via `team_memory_read`.

| Tool | Required params | Optional params | Behaviour |
|---|---|---|---|
| `team_memory_read` | `key` | — | Reads one topic file (`key` + `.md` suffix appended automatically). Keys must be alphanumeric, hyphens, underscores. |
| `team_memory_write` | `action: 'add' \| 'replace' \| 'remove' \| 'delete'`, `key` | `content`, `substring_match` | Writes to a team topic file. `add`/`replace` require `content`; `remove` strictly requires `substring_match` (returns `input_invalid` if absent — unlike personality `memory_write`, which falls back to `content`); `delete` removes the file entirely. |
| `team_memory_search` | `query` | `limit` (default 5, max 20), `mode: 'keyword' \| 'semantic' \| 'hybrid'` | Keyword search over team memory topics. Returns matching topic files. |

Adding a new memory backend
Mirrors the "Adding a new LLM provider" pattern.

1. Create `extensions/memory-<name>/src/index.ts` — implement `MemoryProvider` from `@ethosagent/types`. The five methods are `prefetch`, `read`, `search`, `sync`, `list` — no more, no fewer.
2. Create `extensions/memory-<name>/package.json` — depend on `@ethosagent/types: workspace:*`.
3. Add path alias to root `tsconfig.json`: `"@ethosagent/memory-<name>": ["./extensions/memory-<name>/src"]`.
4. Wire it in `packages/wiring/src/index.ts` under a new `config.memory` value (current values: `'markdown'`, `'vector'`).
5. The drift gate test (`packages/types/src/__tests__/memory-method-count.test.ts`) asserts exactly five methods. It fails if you add a sixth without bumping the manifest in the same commit — that's intentional schema discipline.

