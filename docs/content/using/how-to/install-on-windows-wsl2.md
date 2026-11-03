---
title: Install Ethos on Windows (WSL2)
description: Run Ethos inside a WSL2 Linux environment on Windows — POSIX PTY, real file watchers, and the dashboard terminal pane that requires WSL2.
kind: how-to
audience: user
slug: install-on-windows-wsl2
time: 15 min
updated: 2026-11-03
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

## Parts

| Part | Covers |
|---|---|
| This page | Install WSL2, enable systemd, install Ethos, verify |
| [Files, networking and the gateway](install-on-windows-wsl2/files-networking-gateway.md) | Where to keep files, reaching services across the VM boundary, running the gateway long-term, line endings |

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

Filesystem placement, networking, running the gateway long-term and line endings continue in [files, networking and the gateway](install-on-windows-wsl2/files-networking-gateway.md).

## Troubleshoot

**`ethos: command not found` after install.** Run `source ~/.bashrc` in the current session, or open a new terminal. The installer adds `~/.local/bin` to PATH via `~/.bashrc`.

**Dashboard not reachable from Windows browser.** On NAT-mode WSL2 (Windows 10 or older Windows 11), bind the web server to `0.0.0.0`. If localhost forwarding is off, use the WSL VM's IP: `ip -4 addr show eth0 | grep inet`.

**Clock drift after sleep.** WSL2 can lag by minutes after the host resumes, breaking HTTPS and OAuth. Fix on demand: `sudo hwclock -s`.

## See also

- [Install on Windows](./install-on-windows.md) — native PowerShell install, no VM or WSL needed.
- [Quickstart](../quickstart.md) — configure a provider and send your first message.
- [Configure providers](configure-providers.md) — point Ethos at Ollama, OpenRouter, or another provider.
- [Run as a daemon](run-as-daemon.md) — systemd and launchd alternatives.
