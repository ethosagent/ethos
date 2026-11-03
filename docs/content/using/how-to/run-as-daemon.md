---
title: "Run Ethos as a daemon"
description: "Run ethos gateway start (or another long-running command) as a persistent process: shared setup, then per-platform parts."
kind: how-to
audience: user
slug: run-as-daemon
time: "10 min"
updated: 2026-11-03
---

> **Looking for the full production setup?** If you want **both** the gateway (Telegram + Slack + Discord + Email) **and** the web dashboard up under one supervisor, with reboot survival on a mini-PC / VPS / home server, jump to [Deploy in production](deploy-in-production.md) — it uses `ethos run-all` and PM2 and is the shorter path. This page is the building-block reference for daemonising a **single** `ethos` command (the gateway by itself, or cron, or serve).

## Task

Run `ethos gateway start` (or another long-running `ethos` subcommand) as a persistent background process under systemd, launchd, Windows Task Scheduler, or pm2, surviving logout and restarting on crash. The [gateway](../../getting-started/glossary.md#gateway) is the long-running process that routes platform messages into the agent loop.

## Result

The gateway answers your bot on Telegram, Slack, Discord, WhatsApp, or email without a terminal open, restarts on failure, and starts again on boot.

## Prereqs

- `ethos` installed; `ethos --version` returns a version string.
- A provider configured via `ethos setup` ([Configure an LLM provider](configure-providers.md)).
- For gateway use, at least one platform token in `~/.ethos/config.yaml` (`telegramToken`, `slackBotToken`, etc.).
- `which ethos` returns an absolute path. If you installed via `nvm`, that path is under `~/.nvm/versions/node/...` — service managers cannot resolve a bare `ethos` without your shell.

## Parts

Do step 1 here, then follow the part for your service manager. Return here for step 3 and Verify.

| Part | Covers |
|---|---|
| [macOS: launchd](run-as-daemon/launchd.md) | Step 2A: plist, exit-code wrapper, load and unload. |
| [Linux: systemd user unit](run-as-daemon/systemd.md) | Step 2B: unit file, `ethos systemd-unit`, linger on headless servers. |
| [pm2 and Windows Task Scheduler](run-as-daemon/windows-and-pm2.md) | Steps 2C and 2D: cross-platform pm2, PowerShell supervisor. |

## What can run as a daemon

Four `ethos` subcommands are long-running. Everything else is one-shot or REPL.

| Command | Purpose |
|---|---|
| `ethos gateway start` | Multi-platform message gateway (Telegram, Slack, Discord, WhatsApp, email). |
| `ethos cron run` | Scheduled-job worker. |
| `ethos serve` | Web UI plus HTTP API. |
| `ethos acp` | Agent Control Protocol server for mesh coordination. |

The examples below use `ethos gateway start`. Substitute any of the others — the unit-file shape is the same.

## Steps

### 1. Foreground-test first

Daemons fail silently. Confirm the command works under your shell before wrapping it in a service manager.

```bash
ethos gateway start
```

Send your bot a test message from the target platform; confirm a reply. Press `Ctrl+C` to stop. If foreground does not work, the daemon will not either — fix the config first.

Note the absolute path to the binary:

```bash
which ethos
```

You'll paste it into the unit file in the next step.

Now set up the service manager for your platform in [Parts](#parts). Each part ends with a running service.

### 3. Update the daemon after `ethos upgrade`

The running process keeps the old binary in memory. Always restart after upgrading:

```bash
ethos upgrade
launchctl stop ai.ethosagent.gateway && launchctl start ai.ethosagent.gateway   # macOS
systemctl --user restart ethos-gateway                                          # Linux
pm2 restart ethos-gateway                                                       # pm2
```

On Windows, run `Stop-ScheduledTask -TaskName 'Ethos gateway'` then `Start-ScheduledTask -TaskName 'Ethos gateway'`.

## Verify

The bot replies to a fresh message within ten seconds, and the appropriate liveness check passes:

```bash
launchctl list | grep ai.ethosagent       # macOS — non-empty line
systemctl --user is-active ethos-gateway  # Linux — prints "active", exit 0
pm2 jlist | jq '.[] | .name'              # pm2 — includes "ethos-gateway"
```

On Windows, `(Get-ScheduledTask -TaskName 'Ethos gateway').State` prints `Running`.

Tail the structured logs Ethos writes alongside whatever stdout your service manager captures:

```bash
tail -f ~/.ethos/logs/gateway.out.log
```

## Operator concerns

### Detached child processes

The bash and process tools can spawn long-running background processes with `detached: true`. These processes intentionally survive when `ethos` itself stops — they are children of PID 1, not of the Ethos process tree. `ethos stop`, `systemctl --user stop ethos-gateway`, and `SIGTERM` do not reap them.

This is by design: a user might ask the agent to start a dev server or a build watcher that should keep running. But it means decommissioning `ethos` does not automatically clean up everything it started.

To see what is still running:

```bash
ethos process list
```

To stop a specific detached process:

```bash
ethos process stop <pid>
```

To stop all tracked detached processes:

```bash
ethos process stop --all
```

If `ethos process list` shows nothing but you suspect orphans, check for processes whose cwd is under `~/.ethos/`:

```bash
lsof +D ~/.ethos/ 2>/dev/null | grep -v ethos
```

## Troubleshoot

**Daemon starts but the bot does not respond.** — Run `ethos gateway start` in your shell with the same `~/.ethos/config.yaml`. If foreground works and daemon does not, it's almost always a stripped `PATH` or `HOME`. Hardcode the absolute path to `ethos` in `ProgramArguments` / `ExecStart` and set `HOME` explicitly (launchd).

**`ethos: command not found` in the service log.** — Service managers do not source your shell rc. If you installed via `nvm`, the binary lives at `~/.nvm/versions/node/v24.x.x/bin/ethos`. Paste that absolute path into the unit file.

**Telegram returns HTTP 429.** — Two gateway processes are polling the same bot token. Check for a duplicate launchd plist, a stale pm2 entry, or a forgotten `tmux` session. One process per bot token.
