---
paths:
  - "extensions/memory-*/**"
  - "packages/core/src/agent-loop/**"
  - "packages/core/src/chat-audience.ts"
  - "packages/types/src/memory*.ts"
---

# Memory

Memory
Memory is a scope-bound key/value store. Every read and write carries an opaque `scopeId`; the provider routes storage accordingly. Conventional scope prefixes:

| Prefix | Set by | Storage root |
|---|---|---|
| `personality:<id>` | Personality wiring | `~/.ethos/` |
| `team:<id>` | Team wiring | `~/.ethos/teams/<id>/memory/` |

**Personality scope** ships two default keys:
- `MEMORY.md` — rolling project context, updated each session.
- `USER.md` — persistent user profile across sessions and personalities.

**Team scope** ships an arbitrary topic set — one markdown file per topic (e.g. `architecture.md`, `decisions.md`, `onboarding.md`).

The canonical contract is `MemoryProvider` in `@ethosagent/types`. See ARCHITECTURE.md §VII for the frozen-schema roster.

`MemoryProvider.sync()` applies `MemoryUpdate[]`:

- `action: 'add'` → appends to the end of the key's content.
- `action: 'replace'` → overwrites the entire key.
- `action: 'remove'` with `substringMatch` → removes lines containing the substring.
- `action: 'delete'` → removes the key entirely (team scope).

`prefetch()` returns `null` if all keys are empty or absent — the system prompt is built without a memory section.

**Shared rooms (G-MEM).** A turn with `RunOptions.roomAudience: 'shared'` (group chats, channels, and anything a shared turn starts later: delegated children, background jobs, cron, watchers, goals, kanban tasks) neither reads nor writes private memory. One core module enforces it, `packages/core/src/agent-loop/audience.ts`: `resolveTurnAudience` narrows the caller's audience by the session's sticky stamp (private→shared only) and `sessionAudienceStampFor` (packages/core/src/chat-audience.ts) decides what turn-setup writes back, context assembly skips the personality- and user-scope prefetch, `SHARED_AUDIENCE_EXCLUDED_TOOLS` removes the memory, other-session, team-memory and shell tools, the turn-end flush is skipped, and `sharedTurnDenyFor` adds `sharedTurnPathDeny` (packages/types/src/memory-paths.ts) as a read+write deny in both file boundaries: nothing under a state dir but the turn's own `files/`, `ui/`, `SOUL.md` (read) and `skills/` (read), plus `isPrivateMemoryPath` everywhere (folded for case and the macOS `/System/Volumes/Data` firmlink by `foldForDeny`). Tools that name a job, task or watcher (`cron`, `kanban_*`, `watcher_*`) show a shared turn only the ones stamped shared and answer the rest as missing. A DM from a non-owner (platform has an `ownerUserId`) is shared except for the sender's own `user:<id>` read (`withPersonalityMemoryWithheld`). Post-turn learners (memory capture, improvement fork, nightly evidence, learning cases, `ethos evolve` export) skip every session whose conversation was not the owner's via one helper, `turnWasShared` (packages/core/src/chat-audience.ts): the shared stamp, a pre-upgrade group-lane key, or the `personalityMemoryWithheld` marker a non-owner DM turn leaves; a Discord/email DM the gateway judged private is stamped `roomAudience: 'private'` so it is learned from — written only for a caller that sets `RunOptions.judgeAudience` (the gateway's message turns); every other host, ACP included, passes `'shared'` or nothing. A caller that names no audience gets the session's own (`isSharedSession` — stamp, else key shape); new hosts must still pass it (census test above). Not governed: a private turn posting memory into a room via `send_message`, plugin slash commands, MCP servers (memory or file access), plugin `before_prompt_build` and OpenClaw `agent_end`/`agent_done` hook payloads (no audience field), a context engine's `onTurnComplete` (no audience; one `compaction/<id>/` store per personality), unstamped kanban tasks (run private), pre-upgrade dashboard panels from group turns (refresh private), and `ethos chat -q` (no initiator).

