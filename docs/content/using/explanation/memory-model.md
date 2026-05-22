---
title: "Why MEMORY.md and USER.md, not a vector store?"
description: "Memory is two plain-markdown files — MEMORY.md per-personality, USER.md per-user. Legibility over retrieval magic."
kind: explanation
audience: user
slug: memory-model
updated: 2026-05-22
---

## Context

The agent needs context that outlives a single turn. Yesterday's decisions. Your name and role. The status of an in-flight project. A standing instruction you keep repeating. Without persistence, every conversation starts cold.

The standard answer in 2026 is a vector store — embed every conversation, retrieve the top-k similar chunks at prompt build time. It works, until you want to read what the agent remembers about you. Then you discover the answer is a blob of vectors and a similarity threshold.

Ethos picks the other direction. Memory is two markdown files:

```
~/.ethos/
├── personalities/<id>/MEMORY.md   rolling context, per personality
└── users/<userId>/USER.md         who you are, per user
```

You can `cat` them. You can `grep` them. You can `diff` them. You can commit them. The agent reads them on every turn and writes to them after every turn. That is the entire memory system.

This page explains why that is the default, how the `prefetch` / `sync` cycle works, and how MEMORY.md and USER.md are scoped.

## Discussion

### Two files, two responsibilities

`USER.md` describes the human. Your name, your role, your stack, your preferences, how you like to be addressed, what timezone you operate in. It is written once and updated occasionally. It is keyed by user — an opaque `userId` derived from platform identity (Telegram handle, Slack user ID, etc.). Switching from researcher to engineer does not change who *you* are, only what role is currently helping you. A different person messaging the same agent gets a different `USER.md`.

`MEMORY.md` is a rolling log of context the agent should not forget between sessions. What is in flight. What decisions were made. What the agent learned about the codebase. What the user said matters. The agent appends to it after each session; the model decides what to keep.

The split is load-bearing. `USER.md` is identity (rare changes, user-scoped). `MEMORY.md` is state (frequent changes, personality-scoped). Different write cadences, different ownership rules, different scoping — distinct files make those differences visible.

### The prefetch / sync contract

Every turn follows the same shape:

The [memory provider](../../getting-started/glossary.md#memory-provider) runs `prefetch(ctx)` before the system prompt is built. It reads `USER.md` and `MEMORY.md` from disk, concatenates them under labelled headings (`## About You`, `## Memory`), truncates if the combined size exceeds the cap (20 000 chars by default, keeping the tail because recent memory matters most), and returns the result. The system prompt assembly takes that string and inlines it.

If both files are empty or absent, `prefetch` returns `null` and the prompt is built without a memory section. No error, no warning — a brand-new install does not have a memory yet.

After the turn, the agent may emit a list of `MemoryUpdate[]`. The provider runs `sync(ctx, updates)` and applies them:

| `action` | Effect |
|---|---|
| `add` | Appends `content` to the end of the file |
| `replace` | Overwrites the entire file with `content` |
| `remove` | Removes lines containing `substringMatch` |

Updates are routed by the update's `store` field — `'memory'` writes to `MEMORY.md`, `'user'` writes to `USER.md`. There are no other stores. The contract is small on purpose: the model has to do less to use memory well.

### MEMORY.md — always per personality

Every personality reads and writes its own `MEMORY.md` at `~/.ethos/personalities/<id>/MEMORY.md`. No configuration field is required — the scoping is automatic.

The reviewer maintains its own memory file, isolated from the engineer's. Opinions about what was reviewed do not bleed into what gets built. The researcher's running context does not leak into the reviewer's next turn. Each personality's memory stays inside its own directory.

This means switching personalities switches which `MEMORY.md` the agent reads. The conversation thread does not fork — the same session history is visible — but the rolling context changes because the personality changed.

### USER.md — always per user

`USER.md` lives at `~/.ethos/users/<userId>/USER.md`, where `userId` is an opaque identifier derived from platform identity — a Telegram handle, a Slack user ID, a CLI user hash. Different people talking to the same agent get different `USER.md` files. The same person talking through different channels resolves to the same `userId` via the identity map at `~/.ethos/users/identity-map.json`.

Switching personalities does not change your `USER.md`. Who you are is a person fact, not a role fact. A personality is not allowed to forget who you are when you switch to a different role.

### Where the file lives

The directory resolution is deterministic:

| File | Location |
|---|---|
| `MEMORY.md` | `~/.ethos/personalities/<id>/MEMORY.md` |
| `USER.md` | `~/.ethos/users/<userId>/USER.md` |

The loader validates the personality id with `/^[a-zA-Z0-9_-]+$/` and the userId with the same pattern. The check is belt-and-suspenders — directory names are already constrained — but it is the boundary the framework refuses to depend on a caller upholding. A malformed id falls back safely rather than landing the write at an unexpected path.

`prefetch` reads `USER.md` from the user's directory first, appends `MEMORY.md` from the active personality's directory, joins them under labelled headings (`## About You`, `## Memory`), truncates to `maxChars` if needed, and returns. If both files are absent, it returns `null`. The system prompt assembly handles that null cleanly — no memory section is added.

`sync` does the inverse. Updates are bucketed by `store` (`'memory'` or `'user'`), then applied per-file: memory updates land at the personality's directory, user updates land at the user's directory. The two writes run in parallel via `Promise.all`. A turn that updates only memory is one disk write; a turn that updates both is two.

### What gets written, and when

The agent decides. The model emits `MemoryUpdate[]` at the end of a turn when it has reason to. There is no hard rule "always update memory after a session". Updates happen when:

- The user said something that should outlive the conversation (a preference, a goal, a constraint).
- A decision was made that the next session should not re-derive.
- A long task progressed and the new status replaces the old one (an `action: 'replace'` on the in-flight section).
- A correction landed — a fact that was wrong is removed via `substringMatch`.

Quiet sessions produce no updates. The cost of an empty `sync` call is one disk read and zero writes.

The prompt instructs the model to keep `MEMORY.md` small. Memory is not a log of every turn; it is a rolling summary the agent can re-load cheaply. When `prefetch` truncates at 20 000 characters, it keeps the tail — recent context survives, old context falls off naturally.

### Why plain text, not embeddings

Memory you cannot read is memory you cannot trust. That sentence carries this whole design.

Embedding-based retrieval works well as a recall mechanism for large corpora. As the default mechanism for personal memory, it adds an embedding model, a vector store, a similarity threshold, a debugging surface where the agent's idea of "what does it remember" disagrees with yours — and the cost of all that for the privilege of giving the agent context the user cannot audit. Plain markdown gives up some recall sophistication and keeps the audit story.

The other gain is that `MEMORY.md` and `USER.md` are reviewable. You can read them before pushing. You can sanitise them before sharing a machine. You can commit them next to the project they describe. A vector blob does not offer those affordances; it offers retrieval that you have to trust.

When you genuinely need semantic recall over a large corpus, `MemoryProvider` is one interface. A vector-backed provider is a few hundred lines of implementation — see `extensions/memory-vector/src/` for the alternative backend that ships in the monorepo. Wire it for the personality that needs it; keep markdown for the rest.

### The interface, not the file format

`MemoryProvider` from `@ethosagent/types` is the contract. Two methods: `prefetch(ctx)` returning a `MemoryContext | null`, and `sync(ctx, updates)` returning `void`. The markdown file format is one implementation choice, not the contract.

This matters because the next backend you reach for — a database, a Redis cache, a remote service — slots in without changes elsewhere. The agent loop calls `memory.prefetch()` and consumes a string; it does not care whether that string was assembled from two files, joined from rows, or fetched over the network. Same for `sync` — the agent emits `MemoryUpdate[]`, the provider decides how to persist them.

The point of the interface is that "markdown files" is the default opinion, not the architecture. Disagree with the default and the swap is a single constructor argument in `wiring.ts`.

### Reading from outside the agent

`MEMORY.md` and `USER.md` are just files. Any tool that reads markdown reads them — your editor, `cat`, `bat`, a static site generator, a backup script. The web UI's Memory page provides two independent dropdowns: one for personality (to browse that personality's `MEMORY.md`) and one for user (to browse a user's `USER.md`). Both call through the same provider, which returns the file's content, path, and mtime.

This means the agent's view of memory and your view of memory are the same view. If something looks wrong to you, it looked wrong to the agent. There is no "internal representation" that diverges from what the file says. The same is true of writes: a manual edit you make in your editor lands in the same file the agent reads next turn.

### The cost of writes is bounded

Three operations matter: `add`, `replace`, `remove`. Each is a single file write under the resolved memory directory. The provider does not retain locks across turns; it does not maintain an in-memory cache of the file contents; it simply reads what is on disk at `prefetch` time and writes what the agent asked for at `sync` time.

This means concurrent agents writing to the same `MEMORY.md` is a real concern in multi-process deployments. Since memory is always per-personality, each personality writes to its own file — two different personalities never race on the same `MEMORY.md`. Two instances of the *same* personality running concurrently can still race. In single-user-CLI workloads this rarely happens — the user is not running two `ethos chat` processes with the same personality. In channel-adapter deployments, the boundary is the personality directory; each personality writes to its own file.

The escape hatch, again, is the `MemoryProvider` interface. A backend that supports atomic compare-and-swap (a database, Redis) handles concurrent writers cleanly. The markdown default trades concurrency for legibility — the workloads that need both have a path.

### Memory is not session history

This is a common confusion worth ending on. A [session](../../getting-started/glossary.md#session) is the literal sequence of messages in the current thread — stored in SQLite, scoped per working directory, read into the prompt as the last N messages. Memory is the distilled context the agent decides to keep across sessions.

The two stores have different shapes, different lifecycles, and different content. Restart the CLI and your session reloads. Restart it after `/new` and your session is fresh, but your memory still applies. Switch personalities and your session continues; memory shifts because each personality has its own `MEMORY.md`. They are not interchangeable; they are not redundant; they answer different questions.

## Trade-offs

**You give up retrieval magic.** A markdown file does not surface the most-relevant past turn for the current question. The model reads what is in the file, top to bottom, truncated to fit. For most personal-agent workloads this is fine; for a knowledge-base agent over thousands of past tickets, it is not. The provider interface is the escape hatch.

**You commit to manageable file sizes.** A `MEMORY.md` that grows unbounded is a `MEMORY.md` that gets truncated. The prefetch cap is 20 000 characters; the model is instructed to keep the file under that. If the agent writes too much, you can read it and trim it yourself — but the easy path is right-sized writes, not aggressive retrieval.

**Per-personality memory is automatic, not configurable.** Every personality gets its own `MEMORY.md`. There is no option for shared memory across personalities. If you need one personality to access another's context, the honest workaround is to read the other personality's `MEMORY.md` file directly (it is just a file on disk) or use a shared backend via the `MemoryProvider` interface.

**Plain text is greppable, which is the point.** A `MEMORY.md` containing a password is searchable from any shell on the machine. Treat these files like any other dotfile: do not paste secrets the agent does not need to know. The threat model is the same as your `.bashrc`.

Alternatives considered:

- Vector store as default. Rejected for legibility. Available as `extensions/memory-vector` for the personalities that warrant it.
- Per-session memory only. Rejected: defeats the entire continuity story across `/new` and across CLI/Telegram/Slack.
- A single `MEMORY.md` with sections per personality. Rejected: a long file with many sections is harder to read and harder to scope. One file per personality directory is the smaller move.

## See also

- [Why is personality the unit?](what-is-a-personality.md) — how personality scoping shapes memory layout
- [What are the built-in personalities?](built-in-personalities.md) — the three user-facing built-in personalities
- [Why are sessions scoped per working directory?](sessions-and-history.md) — session history vs memory, two different stores
- [Personality config reference](../reference/personality-yaml.md) — the fields in `config.yaml`
- [Add a memory provider](../../building/how-to/add-a-memory-provider.md) — implement a non-markdown backend
