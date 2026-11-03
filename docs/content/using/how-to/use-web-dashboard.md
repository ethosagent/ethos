---
title: "Use the web dashboard"
description: "Start the Ethos web dashboard, manage personalities, browse memory, schedule cron jobs, and handle MCP OAuth — all from the browser."
kind: how-to
audience: user
slug: use-web-dashboard
time: "10 min"
updated: 2026-11-03
---

## Task

Use the web dashboard as a first-class management surface alongside the CLI for managing [personalities](../../getting-started/glossary.md#personality), [memory](../../getting-started/glossary.md#memory), cron jobs, and MCP servers.

## Result

A running dashboard at `http://localhost:3000` where you can create and edit personalities, browse memory, manage cron jobs, and handle MCP OAuth flows — all from the browser.

## Prereqs

- `ethos` installed and a provider configured ([Configure an LLM provider](configure-providers.md)).
- A modern browser (Chrome, Firefox, Safari, Edge).
- For remote access: an SSH tunnel or reverse proxy to the host running `ethos serve`.

## Parts

| Part | Covers |
|---|---|
| This page | Steps 1-5: start the dashboard, tabs, create and edit personalities, browse memory |
| [Cron, MCP, chat and admin](use-web-dashboard/cron-mcp-chat-admin.md) | Steps 6-13: cron jobs, MCP servers, chat, remote access, dashboards, admin panel, learning, notifications |

## Steps

### 1. Start the dashboard

```bash
ethos serve
```

The dashboard starts on port 3000 by default. To use a different port:

```bash
ethos serve --web-port 8080
```

For remote machines, open an SSH tunnel:

```bash
ssh -L 3000:localhost:3000 user@remote-host
```

Then open `http://localhost:3000` in your local browser.

### 2. Navigate the main tabs

The sidebar shows eight tabs:

| Tab | Purpose |
|---|---|
| **Chat** | Interactive chat with the active personality. |
| **Personalities** | Create, edit, and inspect personality configurations. |
| **Memory** | Browse and search personality memory (`MEMORY.md`) and user memory (`USER.md`). |
| **Documents** | Browse, download, and delete the files a personality wrote in its working directories; create folders and upload files into them. See [Retrieve files the agent wrote](retrieve-agent-files.md) and [Upload a file into the agent's folder](upload-agent-files.md). |
| **Cron** | View, manage, and test scheduled jobs. |
| **MCP** | Add MCP servers, handle OAuth, manage tokens. |
| **Dashboards** | View plugin data sources as customizable widget panels. |
| **Admin** | Manage channels, API keys, and MCP server connections. |

### 3. Create a personality via the wizard

Navigate to the **Personalities** tab and click **Create Personality**. The wizard walks through seven steps:

**Step 1 — Basics.** Set the personality ID (lowercase, hyphens allowed), display name, and description. The ID becomes the directory name under `~/.ethos/personalities/`.

**Step 2 — Soul.** Write or paste the `SOUL.md` content. This is the first-person identity document — who the personality is, how it speaks, what it values. The editor supports markdown preview.

**Step 3 — Config.** Set the model (`claude-sonnet-5`, `gpt-5.6-terra`, etc.), memory scope, and optional overrides like `temperature` and `maxTokens`. These map to fields in `config.yaml`.

**Step 4 — Toolset.** Select which tools the personality can access. The checklist groups tools by category (file, terminal, web, memory, cron). Each selected tool is written to `toolset.yaml`.

**Step 5 — Skills.** Attach skills from the discovered skill library. The list comes from `ethos skills list` — skills installed via ClawHub, Claude Code, or the local `~/.ethos/skills/` directory.

**Step 6 — MCP.** Attach MCP servers from the registered list in `mcp.json`. If a server requires OAuth, the wizard prompts you to authenticate now (the token is stored at the per-personality path). See [Set up MCP for a personality](set-up-mcp-for-a-personality.md) for the full flow.

**Step 7 — Plugins.** Attach plugins from `~/.ethos/plugins/`. This step is optional — most personalities don't need plugins.

Click **Create** to write the personality to disk. The personality registry picks it up on the next turn (mtime-cached, no restart needed).

### 4. Edit a personality

Click a personality card in the **Personalities** tab to open its detail view. Each section (Soul, Config, Toolset, Skills, MCP, Plugins) is editable inline. Changes write directly to the corresponding file under `~/.ethos/personalities/<id>/`.

The **Character Sheet** panel on the right renders the same output as `ethos personality show <id>` — identity, routing, memory scope, toolset, MCP servers, and plugins.

### 5. Browse memory

Navigate to the **Memory** tab. Two independent dropdowns control what you see:

- **Personality dropdown** — select a personality to browse its `MEMORY.md`. This is the rolling project context updated each session.
- **User dropdown** — select a user profile to browse `USER.md`. This is the persistent cross-session, cross-personality user profile.

The memory viewer renders markdown with syntax highlighting. Use the search bar to find entries across the selected memory file.

Steps 6-13 (cron jobs, MCP servers, chat, remote access and the rest) continue in [cron, MCP, chat and admin](use-web-dashboard/cron-mcp-chat-admin.md).

## Verify

Open `http://localhost:3000` in your browser. The dashboard loads with the sidebar tabs visible. Click **Personalities** — your existing personalities appear as cards. If you created a personality via the wizard, `ethos personality list` in a separate terminal shows the same roster.

## Troubleshoot

**Dashboard doesn't load at `localhost:3000`** — Verify `ethos serve` is running. Check the terminal for errors. If port 3000 is in use, specify a different port with `--web-port`.

**Personalities tab is empty** — No personalities exist yet. Create one with the wizard or from the CLI:

```bash
ethos personality create engineer
```

**Memory tab shows "No content"** — The selected personality or user has no memory yet. Start a chat session and the agent populates `MEMORY.md` after the first turn.

**Changes made in the dashboard don't appear in CLI** — The dashboard writes to the same `~/.ethos/` directory the CLI reads. Changes should appear immediately. If they don't, the personality registry's mtime cache may not have refreshed — run any `ethos` command to trigger a reload.

**Dashboard is slow on first load** — The web assets are served from the `ethos serve` process. The first load compiles and bundles the frontend. Subsequent loads are cached.

## See also

- [Set up MCP for a personality](set-up-mcp-for-a-personality.md) — detailed MCP OAuth walkthrough for both web and CLI paths.
- [Schedule tasks with cron](schedule-tasks-with-cron.md) — create and manage cron jobs via the agent.
- [Run Ethos as a daemon](run-as-daemon.md) — run `ethos serve` as a persistent background process.
- [Deploy in production](deploy-in-production.md) — full production setup with gateway, web dashboard, and PM2.
- [CLI reference](../reference/cli.md) — the CLI equivalents of every dashboard action.
- [Personality config](../reference/personality-yaml.md) — the file format behind the wizard's Config step.
- [Use the admin panel](use-admin-panel.md) — manage channels, keys, and MCP servers.
- [Manage skill evolution](manage-skill-evolution.md) — review and approve auto-proposed skills.
