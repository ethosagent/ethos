---
title: "Install Ethos on Windows (WSL2): files, networking and the gateway"
description: "Where to keep files under WSL2, reach services across the VM boundary, run the gateway long-term and avoid CRLF problems."
kind: how-to
audience: user
time: "10 min"
updated: 2026-11-03
---

## Task

Configure an installed WSL2 Ethos so files, networking, the gateway and line endings behave.

## Result

`~/.ethos/` sits on the Linux filesystem, Windows-hosted model servers are reachable from WSL2, the gateway starts with the WSL2 session, and scripts keep LF line endings.

## Prereqs

- Complete [the install](../install-on-windows-wsl2.md): `ethos --version` works inside WSL2.
- For the gateway section: systemd enabled in WSL2 (`ps -p 1 -o comm=` prints `systemd`).

## Filesystem: where to put your files

WSL2 has two filesystems. Where you put files matters for performance and correctness.

| Location | Path inside WSL | When to use |
|---|---|---|
| Linux filesystem | `~/code/...` | Ethos data, git repos, venvs — everything Linux-ish |
| Windows filesystem | `/mnt/c/Users/...` | Files that Windows GUI apps must open |

Keep `~/.ethos/` and your projects on the Linux side. Operations on `/mnt/c/` cross a 9P network bridge and are 10–100x slower than native ext4. File watchers (`inotify`) across that bridge are unreliable.

:::warning Never put `~/.ethos/` on `/mnt/c/`
Ethos keeps its sessions, delivery ledger and inbound spool in SQLite databases under `~/.ethos/`. SQLite's file locking is not reliable over 9P, so a state directory on `/mnt/c/` (or set there with `ETHOS_STATE_DIR`) can corrupt those databases. The same applies to Docker Desktop bind mounts from a Windows path. `ethos doctor` warns under **Data directory** when the state directory sits on 9p, FUSE, NFS or SMB (`checkStateDirFilesystem` in [`apps/ethos/src/commands/doctor.ts`](https://github.com/ethosagent/ethos/blob/main/apps/ethos/src/commands/doctor.ts)).
:::

To open a WSL2 directory in Windows Explorer:

```bash
explorer.exe .
```

To convert paths between the two sides:

```bash
wslpath -w ~/code/project    # → \\wsl.localhost\Ubuntu\home\you\code\project
wslpath -u 'C:\Users\you'  # → /mnt/c/Users/you
```

## Networking: reaching services across the boundary

WSL2 runs in a VM with its own network stack. `localhost` inside WSL is not the same as `localhost` on Windows.

**Local models on Windows (Ollama, LM Studio)**: the server must bind to `0.0.0.0`, not `127.0.0.1`. For Ollama:

```powershell
$env:OLLAMA_HOST = "0.0.0.0"; ollama serve
```

Then in `~/.ethos/config.yaml`, set the base URL to the Windows host IP. Find it from WSL:

```bash
ip route show default | awk '{print $3}'
```

**Windows 11 22H2+ mirrored networking**: add to `%USERPROFILE%\.wslconfig` on the Windows side and restart WSL:

```ini
[wsl2]
networkingMode=mirrored
```

With mirrored mode, `localhost` works in both directions and the gateway is reachable from the Windows browser at `http://localhost:PORT` without extra configuration.

## Running the gateway long-term

With systemd enabled, use the built-in gateway management:

```bash
ethos gateway install
ethos gateway start
ethos gateway status
```

This installs a systemd user unit that starts the gateway when your WSL2 session opens.

To keep the WSL2 VM alive at Windows login (so the gateway keeps running without an open terminal), add a Scheduled Task from an admin PowerShell:

```powershell
schtasks /Create /SC ONLOGON /RL LIMITED /TN EthosWSL \
  /TR "wsl.exe -d Ubuntu --exec /bin/sh -c 'sleep infinity'"
```

This keeps the VM up so the systemd-managed gateway stays running after you close all terminal windows.

## Line endings

If you edit files on the Windows side with a Windows editor, they may get CRLF line endings. Set a safe git config inside WSL:

```bash
git config --global core.autocrlf input
git config --global core.eol lf
```

To fix existing files:

```bash
sudo apt install dos2unix
dos2unix path/to/script.sh
```

## Verify

```bash
ethos doctor
ethos gateway status
```

`ethos doctor` shows no warning under **Data directory**. `ethos gateway status` reports the gateway running once you have run `ethos gateway start`.

## Troubleshoot

**"Connection refused" to Ollama or LM Studio on Windows.** The server is bound to `127.0.0.1` instead of `0.0.0.0`. Reconfigure the server to listen on all interfaces. Add a Windows Firewall inbound rule for the port if needed.

**`ethos doctor` warns the state directory is on 9p.** `~/.ethos/` (or `ETHOS_STATE_DIR`) points under `/mnt/c/`. Stop Ethos, move the directory to the Linux side, and unset `ETHOS_STATE_DIR`.

**Slow `git status` or `ethos chat` in a repo.** The repo is under `/mnt/c/`. Move it to `~/code/` on the Linux side.

**`bad interpreter: /bin/bash^M`.** CRLF line endings from a Windows editor. Run `dos2unix script.sh` and set `core.autocrlf input` in your WSL2 git config.

**DNS fails after enabling mirrored mode or connecting a VPN.** Mirrored mode proxies Windows DNS into WSL. Override it: set `generateResolvConf=false` in `/etc/wsl.conf` and write `/etc/resolv.conf` manually with `nameserver 1.1.1.1`.

## See also

- [Install Ethos on Windows (WSL2)](../install-on-windows-wsl2.md) — the install steps and the rest of the troubleshooting.
- [Run as a daemon](../run-as-daemon.md) — systemd and launchd alternatives.
