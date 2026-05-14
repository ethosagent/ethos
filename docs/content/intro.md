---
title: "Ethos"
description: "Ethos is a TypeScript agent framework where personality is architecture — a directory of files that changes prompt, tools, memory, and model atomically."
kind: explanation
audience: shared
slug: /
updated: 2026-05-12
---

**Ethos is a TypeScript framework where [personality](getting-started/glossary.md#personality) is the unit of architecture.** A personality lives at `~/.ethos/personalities/<id>/` — three files (`ETHOS.md`, `config.yaml`, `toolset.yaml`) that, when switched, atomically change the agent's prompt, tool access, memory scope, and model.

Five personalities ship by default. Sessions persist across CLI, Telegram, Discord, and Slack. Your existing Claude Code, OpenClaw, OpenCode, and Hermes [skill](getting-started/glossary.md#skill) libraries run as-is — filtered to the right specialist per personality.

## Two doors

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
