---
title: "Connect a Telegram bot to a team"
description: "Bind a Telegram bot to an Ethos team so inbound messages route to the team's coordinator personality and the team supervisor starts automatically."
kind: how-to
audience: user
time: "10 min"
updated: 2026-05-13
---

## Task

Bind a Telegram bot to an Ethos [team](../../getting-started/glossary.md#team) so every inbound message routes to the team's coordinator personality and the team supervisor process starts automatically when the gateway boots.

## Result

- The bot routes every message to the team's coordinator personality.
- The gateway auto-starts the team supervisor on boot (equivalent to running `ethos team start <name>` manually).
- `/personality` switching is disabled — the bot's identity is the team coordinator.
- `ethos team status <name>` shows the supervisor as running.

## Prereqs

- `ethos chat` works locally with a configured LLM provider.
- A bot token from `@BotFather` — see step 1 of [Run multiple Telegram bots from one process](run-multi-bot-telegram.md) if you need one.
- A team manifest at `~/.ethos/teams/<name>.yaml` with a `coordinator` field set to a valid personality id.

### What the team manifest needs

The gateway reads `~/.ethos/teams/<name>.yaml` at boot to resolve the coordinator. The minimum required field is:

```yaml
# ~/.ethos/teams/eng.yaml
coordinator: engineer
```

Other team manifest fields (`members`, `goals`, `memory`, etc.) are consumed by the team supervisor process and are out of scope for this how-to. See [Run a team with Kanban](run-a-team-with-kanban.md) for full team configuration.

## Steps

### 1. Add the bot entry with `bind.type: team`

In `~/.ethos/config.yaml`, add a `telegram.bots` entry (or extend an existing list) using `bind.type: team`:

```yaml
# ~/.ethos/config.yaml

telegram.bots.0.token: "123456:ABCdefGhIJklmNopQRstuVwxYZ"
telegram.bots.0.id: eng-bot
telegram.bots.0.bind.type: team
telegram.bots.0.bind.name: eng
```

- `bind.type: team` — tells the gateway to route this bot's messages to the named team's coordinator personality, and to auto-start the team supervisor.
- `bind.name: eng` — must match the filename stem of the team manifest at `~/.ethos/teams/eng.yaml`.
- `id: eng-bot` — stable key used in session lane names and log output. Defaults to the first 24 characters of `sha256(token)` when omitted. Do not change this after the bot goes live.

### 2. Set the `autoStop` runtime knob (optional)

By default, the gateway leaves the team supervisor running when it shuts down — the supervisor is a long-lived process that may still be processing goals. To stop the supervisor automatically when the gateway exits (useful for clean dev-machine teardown):

```yaml
teams.eng.autoStop: true
```

`autoStop` defaults to `false`. With `autoStop: true`, the gateway sends SIGTERM to the supervisor process on shutdown. Restart it manually with `ethos team start eng` or let the next `ethos gateway start` auto-spawn it.

### 3. Start the gateway

```bash
ethos gateway start
```

Expected boot output:

```
ethos gateway  starting...
✓ Telegram online — eng-bot (318ms)
✓ Team supervisor — eng — started (pid 84231)
Listening for messages. Press Ctrl+C to stop.
```

The gateway logs one line per started supervisor. If the supervisor was already running (from a previous boot with `autoStop: false`), the line reads `✓ Team supervisor — eng — already running (pid 84231)`.

### 4. How message routing works

Every message sent to the bot reaches the team's coordinator personality via the same `AgentLoop` path as a personality-bound bot. The coordinator personality handles the message directly. It may delegate to team members as sub-agents — that is internal to the team and transparent to the Telegram user.

Goal completion is asynchronous. For long-running tasks, the coordinator does not block until the task is done. It acknowledges the request, starts work, and the user must follow up to check progress:

```
User:  "Analyse the Q2 data and send me a summary."
Bot:   "Starting analysis. I'll have results ready shortly."
...
User:  "Is it done?"
Bot:   "Yes — here's the summary: ..."
```

This is the v1 behaviour. Future versions may push completion events back to the chat automatically.

### 5. Verify the team is running after boot

Check the supervisor status separately:

```bash
ethos team status eng
```

Expected output:

```
eng   running   pid 84231   uptime 2m 14s
```

If the status shows `stopped` or `error`, see the troubleshoot section below.

## Verify

**Bot replies through the coordinator.**

DM the bot with a message. The reply style should match the `coordinator` personality defined in `~/.ethos/teams/eng.yaml`. If it replies like the wrong personality, confirm that `bind.name` matches the team manifest filename and that the manifest's `coordinator` field points to an installed personality.

**Team supervisor is running.**

```bash
ethos team status eng
```

Returns `running`. If you see `stopped`, the supervisor failed to start — check `~/.ethos/logs/team-eng.log`.

**`/personality` returns a rejection.**

Send `/personality researcher` to the bot. The bot replies:

```
This bot's identity is fixed. The /personality command is not available here.
```

This is correct. Team-bound bots do not support `/personality` switching. The coordinator identity is the team.

## Troubleshoot

**Supervisor not running after gateway start.**

Check the team logs:

```bash
cat ~/.ethos/logs/team-eng.log | tail -40
```

Common causes:

- The team manifest is missing or malformed. Run `ethos team validate eng` to check.
- The coordinator personality does not exist. Confirm with `ethos personalities list`.
- Another process is already holding the supervisor's lock file at `~/.ethos/teams/eng.lock`. Kill the stale process or remove the lock file.

**Team manifest not found.**

```
[gateway] team "eng" manifest not found at ~/.ethos/teams/eng.yaml
```

The `bind.name` in config does not match any file in `~/.ethos/teams/`. Check for typos. The manifest filename (without `.yaml`) must equal `bind.name` exactly.

**Bot responds with the wrong personality.**

The `coordinator` field in the team manifest points to a personality id that exists but is not the one you intended. Edit `~/.ethos/teams/eng.yaml`, update `coordinator`, and restart the gateway.

**Supervisor keeps restarting.**

The supervisor process is crashing on startup. Check `~/.ethos/logs/team-eng.log` for the error. Most common cause: the team manifest references a model that is not available for the configured provider.

**Gateway shuts down but supervisor keeps running unexpectedly.**

`autoStop` is set to `false`. This is the intended behaviour. To stop the supervisor manually:

```bash
ethos team stop eng
```

## See also

- [Run multiple Telegram bots from one process](run-multi-bot-telegram.md) — configure the `telegram.bots` list shape used in this how-to.
- [Run a team with Kanban](run-a-team-with-kanban.md) — full team manifest configuration and goal tracking.
- [config.yaml reference](../reference/config-yaml.md#teams) — `teams.*` runtime knobs.
- [Telegram adapter](../../platforms/telegram.md) — full routing, allowlist, and error catalog.
- [Glossary: team](../../getting-started/glossary.md#team), [personality](../../getting-started/glossary.md#personality), [session](../../getting-started/glossary.md#session).
