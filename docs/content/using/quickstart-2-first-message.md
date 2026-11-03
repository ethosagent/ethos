---
title: "Quickstart, part 2: send a message and find your files"
description: "Send the first message, see what happened and where things live."
kind: tutorial
audience: user
updated: 2026-11-03
---

## Goal

Finish steps 4-6 of [Quickstart](quickstart.md): Send your first real message; See what just happened; Where things live.

## Prereqs

- Complete [part 1 of 2](quickstart.md).

## 4. Send your first real message

Type a real question — pick something specific enough to make the response interesting:

```
You > what is the capital of france and what is one famous building there?
```

Three things happen, all visible on screen:

1. A `thinking` spinner counts seconds while the model thinks. The spinner is rendered from the time between turn start and the first `text_delta`.
2. Streamed text appears under `ethos >`, one token group at a time.
3. The prompt returns to `You >` when the [turn](../getting-started/glossary.md#turn) is done. A turn is one message in, one streamed response out.

The conversation is captured in a [session](../getting-started/glossary.md#session) keyed to this working directory — the session key is `cli:<basename-of-cwd>`. The session lives in `~/.ethos/sessions.db` (SQLite with WAL and FTS5). Close the chat, reopen it from the same directory, and the agent remembers what you asked. Different working directories get different sessions; the agent does not see across them.

To pick up where you left off explicitly, use `ethos chat --continue` (or `-c`) to resume the most recent session, or `--resume <id>` to jump to a specific conversation by ID or title. See the [CLI reference](./reference/cli.md#ethos-chat) for the full flag list.

Two things to notice as you watch the reply stream:

- The first chunk arrives within 1–2 seconds. Subsequent chunks should land sub-second. If the gap between chunks is longer than that, the provider is rate-limiting or the model is slow.
- The CLI renders text deltas inline. Tool calls (when the personality uses them) print a `⟳ tool_name` chip that flips to `✓ tool_name <duration>ms` when the tool returns. The next tutorial walks through one explicitly.

## 5. See what just happened

While still in chat, type:

```
/usage
```

You should see something like:

```
Tokens  : 184 in · 96 out
Cost    : $0.00214
```

These are real numbers from the provider. The cost is an estimate based on the model's published rates — close enough to budget against. The provider's own dashboard is the source of truth for billing.

Type `/help` to scan the rest of the slash commands. The headline ones (each gets a section in [Slash commands reference](./reference/slash-commands.md)):

```
/new          start a fresh session in this directory
/personality  show, list, or switch personality
/memory       print MEMORY.md and USER.md
/usage        tokens and cost stats
/budget       session spend against the personality's cap
/exit         quit
```

Quit when you are done:

```
/exit
```

The session you just had is preserved on disk. Run `ethos chat` again from the same directory and the agent recalls it.

## 6. Where things live

A working install creates exactly one directory: `~/.ethos/`. After this tutorial, it contains:

```
~/.ethos/
├── config.yaml       provider, model, api key, default personality
├── sessions.db       SQLite store of every conversation
├── logs/             structured logs (errors.jsonl, gateway.out.log, etc.)
└── personalities/    your custom personalities (empty after this tutorial)
```

Two files you may want to back up: `config.yaml` (cheap to recreate, but contains the API key) and `sessions.db` (every conversation you have had). Memory files (`MEMORY.md`, `USER.md`) land here as well once a personality writes to them — the next tutorial covers that layer.

For a graphical view, run `ethos serve` — the web dashboard lets you manage personalities, memory, skills, cron jobs, sessions, and MCP servers from the browser. See [Use the web dashboard](./how-to/use-web-dashboard.md).

Everything else (`mcp.json`, `communications.json`, `keys.json`, `skills/`) is created by features you have not yet used.

## What you learned

- The CLI installs through one command and stores config at `~/.ethos/config.yaml`.
- `ethos chat` opens a streaming REPL bound to one provider and one personality.
- Sessions persist across restarts, keyed by working directory.
- `/usage` reports tokens and estimated cost for the current session.

## Beyond the CLI

The CLI is one of several ways to interact with Ethos. `ethos serve` starts a local [web dashboard](./how-to/use-web-dashboard.md) for managing personalities, memory, skills, cron jobs, and sessions from the browser. An [Electron desktop app](../platforms/desktop.md) wraps the same dashboard as a native application. To skip the local install entirely, [Run Ethos in Docker](./how-to/run-in-docker.md) brings up a talking web UI with one API key and one `docker compose up`. For messaging, channel adapters bring [Telegram](../platforms/telegram.md), [Slack](../platforms/slack.md), [Discord](../platforms/discord.md), and Email into the same agent — the [first Telegram deploy tutorial](./tutorials/first-deploy-telegram.md) walks through the setup, starting from `ethos setup messaging` or `ethos gateway setup`. The quickstart focuses on the CLI because it is the fastest path to a working session; the other surfaces build on top of the same config and sessions.

## Next step

You have a working agent. The next tutorial walks you through the turn cycle conceptually while you do it: send three messages, watch tool calls render, check usage, exit and reopen to verify session persistence, switch personality.

- [Build your first agent](./tutorials/first-agent.md) — three messages, two personalities, ten minutes.
- [Run Ethos in Docker](./how-to/run-in-docker.md) — one API key, one `docker compose up`, a web UI you can talk to.
- [Install on Windows](./how-to/install-on-windows.md) — native Windows install via PowerShell, no WSL or admin rights needed.
- [Install on Windows (WSL2)](./how-to/install-on-windows-wsl2.md) — WSL2 path for the dashboard terminal pane and a full POSIX environment.
- [Deploy in production](./how-to/deploy-in-production.md) — bots and dashboard running on a mini PC or VPS, surviving reboots, in three commands.
- [Use skills](./how-to/use-skills.md) — discover and install skills from Claude Code, OpenClaw, Hermes, and other sources.
- [config.yaml reference](./reference/config-yaml.md) — every field the file accepts, if you want to read ahead.
- [Glossary](../getting-started/glossary.md) — every domain term in one place.
