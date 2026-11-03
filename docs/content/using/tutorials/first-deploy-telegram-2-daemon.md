---
title: "Deploy your first Telegram agent, part 2: wrap the bot in a daemon"
description: "Run the Telegram bot as a launchd or systemd daemon."
kind: tutorial
audience: user
updated: 2026-11-03
---

## Goal

Finish step 6 of [Deploy your first Telegram agent](first-deploy-telegram.md): Wrap it in a daemon.

## Prereqs

- Complete [part 1 of 3](first-deploy-telegram.md).

## 6. Wrap it in a daemon

Foreground works. Time to keep it running. Pick the manager that matches your platform.

### macOS — `launchd`

`launchd` ships with macOS. Unit files (plists) live in `~/Library/LaunchAgents/`. Find your `ethos` binary and your home directory first:

```bash
which ethos
echo $HOME
```

Common cases:

- Installed via the recommended script with `nvm` — `~/.nvm/versions/node/v24.x.x/bin/ethos`.
- Installed via system `npm` — `/usr/local/bin/ethos` or `/opt/homebrew/bin/ethos`.

`launchd` runs without your shell's `PATH`, so use the absolute path you printed. The same applies to `HOME` — set it explicitly.

Create `~/Library/LaunchAgents/ai.ethosagent.gateway.plist`:

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
    <string>/Users/YOU/.nvm/versions/node/v24.0.0/bin/ethos</string>
    <string>gateway</string>
    <string>start</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/Users/YOU/.nvm/versions/node/v24.0.0/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>/Users/YOU</string>
  </dict>

  <key>WorkingDirectory</key>
  <string>/Users/YOU</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/Users/YOU/.ethos/logs/gateway.out.log</string>

  <key>StandardErrorPath</key>
  <string>/Users/YOU/.ethos/logs/gateway.err.log</string>
</dict>
</plist>
```

Replace `YOU` with the output of `whoami`. Load and start:

```bash
launchctl load ~/Library/LaunchAgents/ai.ethosagent.gateway.plist
launchctl start ai.ethosagent.gateway
```

Tail the logs to confirm it boots:

```bash
tail -f ~/.ethos/logs/gateway.out.log
```

You should see the same `✓ Telegram online` line you saw in the foreground. DM the bot to confirm.

To stop, reload after editing, or remove:

```bash
launchctl stop ai.ethosagent.gateway
launchctl unload ~/Library/LaunchAgents/ai.ethosagent.gateway.plist
launchctl load ~/Library/LaunchAgents/ai.ethosagent.gateway.plist
```

`RunAtLoad` plus the file's location in `~/Library/LaunchAgents/` is enough to start the gateway on login. `KeepAlive` restarts it on crash.

### Linux — `systemd` user unit

`systemd` user units live in `~/.config/systemd/user/`. They run as your login user, not root — appropriate for a personal bot. Find the binary first:

```bash
which ethos
```

Create `~/.config/systemd/user/ethos-gateway.service`:

```ini
[Unit]
Description=Ethos gateway (Telegram)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/home/YOU/.nvm/versions/node/v24.0.0/bin/ethos gateway start
Restart=on-failure
RestartSec=5
StandardOutput=append:%h/.ethos/logs/gateway.out.log
StandardError=append:%h/.ethos/logs/gateway.err.log
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

Replace the `ExecStart` path with the output of `which ethos` (it must be absolute — `systemd` does not source your shell rc, so bare `ethos` does not resolve).

Enable, start, status:

```bash
systemctl --user daemon-reload
systemctl --user enable --now ethos-gateway.service
systemctl --user status ethos-gateway
```

Watch logs live:

```bash
journalctl --user -u ethos-gateway -f
```

For a server you SSH into, user units stop when your login session ends by default. Make them persist:

```bash
sudo loginctl enable-linger $USER
```

Restart, stop, disable:

```bash
systemctl --user restart ethos-gateway
systemctl --user stop ethos-gateway
systemctl --user disable ethos-gateway
```

For more daemon options — `pm2`, Docker, plain `nohup` — see [Run Ethos as a daemon](../how-to/run-as-daemon.md). `launchd` and `systemd` are enough for one bot.

## What you learned

- Step 6 done: Wrap it in a daemon.

## Next step

Continue with [part 3 of 3: send the first message and operate it](first-deploy-telegram-3-operate.md).
