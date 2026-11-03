---
title: "Run Ethos as a daemon: macOS launchd"
description: "Install a launchd LaunchAgent that keeps ethos gateway running on macOS."
kind: how-to
audience: user
time: "5 min"
updated: 2026-11-03
---

## Task

Run `ethos gateway start` under launchd as a LaunchAgent that starts at login and restarts after a crash.

## Result

The job appears in `launchctl list | grep ethosagent` and `~/.ethos/logs/gateway.out.log` shows gateway output.

## Prereqs

- Complete step 1 of [Run Ethos as a daemon](../run-as-daemon.md): the command works in the foreground and you have the absolute path from `which ethos`.
- A macOS user session (LaunchAgents run as you, not as root).

## Steps

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

launchd has no equivalent of systemd's `RestartPreventExitStatus`, so the `/bin/sh -c` wrapper does that job. The gateway exits `78` when `config.yaml` is invalid or every bot's credentials were refused, and `3` when another gateway already holds the state directory. Both are refusals that a restart cannot fix. The wrapper turns them into exit `0`, so launchd leaves the job stopped instead of respawning it forever. The reason stays in `gateway.err.log`.

`ThrottleInterval` is the minimum gap, in seconds, between two launches of the job. launchd's default is 10. A value of 30 caps a crash loop at two starts a minute, which keeps a failing provider or platform from being hammered.

## Verify

Run `launchctl list | grep ai.ethosagent`; it prints a non-empty line. Send your bot a message; it replies within ten seconds.

## Troubleshoot

**`Run ethos setup first` on boot.** — `HOME` does not point at your user account. systemd user units inherit it correctly; launchd sometimes does not. Set `HOME` in the plist `EnvironmentVariables` block as shown above.

**launchd keeps the job stopped after a config fix.** — The wrapper mapped exit `78` or `3` to `0`, so launchd treats the job as done. Run `ethos doctor` (exit `78`) or `ethos gateway status` (exit `3`), fix the cause, then `launchctl start ai.ethosagent.gateway`.
