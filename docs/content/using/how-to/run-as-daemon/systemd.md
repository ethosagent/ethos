---
title: "Run Ethos as a daemon: Linux systemd"
description: "Install a systemd user unit that keeps ethos gateway running on Linux."
kind: how-to
audience: user
time: "5 min"
updated: 2026-11-03
---

## Task

Run `ethos gateway start` as a systemd user unit that restarts after a crash and survives SSH logout.

## Result

`systemctl --user is-active ethos-gateway` prints `active` and the unit starts at boot.

## Prereqs

- Complete step 1 of [Run Ethos as a daemon](../run-as-daemon.md): the command works in the foreground and you have the absolute path from `which ethos`.
- systemd with user units (`systemctl --user status` works).

## Steps

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
Type=notify
ExecStart=/usr/bin/ethos gateway start
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=3 78
WatchdogSec=30
StandardOutput=append:%h/.ethos/logs/gateway.out.log
StandardError=append:%h/.ethos/logs/gateway.err.log
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

`Type=notify` holds `systemctl start` until the gateway has started its adapters and sent `READY=1` (`notifyReady` in `apps/ethos/src/sd-notify.ts`). `WatchdogSec=30` restarts a gateway whose event loop stops sending the keep-alive `startWatchdog` schedules at half that interval — the alive-but-wedged case a crash restart never sees.

Alternatively, generate the unit file automatically:

```bash
ethos systemd-unit ethos-gateway > ~/.config/systemd/user/ethos-gateway.service
```

This generates a production-ready unit with managed mode (`ETHOS_MANAGED=1`) and `EnvironmentFile` for secrets. See [CLI reference: systemd-unit](../../reference/cli.md#ethos-systemd-unit) for placeholders and customisation.

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

## Verify

Run `systemctl --user is-active ethos-gateway`; it prints `active` and exits 0. Send your bot a message; it replies within ten seconds.

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

## Troubleshoot

**The unit is `failed` and systemd stopped restarting it.** — The gateway exits `78` when `~/.ethos/config.yaml` cannot be parsed, a bot binding points at nothing, or the platform refused every bot's token, and `3` when another gateway already holds this state directory. Both are refusals, not crashes, so `RestartPreventExitStatus=3 78` stops systemd retrying them. Run `ethos doctor` for a config error, re-run `ethos setup messaging` for a refused token (the log says `failed permanently`), or run `ethos gateway status` for a held lock. Fix the cause, then run `systemctl --user restart ethos-gateway`. `StartLimitBurst=5` in `StartLimitIntervalSec=300` likewise gives up after five crashes in five minutes; `systemctl --user reset-failed ethos-gateway` clears it. A unit generated before these directives existed does not have them — regenerate it with `ethos systemd-unit ethos-gateway`.

**Daemon stops on logout (Linux).** — Run `sudo loginctl enable-linger $USER` once. Without it, systemd tears down user units when the last login session ends.

**Logs missing on Linux.** — `StandardOutput=append:` requires systemd 240+; on older systems, drop those lines and use `journalctl --user -u ethos-gateway` instead.
