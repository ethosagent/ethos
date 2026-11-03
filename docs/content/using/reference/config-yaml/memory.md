---
title: "config.yaml: memory keys"
description: "config.yaml memory backend, vault, approval and capture keys."
kind: reference
audience: user
updated: 2026-11-03
---

## Synopsis {#synopsis}

Keys that select and tune the memory backend. Part of the [config.yaml reference](../config-yaml.md).

## memory {#memory}

Type: `markdown` | `vector` | `vault` · Default: unset (treated as `markdown`)

Memory backend. One selection serves the agent, the web memory editor, the CLI memory verbs and the nightly pass:

- `markdown` — per-personality files under `~/.ethos/personalities/<id>/` (`MEMORY.md`, `USER.md`) (default).
- `vector` — SQLite + embeddings at `~/.ethos/memory.db`. No file editor: the web Memory page and `ethos memory restore|retract|supersede|history` refuse, because there are no files to edit.
- `vault` — the same file layout inside a directory you own (an Obsidian vault), set by [`memoryVault.path`](#memory-vault).

```yaml
memory: vault
memoryVault.path: /Users/you/Documents/Vault
```

Notes:

- Switching backends mid-stream does not migrate data — export from one, then import into the other.
- A change takes effect on restart. A running `ethos serve` / `ethos gateway` logs `memory backend changed — restart required to apply` and keeps the backend it booted with.
- Vector mode requires an embeddings-capable provider key.
- `ethos backup` does not archive vault content — see [Back up and restore](../../how-to/back-up-and-restore.md#vault-memory).

## memoryVault.* {#memory-vault}

Read only when `memory: vault`.

| Key | Type | Default | Description |
|---|---|---|---|
| `memoryVault.path` | string | — | Absolute path to the vault root. Required under `memory: vault`; boot fails without it. |
| `memoryVault.agentDir` | string | `Ethos` | Subtree of the vault the agent owns. Writes are confined to it; `search` may read the whole vault. |
| `memoryVault.prefetch` | comma list | `MEMORY.md, USER.md` | Keys injected into the prompt tail for a personality scope. |
| `memoryVault.exclude` | comma list | — | Names never read during `list()` / `search()`, on top of dot-directories and sync-conflict files. |

```yaml
memory: vault
memoryVault.path: /Users/you/Documents/Vault
memoryVault.agentDir: Ethos
memoryVault.prefetch: MEMORY.md, USER.md
memoryVault.exclude: Archive, Templates
```

Notes:

- Content lands in `<path>/<agentDir>/personalities/<id>/`; provenance history and diff blobs in `<path>/<agentDir>/.ethos-meta/` (dot-prefixed so Obsidian ignores it).
- The approval queue and its tombstones stay at `~/.ethos/` for every backend — they are gate state, not memory content.

## memoryApproval.* {#memory-approval}

Approve-before-store gate: a captured fact parks in a queue instead of being written, until someone approves it (`ethos memory pending`, or the web Memory page's Pending tab).

| Key | Type | Default | Description |
|---|---|---|---|
| `memoryApproval.mode` | `off` \| `automated` \| `all` | `off` | `off` — writes go straight through; `automated` — gates writes the agent proposes on its own (capture, dream turns); `all` — gates every write, including explicit `memory_write` tool calls. |
| `memoryApproval.cap` | number | `200` | Per-scope queue ceiling. At cap the oldest candidate is dropped, logged, and reported as an observability event. |
| `memoryApproval.ttlDays` | number | `30` | Candidates older than this auto-REJECT (never auto-approve) and are tombstoned so capture does not re-propose them. |

```yaml
memoryApproval.mode: automated
memoryApproval.cap: 200
memoryApproval.ttlDays: 30
```

Notes:

- Cap and TTL apply to every queue over one deployment — the runtime gate, `ethos memory pending`, and the web Pending tab.
- `all` also gates consolidation: both the inline fallback and the nightly pass's MEMORY.md / USER.md rewrite wait in the queue as `consolidation` entries (`MemoryEditing.consolidation` in [packages/wiring/src/memory-backend.ts](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/memory-backend.ts)). The nightly pass still updates its `memory-meta.json` decay sidecar straight away.
- Every backend is gated, `memory: vector` included. Under vector an approved candidate is written into `memory.db` and records no history entry, because vector keeps no history. (`composeGatedVectorMemory` and `createPendingMemoryStore` in [packages/wiring/src/memory-backend.ts](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/memory-backend.ts).)
- A change takes effect on restart, like `memory` itself.

## memoryCapture.evidenceSessions {#memory-capture-evidence-sessions}

Type: integer, `0`–`16` · Default: `0` (off)

How many distinct sessions must independently extract the same fact before proactive capture (`memoryCapture.enabled: true`) keeps it. At `0`, capture behaves as it did before the key existed. Above `0`, a re-extracted fact merges into its existing pending candidate and adds its session as evidence, instead of queuing a duplicate. What happens next depends on `memoryApproval.mode`:

- `off`: the fact waits in the pending queue and is written to memory with `approvedBy: evidence` once it reaches N sessions. Nothing is written before then.
- `automated` or `all`: the queue lists the most-evidenced candidates first, and each row shows its session count. A person still approves every candidate, whatever its count.

```yaml
memoryCapture.enabled: true
memoryCapture.evidenceSessions: 3
```

Notes:

- The TTL still counts from a candidate's first proposal (`memoryApproval.ttlDays`), so repeated sightings cannot keep a fact queued forever. When a candidate expires, its fact is tombstoned, like any other expired candidate.
- A rejected or expired fact is never queued again, however many sessions extract it.
- A negative, fractional or non-numeric value, or one above `16`, is refused at load, and the error names the key. An entry records at most 16 sessions (`MAX_EVIDENCE_SESSIONS` in [`extensions/memory-approval/src/store.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/memory-approval/src/store.ts)).
- A change takes effect on restart.

## See also {#see-also}

- [config.yaml reference](../config-yaml.md): the index of every section and its page.
