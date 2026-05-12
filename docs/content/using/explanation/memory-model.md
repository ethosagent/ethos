---
title: "Why MEMORY.md and USER.md, not a vector store?"
description: "Memory is two plain-markdown files in ~/.ethos/. USER.md is shared across personalities; MEMORY.md scopes per personality. Legibility over retrieval magic."
kind: explanation
audience: user
slug: memory-model
updated: 2026-05-12
---

## Context

The agent needs context that outlives a single turn. Yesterday's decisions. Your name and role. The status of an in-flight project. A standing instruction you keep repeating. Without persistence, every conversation starts cold.

The standard answer in 2026 is a vector store — embed every conversation, retrieve the top-k similar chunks at prompt build time. It works, until you want to read what the agent remembers about you. Then you discover the answer is a blob of vectors and a similarity threshold.

Ethos picks the other direction. Memory is two markdown files in `~/.ethos/`:

```
~/.ethos/
├── MEMORY.md    rolling context the agent updates after sessions
└── USER.md      who you are — persistent across sessions and personalities
```

You can `cat` them. You can `grep` them. You can `diff` them. You can commit them. The agent reads them on every turn and writes to them after every turn. That is the entire memory system.

This page explains why that is the default, how the `prefetch` / `sync` cycle works, and what [memory scope](../../getting-started/glossary.md#memory-scope) means when a [personality](../../getting-started/glossary.md#personality) switches.

## Discussion

### Two files, two responsibilities

`USER.md` describes the human. Your name, your role, your stack, your preferences, how you like to be addressed, what timezone you operate in. It is written once and updated occasionally. It is always shared — switching from researcher to engineer does not change who *you* are, only what role is currently helping you.

`MEMORY.md` is a rolling log of context the agent should not forget between sessions. What is in flight. What decisions were made. What the agent learned about the codebase. What the user said matters. The agent appends to it after each session; the model decides what to keep.

The split is load-bearing. `USER.md` is identity (rare changes, person-scoped). `MEMORY.md` is state (frequent changes, often personality-scoped). Different write cadences, different ownership rules, different default scopes — distinct files make those differences visible.

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

### Memory scope — per personality, or shared

A `MemoryProvider` is one interface. The default is `MarkdownFileMemoryProvider`. Where the *file* lives is decided by the active personality's `memoryScope`, declared in its `config.yaml`.

`memoryScope: global` (the default) routes `MEMORY.md` reads and writes to `~/.ethos/MEMORY.md`. All personalities sharing the global scope share the same file. The researcher's findings become available to the engineer's next turn; the engineer's progress notes flow back to the coach.

`memoryScope: per-personality` routes reads and writes to `~/.ethos/personalities/<id>/MEMORY.md`. The reviewer maintains its own memory file, isolated from the engineer's. Opinions about what was reviewed do not bleed into what gets built; operational state from an `operator` does not surface in a casual `coach` session.

`USER.md` is *always* shared. Per-personality scope only changes where `MEMORY.md` lives. The reasoning: `USER.md` is about the person — your name, your preferences — and a personality is not allowed to forget who you are when you switch to a different role.

### When each scope is right

`global` when the work composes. A researcher gathering primary sources should hand context to an engineer who acts on it; the engineer's status updates should reach the coach who helps you reflect on what to build next. The five built-in personalities are intentionally split into global (`researcher`, `engineer`, `coach`) and per-personality (`reviewer`, `operator`) because three of them participate in a shared narrative and two of them should not.

`per-personality` when isolation matters more than continuity. A reviewer that absorbs the opinions it reviews drifts into the codebase's worldview. An operator that carries forward engineer notes about "we should refactor this someday" makes worse deploy decisions. The boundary protects the role.

The shape of the boundary: a per-personality reviewer can still *read* `USER.md`. It just cannot see — or be coloured by — the engineer's running `MEMORY.md`. The agent knows who you are; it does not inherit the previous role's narrative.

### Where the file lives, in detail

The directory resolution is deterministic. Given the active personality's `memoryScope`:

| Scope | `MEMORY.md` location | `USER.md` location |
|---|---|---|
| `global` (default) | `~/.ethos/MEMORY.md` | `~/.ethos/USER.md` |
| `per-personality` | `~/.ethos/personalities/<id>/MEMORY.md` | `~/.ethos/USER.md` (still shared) |

When `memoryScope` is `per-personality`, the loader validates the personality id with `/^[a-zA-Z0-9_-]+$/`. The check is belt-and-suspenders — directory names are already constrained — but it is the boundary the framework refuses to depend on a caller upholding. A malformed id falls back to the shared root rather than landing the write at `~/.ethos/personalities/../etc/passwd`.

`prefetch` reads `USER.md` from the shared root first, appends `MEMORY.md` from the scope-resolved location, joins them under labelled headings (`## About You`, `## Memory`), truncates to `maxChars` if needed, and returns. If both files are absent, it returns `null`. The system prompt assembly handles that null cleanly — no memory section is added.

`sync` does the inverse. Updates are bucketed by `store` (`'memory'` or `'user'`), then applied per-file: memory updates land at the resolved memory dir, user updates always land at the shared root. The two writes run in parallel via `Promise.all`. A turn that updates only memory is one disk write; a turn that updates both is two.

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

`MEMORY.md` and `USER.md` are just files. Any tool that reads markdown reads them — your editor, `cat`, `bat`, a static site generator, a backup script. The web UI's Memory tab calls `readGlobalFile('memory')` and `readGlobalFile('user')` through the same provider, which just returns the file's content, path, and mtime.

This means the agent's view of memory and your view of memory are the same view. If something looks wrong to you, it looked wrong to the agent. There is no "internal representation" that diverges from what the file says. The same is true of writes: a manual edit you make in your editor lands in the same file the agent reads next turn.

### The cost of writes is bounded

Three operations matter: `add`, `replace`, `remove`. Each is a single file write under the resolved memory directory. The provider does not retain locks across turns; it does not maintain an in-memory cache of the file contents; it simply reads what is on disk at `prefetch` time and writes what the agent asked for at `sync` time.

This means concurrent agents writing to the same `MEMORY.md` is a real concern in multi-process deployments. Two CLIs running in the same directory with the same personality, both syncing to `~/.ethos/MEMORY.md`, can race. In single-user-CLI workloads this rarely happens — the user is not running two `ethos chat` processes in the same project. In channel-adapter deployments where multiple users share an `~/.ethos/`, the boundary is the personality directory; `per-personality` scope avoids the race because each personality writes to its own file.

The escape hatch, again, is the `MemoryProvider` interface. A backend that supports atomic compare-and-swap (a database, Redis) handles concurrent writers cleanly. The markdown default trades concurrency for legibility — the workloads that need both have a path.

### Memory is not session history

This is a common confusion worth ending on. A [session](../../getting-started/glossary.md#session) is the literal sequence of messages in the current thread — stored in SQLite, scoped per working directory, read into the prompt as the last N messages. Memory is the distilled context the agent decides to keep across sessions.

The two stores have different shapes, different lifecycles, and different content. Restart the CLI and your session reloads. Restart it after `/new` and your session is fresh, but your memory still applies. Switch personalities and your session continues; memory may shift if scope changed. They are not interchangeable; they are not redundant; they answer different questions.

## Trade-offs

**You give up retrieval magic.** A markdown file does not surface the most-relevant past turn for the current question. The model reads what is in the file, top to bottom, truncated to fit. For most personal-agent workloads this is fine; for a knowledge-base agent over thousands of past tickets, it is not. The provider interface is the escape hatch.

**You commit to manageable file sizes.** A `MEMORY.md` that grows unbounded is a `MEMORY.md` that gets truncated. The prefetch cap is 20 000 characters; the model is instructed to keep the file under that. If the agent writes too much, you can read it and trim it yourself — but the easy path is right-sized writes, not aggressive retrieval.

**Per-personality memory is not user-defined.** You cannot ask for "the reviewer to share memory with the engineer just for this project". Scope is set in the personality's `config.yaml` and applies uniformly. The honest workaround: build a personality that suits the project (one `cp -r` from the closest built-in) and pick its scope deliberately.

**Plain text is greppable, which is the point.** A `MEMORY.md` containing a password is searchable from any shell on the machine. Treat these files like any other dotfile: do not paste secrets the agent does not need to know. The threat model is the same as your `.bashrc`.

Alternatives considered:

- Vector store as default. Rejected for legibility. Available as `extensions/memory-vector` for the personalities that warrant it.
- Per-session memory only. Rejected: defeats the entire continuity story across `/new` and across CLI/Telegram/Slack.
- A single `MEMORY.md` with sections per personality. Rejected: a long file with many sections is harder to read and harder to scope. Two files (one shared, one scoped per personality directory) is the smaller move.

## See also

- [Why is personality the unit?](what-is-a-personality.md) — where `memoryScope` lives and how it is set
- [What are the built-in personalities?](built-in-personalities.md) — which built-ins are global vs per-personality
- [Why are sessions scoped per working directory?](sessions-and-history.md) — session history vs memory, two different stores
- [Personality config reference](../reference/personality-yaml.md) — the `memoryScope` field
- [Add a memory provider](../../building/how-to/add-a-memory-provider.md) — implement a non-markdown backend
