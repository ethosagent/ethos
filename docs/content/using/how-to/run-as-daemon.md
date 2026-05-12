---
title: "Run Ethos as a daemon"
description: "Run ethos gateway start (or any long-running ethos command) under systemd, launchd, or pm2 as a persistent process."
kind: how-to
audience: user
slug: run-as-daemon
time: "10 min"
updated: 2026-05-12
---

## Task

Run `ethos gateway start` (or another long-running `ethos` subcommand) as a persistent background process under systemd, launchd, or pm2, surviving logout and restarting on crash. The [gateway](../../getting-started/glossary.md#gateway) is the long-running process that routes platform messages into the agent loop.

## Result

The gateway answers your bot on Telegram, Slack, Discord, WhatsApp, or email without a terminal open, restarts on failure, and starts again on boot.

## Prereqs

- `ethos` installed; `ethos --version` returns a version string.
- A provider configured via `ethos setup` ([Configure an LLM provider](configure-providers.md)).
- For gateway use, at least one platform token in `~/.ethos/config.yaml` (`telegramToken`, `slackBotToken`, etc.).
- `which ethos` returns an absolute path. If you installed via `nvm`, that path is under `~/.nvm/versions/node/...` — service managers cannot resolve a bare `ethos` without your shell.

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

### 2A. macOS — launchd

`launchd` ships with macOS. Unit files (plists) live in `~/Library/LaunchAgents/`. Write `~/Library/LaunchAgents/ai.ethosagent.gateway.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.ethosagent.gateway</string>

  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/ethos</string>
    <string>gateway</string>
    <string>start</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>/Users/YOUR_USERNAME</string>
  </dict>

  <key>WorkingDirectory</key>
  <string>/Users/YOUR_USERNAME</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/Users/YOUR_USERNAME/.ethos/logs/gateway.out.log</string>

  <key>StandardErrorPath</key>
  <string>/Users/YOUR_USERNAME/.ethos/logs/gateway.err.log</string>
</dict>
</plist>
```

Replace `YOUR_USERNAME` with the output of `whoami` and the binary path with `which ethos`. Then load and start:

```bash
launchctl load ~/Library/LaunchAgents/ai.ethosagent.gateway.plist
launchctl start ai.ethosagent.gateway
launchctl list | grep ethosagent
tail -f ~/.ethos/logs/gateway.out.log
```

Stop, unload, or reload:

```bash
launchctl stop   ai.ethosagent.gateway
launchctl unload ~/Library/LaunchAgents/ai.ethosagent.gateway.plist
```

`RunAtLoad` plus the `~/Library/LaunchAgents/` location starts the agent at login. `KeepAlive` restarts it on crash.

### 2B. Linux — systemd user unit

User units live in `~/.config/systemd/user/` and run as your login user. Write `~/.config/systemd/user/ethos-gateway.service`:

```ini
[Unit]
Description=Ethos gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/ethos gateway start
Restart=on-failure
RestartSec=5
StandardOutput=append:%h/.ethos/logs/gateway.out.log
StandardError=append:%h/.ethos/logs/gateway.err.log
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

Replace `/usr/bin/ethos` with the output of `which ethos`. Enable, start, and inspect:

```bash
systemctl --user daemon-reload
systemctl --user enable --now ethos-gateway.service
systemctl --user status ethos-gateway
journalctl --user -u ethos-gateway -f
```

To survive logout on a headless server:

```bash
sudo loginctl enable-linger $USER
```

Restart, stop, or disable:

```bash
systemctl --user restart ethos-gateway
systemctl --user stop    ethos-gateway
systemctl --user disable ethos-gateway
```

### 2C. Cross-platform — pm2

[pm2](https://pm2.keymetrics.io) is a Node process manager. Same commands on macOS, Linux, and Windows; bundled log rotation; `pm2 startup` wires into the OS service manager.

```bash
npm install -g pm2
pm2 start ethos --name ethos-gateway -- gateway start
pm2 list
pm2 logs ethos-gateway
```

The `--` separates pm2's own flags from the args passed to `ethos`. Survive reboots:

```bash
pm2 startup   # prints a command — run it as root
pm2 save
```

Common operations:

```bash
pm2 restart ethos-gateway
pm2 stop    ethos-gateway
pm2 delete  ethos-gateway
pm2 monit
pm2 logs    ethos-gateway --lines 200
```

Run multiple Ethos processes side by side with a pm2 ecosystem file (`ecosystem.config.js`):

```javascript
module.exports = {
  apps: [
    { name: 'ethos-gateway', script: 'ethos', args: 'gateway start' },
    { name: 'ethos-cron',    script: 'ethos', args: 'cron run' },
    { name: 'ethos-serve',   script: 'ethos', args: 'serve --port 3000' },
  ],
};
```

```bash
pm2 start ecosystem.config.js
pm2 save
```

### 3. Update the daemon after `ethos upgrade`

The running process keeps the old binary in memory. Always restart after upgrading:

```bash
ethos upgrade
launchctl stop ai.ethosagent.gateway && launchctl start ai.ethosagent.gateway   # macOS
systemctl --user restart ethos-gateway                                          # Linux
pm2 restart ethos-gateway                                                       # pm2
```

## Verify

The bot replies to a fresh message within ten seconds, and the appropriate liveness check passes:

```bash
launchctl list | grep ai.ethosagent       # macOS — non-empty line
systemctl --user is-active ethos-gateway  # Linux — prints "active", exit 0
pm2 jlist | jq '.[] | .name'              # pm2 — includes "ethos-gateway"
```

Tail the structured logs Ethos writes alongside whatever stdout your service manager captures:

```bash
tail -f ~/.ethos/logs/gateway.out.log
```

## Troubleshoot

**Daemon starts but the bot does not respond.** — Run `ethos gateway start` in your shell with the same `~/.ethos/config.yaml`. If foreground works and daemon does not, it's almost always a stripped `PATH` or `HOME`. Hardcode the absolute path to `ethos` in `ProgramArguments` / `ExecStart` and set `HOME` explicitly (launchd).

**`ethos: command not found` in the service log.** — Service managers do not source your shell rc. If you installed via `nvm`, the binary lives at `~/.nvm/versions/node/v24.x.x/bin/ethos`. Paste that absolute path into the unit file.

**`Run ethos setup first` on boot.** — `HOME` does not point at your user account. systemd user units inherit it correctly; launchd sometimes does not. Set `HOME` in the plist `EnvironmentVariables` block as shown above.

**Telegram returns HTTP 429.** — Two gateway processes are polling the same bot token. Check for a duplicate launchd plist, a stale pm2 entry, or a forgotten `tmux` session. One process per bot token.

**Daemon stops on logout (Linux).** — Run `sudo loginctl enable-linger $USER` once. Without it, systemd tears down user units when the last login session ends.

**Memory grows unbounded.** — Check `pm2 monit` or `top -p $(pgrep -f "ethos gateway")`. If the resident set climbs steadily over hours, it's likely a leak — file an issue with a `node --inspect` heap snapshot. Short-term: pm2 supports `--max-memory-restart 500M` to recycle the process at a threshold.

**Logs missing on Linux.** — `StandardOutput=append:` requires systemd 240+; on older systems, drop those lines and use `journalctl --user -u ethos-gateway` instead.
