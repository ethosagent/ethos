---
title: "Ethos"
description: "Ethos is a TypeScript agent framework where personality is architecture — a directory of files that changes prompt, tools, memory, and model atomically."
kind: explanation
audience: shared
slug: /
updated: 2026-05-12
---

**[Personalities](getting-started/glossary.md#personality) aren't hats you swap in the prompt. They're enforced boundaries.** A personality in Ethos is a directory of files — `SOUL.md`, `config.yaml`, `toolset.yaml` — that the runtime treats as a structural component. Switching it changes prompt, tools, memory, and model atomically. The boundary is enforced at the [tool registry](getting-started/glossary.md#tool), not requested in the prompt.

That single decision pays off four ways:

- **Structural isolation.** The `reviewer` personality's `toolset.yaml` omits `write_file`. No prompt — yours, the model's, an injected one — can talk it into editing the diff under review. The framework refuses the call.
- **One agent, every platform.** [Sessions](getting-started/glossary.md#session) are keyed by working context, not by channel. Start a conversation on Telegram, continue it on the CLI, switch personalities mid-thread — same memory, same history.
- **Safe plugins.** Every [tool](getting-started/glossary.md#tool) declares what it reads, what it writes, and what network it touches. The runtime enforces those declarations per call. Granting an unfamiliar plugin to a personality is bounded by what its toolset already allows.
- **Teams, not just agents.** A coordinator personality decomposes one request into specialist tasks; the [team](getting-started/glossary.md#team) executes them against a durable kanban board with a full audit trail. Same primitives — personality, toolset, session — composed.

Five personalities ship by default. Your existing Claude Code, OpenClaw, OpenCode, and Hermes [skill](getting-started/glossary.md#skill) libraries run as-is, filtered to the right specialist per personality.

## Two doors

The rest of these docs split by what you're here to do — run Ethos, or extend it.

<div className="docsGrid">

<a className="docsCard" href="/docs/using/quickstart">
  <h3>Using Ethos →</h3>
  <p>Install the CLI, configure a provider, run your first chat, ship a Telegram bot. Five minutes to first message.</p>
</a>

<a className="docsCard" href="/docs/building/quickstart">
  <h3>Building on Ethos →</h3>
  <p>Write a tool, add an LLM provider, build a channel adapter, publish a plugin. Ten minutes to first commit.</p>
</a>

</div>

## Before you choose a door

- [What is Ethos?](getting-started/what-is-ethos.md) — 90-second mental model of personalities, sessions, and the streaming event contract.
- [Architecture in 90 seconds](getting-started/architecture-90-seconds.md) — one diagram of `AgentLoop` and every component that hangs off it.
- [Why Ethos?](getting-started/why-ethos.md) — honest comparison to LangChain, CrewAI, AutoGen, OpenClaw, Hermes.
- [Glossary](getting-started/glossary.md) — every domain term in one place.

## For AI agents reading these docs

Other AI agents (Claude Code, Cursor, OpenClaw, Hermes) are first-class readers of Ethos's docs. Once Phase 6 of the docs rewrite lands, three agent-readable surfaces ship alongside the site: `llms.txt` (link-index), `llms-full.txt` (full content), and per-page raw markdown at `<path>.md`. The convention is documented in the [`/docs` skill, §Agent-readable surface](https://github.com/MiteshSharma/ethos/blob/main/.agents/skills/docs/SKILL.md#agent-readable-surface-two-file--raw-markdown).
