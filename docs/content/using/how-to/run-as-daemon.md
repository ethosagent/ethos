---
title: "Run Ethos as a daemon"
description: "Run ethos gateway start (or any long-running ethos command) under systemd, launchd, Windows Task Scheduler, or pm2 as a persistent process."
kind: how-to
audience: user
slug: run-as-daemon
time: "10 min"
updated: 2026-09-25
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
    <string>/bin/sh</string>
    <string>-c</string>
    <string>/usr/local/bin/ethos gateway start; c=$?; if [ $c -eq 3 ] || [ $c -eq 78 ]; then exit 0; fi; exit $c</string>
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
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>ThrottleInterval</key>
  <integer>30</integer>

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

`RunAtLoad` plus the `~/Library/LaunchAgents/` location starts the agent at login. `KeepAlive` with `SuccessfulExit` set to `false` restarts it after a non-zero exit (a crash) and leaves it stopped after a clean exit.

launchd has no equivalent of systemd's `RestartPreventExitStatus`, so the `/bin/sh -c` wrapper does that job. The gateway exits `78` when `config.yaml` is invalid and `3` when another gateway already holds the state directory. Both are refusals that a restart cannot fix. The wrapper turns them into exit `0`, so launchd leaves the job stopped instead of respawning it forever. The reason stays in `gateway.err.log`.

`ThrottleInterval` is the minimum gap, in seconds, between two launches of the job. launchd's default is 10. A value of 30 caps a crash loop at two starts a minute, which keeps a failing provider or platform from being hammered.

### 2B. Linux — systemd user unit

User units live in `~/.config/systemd/user/` and run as your login user. Write `~/.config/systemd/user/ethos-gateway.service`:

```ini
[Unit]
Description=Ethos gateway
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
ExecStart=/usr/bin/ethos gateway start
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=3 78
StandardOutput=append:%h/.ethos/logs/gateway.out.log
StandardError=append:%h/.ethos/logs/gateway.err.log
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

Alternatively, generate the unit file automatically:

```bash
ethos systemd-unit ethos-gateway > ~/.config/systemd/user/ethos-gateway.service
```

This generates a production-ready unit with managed mode (`ETHOS_MANAGED=1`) and `EnvironmentFile` for secrets. See [CLI reference: systemd-unit](../reference/cli.md#ethos-systemd-unit) for placeholders and customisation.

Replace `/usr/bin/ethos` with the output of `which ethos` if writing the unit manually. Enable, start, and inspect:

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

Running gateway + serve together as one supervised unit? Don't list them as separate PM2 apps — use [Deploy in production](deploy-in-production.md), which wraps `ethos run-all` as a single PM2 process that spawns and watches both children. That gives you in-process restart-on-crash AND PM2's reboot survival without the double-supervision footgun.

The pm2-app-per-ethos-command shape *is* still right when you want to daemonise just one long-running command (e.g. only `ethos cron run` for a scheduled-job worker without the gateway), which is what this page is about.

### 2D. Windows — Task Scheduler

Task Scheduler ships with Windows and needs no admin rights for a task that runs as you at logon. A small PowerShell supervisor restarts the gateway after a crash and stops on the two refusal exits (`3`, `78`), the same rule as the systemd unit's `RestartPreventExitStatus`. Task Scheduler starts that supervisor at logon.

Save this as `%USERPROFILE%\.ethos\gateway-supervisor.ps1`:

```powershell
$ethos = "$env:LOCALAPPDATA\ethos\bin\ethos.cmd"
$log = "$env:USERPROFILE\.ethos\logs\gateway.log"
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
while ($true) {
  & $ethos gateway start *>> $log
  $code = $LASTEXITCODE
  # 0 = clean stop; 3 = another gateway holds the state dir; 78 = invalid config.
  if ($code -eq 0 -or $code -eq 3 -or $code -eq 78) { exit $code }
  Start-Sleep -Seconds 30
}
```

If you did not use the Windows installer, replace `$ethos` with the output of `(Get-Command ethos).Source`. Register and start the task from PowerShell:

```powershell
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$env:USERPROFILE\.ethos\gateway-supervisor.ps1`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'Ethos gateway' -Action $action -Trigger $trigger -Settings $settings
Start-ScheduledTask -TaskName 'Ethos gateway'
```

`-ExecutionTimeLimit ([TimeSpan]::Zero)` matters: without it, Task Scheduler stops the task after its default limit of three days. `-RestartCount` and `-RestartInterval` are Task Scheduler's own restart-on-failure, which retries the supervisor if the task itself fails. Crash restarts of the gateway are the supervisor loop's job, because it can tell a crash from a refusal by exit code.

Stop, start, or remove:

```powershell
Stop-ScheduledTask       -TaskName 'Ethos gateway'
Start-ScheduledTask      -TaskName 'Ethos gateway'
Unregister-ScheduledTask -TaskName 'Ethos gateway' -Confirm:$false
```

pm2 ([2C](#2c-cross-platform--pm2)) also runs on Windows. It needs a third-party package such as `pm2-windows-startup` to survive a reboot, because `pm2 startup` does not support Windows.

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

### Linger (headless Linux)

systemd user units are tied to login sessions. When the last session for a user closes — including SSH disconnects — systemd kills all user services by default. On a headless server with no GUI session, `ethos` stops as soon as you close SSH.

The fix is a one-time command:

```bash
sudo loginctl enable-linger $USER
```

This tells systemd to keep the user's service manager alive even with zero sessions. The user's services start at boot and survive logout.

To undo (e.g. when decommissioning):

```bash
sudo loginctl disable-linger $USER
```

Check the current state:

```bash
loginctl show-user $USER --property=Linger
```

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

**`Run ethos setup first` on boot.** — `HOME` does not point at your user account. systemd user units inherit it correctly; launchd sometimes does not. Set `HOME` in the plist `EnvironmentVariables` block as shown above.

**The unit is `failed` and systemd stopped restarting it.** — The gateway exits `78` when `~/.ethos/config.yaml` cannot be parsed or a bot binding points at nothing, and `3` when another gateway already holds this state directory. Both are refusals, not crashes, so `RestartPreventExitStatus=3 78` stops systemd retrying them. Run `ethos doctor` for a config error, or `ethos gateway status` for a held lock. Fix the cause, then run `systemctl --user restart ethos-gateway`. `StartLimitBurst=5` in `StartLimitIntervalSec=300` likewise gives up after five crashes in five minutes; `systemctl --user reset-failed ethos-gateway` clears it. A unit generated before these directives existed does not have them — regenerate it with `ethos systemd-unit ethos-gateway`.

**launchd keeps the job stopped after a config fix.** — The wrapper mapped exit `78` or `3` to `0`, so launchd treats the job as done. Run `ethos doctor` (exit `78`) or `ethos gateway status` (exit `3`), fix the cause, then `launchctl start ai.ethosagent.gateway`.

**The Windows task shows `Ready`, not `Running`.** — The supervisor exited. Read the last lines of `%USERPROFILE%\.ethos\logs\gateway.log`: exit `78` is a config error (`ethos doctor`), exit `3` is another gateway holding the state directory (`ethos gateway status`). Fix it, then run `Start-ScheduledTask -TaskName 'Ethos gateway'`. If the gateway keeps running after `Stop-ScheduledTask`, stop it by command line: `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -like '*gateway start*' | ForEach-Object { Stop-Process -Id $_.ProcessId }`.

**Telegram returns HTTP 429.** — Two gateway processes are polling the same bot token. Check for a duplicate launchd plist, a stale pm2 entry, or a forgotten `tmux` session. One process per bot token.

**Daemon stops on logout (Linux).** — Run `sudo loginctl enable-linger $USER` once. Without it, systemd tears down user units when the last login session ends.

**Memory grows unbounded.** — Check `pm2 monit` or `top -p $(pgrep -f "ethos gateway")`. If the resident set climbs steadily over hours, it's likely a leak — file an issue with a `node --inspect` heap snapshot. Short-term: pm2 supports `--max-memory-restart 500M` to recycle the process at a threshold.

**Logs missing on Linux.** — `StandardOutput=append:` requires systemd 240+; on older systems, drop those lines and use `journalctl --user -u ethos-gateway` instead.
