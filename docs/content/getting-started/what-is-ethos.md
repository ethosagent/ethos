---
title: "What is Ethos?"
description: "Ethos is a TypeScript agent framework where personality is architecture — a directory of files that changes prompt, tools, memory, and model atomically."
kind: explanation
audience: shared
slug: what-is-ethos
updated: 2026-06-09
---

**Ethos is a TypeScript framework where [personality](glossary.md#personality) is the unit of architecture.** Not a system prompt string. A directory of files that, when switched, atomically changes the agent's prompt, tool access, memory scope, and model.

## The one-sentence pitch

A `personality` lives at `~/.ethos/personalities/<id>/` and contains three files:

```
<id>/
├── SOUL.md        first-person identity (how do I speak, what am I for)
├── config.yaml     name, description, model, memoryScope, budget, fs_reach
└── toolset.yaml    flat list of allowed tool names
```

Switching from `researcher` to `engineer` mid-chat does not just swap a system prompt. It atomically swaps:

- The system prompt (`SOUL.md`)
- The tools the agent can call (`toolset.yaml`)
- Whether memory is shared with the user-default scope or isolated (`memoryScope`)
- Which model handles the next turn (`model`)

You cannot accidentally run the engineer personality's write-shaped tools under the reviewer's read-only toolset. The four dimensions move together.

## What you get out of the box

Three personalities ship by default for everyday use. Each has its own role, tools, and voice.

| Personality | Role | Tools | Voice |
|---|---|---|---|
| `researcher` | Explores, summarises, cites | Read, search, browse | Curious, citation-heavy |
| `engineer` | Writes and edits code | Read, write, run, test | Direct, code-first |
| `reviewer` | Critiques diffs and designs | Read-only | Caution-first, structured |

Two additional system personalities — `personality-architect` and `team-architect` — are available for building and managing other personalities.

Beyond personalities, the framework ships:

- **CLI** — `ethos chat` with streaming output, slash commands, and [zero mode](../using/how-to/use-zero-mode.md) (`ethos -z "prompt"`) for one-shot scripting.
- **Inline context** — [`@file` and `@url` references](../using/how-to/use-inline-context-refs.md) that auto-inline files and URLs as context before the LLM sees the prompt.
- **Web dashboard** — full React SPA (`ethos serve --web`) with chat, session browser, personality management, skills library, MCP server config, plugin management, memory viewer, team boards, mesh visualization, cron job scheduling, activity feed, batch/eval runs, and custom dashboards with plugin data sources. See [Use the web dashboard](../using/how-to/use-web-dashboard.md).
- **Desktop app** — Electron app with system tray, quick-chat overlay, global shortcuts, auto-update, and OS keychain integration. Runs local or remote. See [Desktop app](../platforms/desktop.md).
- **VS Code extension** — sidebar panel that brings the agent into the editor.
- **Nine surfaces** — CLI, web dashboard, desktop app, VS Code extension, and five channel adapters (Telegram, Discord, Slack, WhatsApp, Email). Same agent, same memory, same sessions across all of them.
- **Plugin ecosystem** — plugins register tools, hooks, providers, [slash commands](../using/explanation/plugin-commands.md), and data sources. Plugins declare widget templates in `widgets.yaml`. Default-deny allowlists per personality. See [Plugin SDK reference](../building/reference/plugin-sdk.md).
- **Custom dashboards** — draggable panel grid powered by plugin data sources, SQL queries, cron auto-refresh, and inter-panel communication. See [Build a custom dashboard](../building/tutorials/build-custom-dashboard.md).
- **Skill evolution** — `@ethosagent/skill-evolver` analyzes eval output, proposes skill rewrites and new skills, with a human approval queue in web and desktop. See [Manage skill evolution](../using/how-to/manage-skill-evolution.md).
- **Persistent sessions** in SQLite, scoped per working directory.
- **Plain-text memory** files (`MEMORY.md`, `USER.md`) you can read, grep, edit, and commit.
- **Skill discovery** that picks up your existing libraries from Claude Code, OpenClaw, OpenCode, and Hermes — no porting.
- **Scheduled tasks** via a single `cron` tool — daily briefings, weekly reports, recurring prompts.
- **Teams** that decompose multi-part requests into specialist tasks on a durable kanban board with an audit trail.
- **Admin panel** — MCP server management, channel webhooks, API key rotation from the browser. See [Use the admin panel](../using/how-to/use-admin-panel.md).

## What Ethos is *not*

- **Not a chatbot SDK.** Ethos does not generate a website chat widget for you. It's the agent runtime; you bring the interface.
- **Not a workflow engine.** Ethos does not chain steps into pipelines or DAGs. The unit is a turn — a user message in, streamed events out.
- **Not a multi-model router.** A personality declares one model. If you want different models per turn, you use different personalities.
- **Not a no-code tool.** Personalities are config files, but extending Ethos (new tools, new providers, new channel adapters) is TypeScript code against typed interfaces.

## The shape of a turn

You send a message. The agent reads memory, builds a prompt, calls the LLM, executes any tools the LLM requests (in parallel, within a budget), syncs memory, and emits a stream of typed events while it does it.

That stream — every event — is one of eight types: `text_delta`, `thinking_delta`, `tool_start`, `tool_progress`, `tool_end`, `usage`, `error`, `done`. Every surface — CLI, web dashboard, desktop app, VS Code extension, channel adapters (Telegram, Discord, Slack, WhatsApp, Email) — consumes this stream and renders what it wants.

[Architecture in 90 seconds](architecture-90-seconds.md) shows the full diagram.

## Why this matters

The trade-offs add up to a specific kind of agent:

- **A specialist, not a generalist.** Because the personality is structural, you can credibly say "the reviewer cannot edit files" — it's enforced at the toolset boundary, not just discouraged in the prompt.
- **Multi-platform from day one.** Sessions are keyed per working directory, not per platform. A conversation started on Telegram continues on the CLI, the desktop app, or any of the eight surfaces.
- **Yours to read.** Memory is plain markdown. Config is plain YAML. Skills are plain markdown with frontmatter. You can grep, diff, and commit any of it.
- **Yours to extend.** Every extension point — provider, tool, adapter, memory backend, personality source — is a typed interface in `@ethosagent/types`. Implement, inject, ship.

## Sessions and teams travel with you

**Sessions are platform-agnostic.** A [session](glossary.md#session) is keyed by working context, not by the surface you're talking through. Start a conversation in Telegram, keep going from the CLI on your laptop, switch from `researcher` to `engineer` mid-thread — the same memory, the same history, the same scratchpad follow you across personalities and platforms. The channel is just the door.

**Teams coordinate across specialties.** One personality is an agent; a [team](glossary.md#team) is a roster. You ask the team coordinator for something multi-part — "research the migration, draft the plan, review it" — and it decomposes the request into typed tasks on a durable kanban board. Specialist personalities claim work, post status updates, hand off, and surface blockers. The board, the audit trail, and the assignments survive restarts. See [Run a team with a shared kanban board](../using/how-to/run-a-team-with-kanban.md).

## Plugins, data sources, and dashboards

A [plugin](glossary.md#plugin) registers tools, hooks, providers, and slash commands in a single `activate()` call — the framework surfaces each command on every surface automatically. Plugins also declare data sources: typed queries that return rows for dashboards. A market-data plugin might expose `top_gainers` and `sector_heatmap`; a DevOps plugin might expose `deploy_history` and `incident_timeline`.

The web dashboard's custom dashboards consume these data sources. You build a draggable panel grid, wire each panel to a data source or a raw SQL query, set a cron refresh interval, and panels communicate — clicking a row in one panel filters another. The pipeline is: plugin registers data source, dashboard panel queries it, cron refreshes it, user sees live data alongside chat.

See [Register a plugin data source](../building/how-to/register-plugin-data-source.md) and [Build a custom dashboard](../building/tutorials/build-custom-dashboard.md).

## See also

- [Why Ethos?](why-ethos.md) — honest comparison to LangChain, CrewAI, AutoGen, OpenClaw, Hermes
- [Architecture in 90 seconds](architecture-90-seconds.md) — the components behind the pitch
- [Quickstart](../using/quickstart.md) — install Ethos and send the first message in five minutes
- [Desktop app](../platforms/desktop.md) — Electron app with system tray, quick-chat overlay, and global shortcuts
- [Glossary](glossary.md) — every domain term defined
