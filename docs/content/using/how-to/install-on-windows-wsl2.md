---
title: Install Ethos on Windows (WSL2)
description: Run Ethos inside a WSL2 Linux environment on Windows — POSIX PTY, real file watchers, and the dashboard terminal pane that requires WSL2.
kind: how-to
audience: user
slug: install-on-windows-wsl2
time: 15 min
updated: 2026-06-02
---

WSL2 runs a real Linux kernel in a lightweight VM, so Ethos inside it behaves identically to an Ubuntu install. Pick this path when you want the dashboard's embedded terminal pane, real POSIX behaviour, or a shared Linux filesystem with your dev tools.

For the native Windows path (no VM, no Linux), see [Install on Windows](./install-on-windows.md).

## Task

Install Ethos inside a WSL2 Linux environment on Windows 10 or 11.

## Result

- `ethos` available inside the WSL2 shell.
- The web dashboard (including the `/chat` terminal pane) accessible from a Windows browser at `http://localhost:3000`.
- The gateway auto-starting via systemd when the WSL2 session opens.

## Prerequisites

- Windows 10 22H2 or Windows 11.
- An admin PowerShell window for the initial WSL install (one time only).
- An API key from Anthropic, OpenRouter, Ollama, or Gemini.

## 1. Install WSL2

From an **admin** PowerShell:

```powershell
wsl --install
```

Reboot when prompted. After reboot, Ubuntu opens and asks for a Linux username and password — this is a Linux-only user, unrelated to your Windows account.

Verify you are on WSL2 (not legacy WSL1):

```powershell
wsl --list --verbose
```

The VERSION column must show `2`. If it shows `1`, upgrade:

```powershell
wsl --set-version Ubuntu 2
wsl --set-default-version 2
```

Ethos does not run reliably on WSL1.

### Enable systemd (recommended)

Run this once inside your WSL2 shell to enable systemd and correct file metadata:

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true

[interop]
enabled=true
appendWindowsPath=true

[automount]
options = "metadata,umask=22,fmask=11"
EOF
```

Then from PowerShell:

```powershell
wsl --shutdown
```

Reopen your WSL terminal. `ps -p 1 -o comm=` should print `systemd`. The `metadata` mount option lets Linux permission bits work on `/mnt/c/` paths, which matters for executable scripts.

## 2. Install Ethos inside WSL2

Open your WSL2 terminal and run the standard Linux installer:

```bash
curl -fsSL https://ethosagent.ai/install.sh | bash
source ~/.bashrc
ethos --version
```

The installer treats WSL2 as plain Linux — nothing WSL-specific is needed.

## Verify

Confirm the CLI works:

```bash
ethos --version
```

Run the first-time setup:

```bash
ethos setup
```

Then open a session:

```bash
ethos chat
```

Type `say hello` and verify a streamed reply appears.

**Dashboard from Windows browser**: start the web server inside WSL2:

```bash
ethos serve --web
```

Open `http://localhost:3000` in a Windows browser. On Windows 11 22H2+ with default networking settings, localhost forwards automatically. On older builds, use the WSL2 VM's IP instead (`ip -4 addr show eth0 | grep inet`).

## Filesystem: where to put your files

WSL2 has two filesystems. Where you put files matters for performance and correctness.

| Location | Path inside WSL | When to use |
|---|---|---|
| Linux filesystem | `~/code/...` | Ethos data, git repos, venvs — everything Linux-ish |
| Windows filesystem | `/mnt/c/Users/...` | Files that Windows GUI apps must open |

Keep `~/.ethos/` and your projects on the Linux side. Operations on `/mnt/c/` cross a 9P network bridge and are 10–100x slower than native ext4. File watchers (`inotify`) across that bridge are unreliable.

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

## Troubleshoot

**`ethos: command not found` after install.** Run `source ~/.bashrc` in the current session, or open a new terminal. The installer adds `~/.local/bin` to PATH via `~/.bashrc`.

**Dashboard not reachable from Windows browser.** On NAT-mode WSL2 (Windows 10 or older Windows 11), bind the web server to `0.0.0.0`. If localhost forwarding is off, use the WSL VM's IP: `ip -4 addr show eth0 | grep inet`.

**"Connection refused" to Ollama or LM Studio on Windows.** The server is bound to `127.0.0.1` instead of `0.0.0.0`. Reconfigure the server to listen on all interfaces. Add a Windows Firewall inbound rule for the port if needed.

**Slow `git status` or `ethos chat` in a repo.** The repo is under `/mnt/c/`. Move it to `~/code/` on the Linux side.

**`bad interpreter: /bin/bash^M`.** CRLF line endings from a Windows editor. Run `dos2unix script.sh` and set `core.autocrlf input` in your WSL2 git config.

**Clock drift after sleep.** WSL2 can lag by minutes after the host resumes, breaking HTTPS and OAuth. Fix on demand: `sudo hwclock -s`.

**DNS fails after enabling mirrored mode or connecting a VPN.** Mirrored mode proxies Windows DNS into WSL. Override it: set `generateResolvConf=false` in `/etc/wsl.conf` and write `/etc/resolv.conf` manually with `nameserver 1.1.1.1`.

## See also

- [Install on Windows](./install-on-windows.md) — native PowerShell install, no VM or WSL needed.
- [Quickstart](../quickstart.md) — configure a provider and send your first message.
- [Configure providers](configure-providers.md) — point Ethos at Ollama, OpenRouter, or another provider.
- [Run as a daemon](run-as-daemon.md) — systemd and launchd alternatives.
