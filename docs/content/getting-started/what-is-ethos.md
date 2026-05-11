---
title: "What is Ethos?"
description: "Ethos is a TypeScript agent framework where personality is architecture — a directory of files that changes prompt, tools, memory, and model atomically."
kind: explanation
audience: shared
slug: what-is-ethos
updated: 2026-05-12
---

**Ethos is a TypeScript framework where personality is the unit of architecture.** Not a system prompt string. A directory of files that, when switched, atomically changes the agent's prompt, tool access, memory scope, and model.

## The one-sentence pitch

A `personality` lives at `~/.ethos/personalities/<id>/` and contains three files:

```
<id>/
├── ETHOS.md        first-person identity (how do I speak, what am I for)
├── config.yaml     name, description, model, memoryScope, budget, fs_reach
└── toolset.yaml    flat list of allowed tool names
```

Switching from `researcher` to `engineer` mid-chat does not just swap a system prompt. It atomically swaps:

- The system prompt (`ETHOS.md`)
- The tools the agent can call (`toolset.yaml`)
- Whether memory is shared with the user-default scope or isolated (`memoryScope`)
- Which model handles the next turn (`model`)

You cannot accidentally run the engineer personality's write-shaped tools under the reviewer's read-only toolset. The four dimensions move together.

## What you get out of the box

Five personalities ship by default. Each has its own role, tools, and voice.

| Personality | Role | Tools | Voice |
|---|---|---|---|
| `researcher` | Explores, summarises, cites | Read, search, browse | Curious, citation-heavy |
| `engineer` | Writes and edits code | Read, write, run, test | Direct, code-first |
| `reviewer` | Critiques diffs and designs | Read-only | Caution-first, structured |
| `coach` | Explains and encourages | Read, search | Patient, scaffolding |
| `operator` | Runs ops, talks to systems | Process, network, terminal | Terse, operational |

Plus:

- A CLI (`ethos chat`) with streaming output and slash commands.
- Channel adapters for Telegram, Discord, and Slack — same agent, same memory, same sessions across all four surfaces.
- Persistent sessions in SQLite, scoped per working directory.
- Plain-text memory files (`MEMORY.md`, `USER.md`) you can read, grep, edit, and commit.
- A skill discovery layer that picks up your existing libraries from Claude Code, OpenClaw, OpenCode, and Hermes — no porting.

## What Ethos is *not*

- **Not a chatbot SDK.** Ethos does not generate a website chat widget for you. It's the agent runtime; you bring the interface.
- **Not a workflow engine.** Ethos does not chain steps into pipelines or DAGs. The unit is a turn — a user message in, streamed events out.
- **Not a multi-model router.** A personality declares one model. If you want different models per turn, you use different personalities.
- **Not a no-code tool.** Personalities are config files, but extending Ethos (new tools, new providers, new channel adapters) is TypeScript code against typed interfaces.

## The shape of a turn

You send a message. The agent reads memory, builds a prompt, calls the LLM, executes any tools the LLM requests (in parallel, within a budget), syncs memory, and emits a stream of typed events while it does it.

That stream — every event — is one of eight types: `text_delta`, `thinking_delta`, `tool_start`, `tool_progress`, `tool_end`, `usage`, `error`, `done`. Every surface (CLI, channel adapter, web UI) consumes this stream and renders what it wants.

[Architecture in 90 seconds](architecture-90-seconds.md) shows the full diagram.

## Why this matters

The trade-offs add up to a specific kind of agent:

- **A specialist, not a generalist.** Because the personality is structural, you can credibly say "the reviewer cannot edit files" — it's enforced at the toolset boundary, not just discouraged in the prompt.
- **Multi-platform from day one.** Sessions are keyed per working directory, not per platform. A conversation started on Telegram continues on the CLI.
- **Yours to read.** Memory is plain markdown. Config is plain YAML. Skills are plain markdown with frontmatter. You can grep, diff, and commit any of it.
- **Yours to extend.** Every extension point — provider, tool, adapter, memory backend, personality source — is a typed interface in `@ethosagent/types`. Implement, inject, ship.

## See also

- [Why Ethos?](why-ethos.md) — honest comparison to LangChain, CrewAI, AutoGen, OpenClaw, Hermes
- [Architecture in 90 seconds](architecture-90-seconds.md) — the components behind the pitch
- [Quickstart](../using/quickstart.md) — install Ethos and send the first message in five minutes
- [Glossary](glossary.md) — every domain term defined
