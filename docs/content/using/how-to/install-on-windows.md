---
title: Install Ethos on Windows
description: Run the PowerShell one-liner to install Ethos on Windows 10 or 11 — portable Node 24 bundled, no admin rights needed, no WSL required.
kind: how-to
audience: user
slug: install-on-windows
time: 10 min
updated: 2026-06-02
---

The installer downloads portable Node 24, installs dependencies, builds Ethos, and puts `ethos` on your User PATH — everything under `%LOCALAPPDATA%\ethos\`, no admin rights, no WSL, no pre-existing Node required.

## Task

Install the Ethos CLI natively on Windows 10 or 11.

## Result

- `ethos` and `ethos-update` available on User PATH (open a new terminal after install).
- Runtime files at `%LOCALAPPDATA%\ethos\` — disposable, reinstall any time.
- User data at `%USERPROFILE%\.ethos\` — preserved across reinstalls.

## Install

Open PowerShell or Windows Terminal and run:

```powershell
iex (irm https://raw.githubusercontent.com/ethosagent/ethos/main/scripts/install.ps1)
```

No admin prompt appears. The installer adds `%LOCALAPPDATA%\ethos\bin` to your **User** PATH (not Machine), so no elevation is needed.

To pass parameters, use the scriptblock form:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/ethosagent/ethos/main/scripts/install.ps1))) -SkipSetup -Branch main
```

### Installer parameters

| Parameter | Default | Purpose |
|---|---|---|
| `-Branch` | `main` | Branch to install from |
| `-Commit` | _(unset)_ | Pin to a specific commit SHA |
| `-Tag` | _(unset)_ | Pin to a release tag, e.g. `v0.4.6` |
| `-SkipSetup` | off | Skip the first-run setup wizard |
| `-EthosHome` | `%USERPROFILE%\.ethos` | Override the user data directory |
| `-InstallDir` | `%LOCALAPPDATA%\ethos\ethos-agent` | Override the code directory |
| `-NodeDir` | `%LOCALAPPDATA%\ethos\node` | Override where portable Node lives |
| `-BinDir` | `%LOCALAPPDATA%\ethos\bin` | Override the directory added to PATH |

### What the installer does

1. Downloads the latest portable Node 24 from nodejs.org into `%LOCALAPPDATA%\ethos\node` — queries the release index dynamically, no hardcoded version.
2. Installs pnpm using the portable npm (`npm install -g pnpm`).
3. Downloads the Ethos source as a ZIP archive from GitHub — no git required.
4. Runs `pnpm install` to fetch dependencies. Native modules (`better-sqlite3`) download prebuilt binaries for your Node version automatically.
5. Runs `pnpm build` to compile the TypeScript source. This takes 2–5 minutes on first install.
6. Writes `ethos.cmd` and `ethos-update.cmd` shims to `%LOCALAPPDATA%\ethos\bin`.
7. Adds the bin directory to your User PATH.
8. Runs `ethos setup` (the first-run wizard) unless `-SkipSetup` is passed.

## Verify

Open a **new** terminal window (the PATH change requires a new shell), then:

```powershell
ethos --version
```

Expected output (version number varies by release):

```
@ethosagent/cli 0.4.6
```

If `ethos: command not found`, the shell opened before the installer finished. Close it and open another one.

Confirm the setup wizard ran correctly:

```powershell
ethos chat
```

You should see the chat header with the active model and personality. Type `say hello` and verify a streamed reply appears.

## Directory layout

```
%LOCALAPPDATA%\ethos\
  node\           portable Node 24 — safe to delete, reinstall recreates it
  ethos-agent\    source + compiled output
  bin\
    ethos.cmd     — the CLI shim
    ethos-update.cmd  — re-runs the installer to update
%USERPROFILE%\.ethos\
  config.yaml     provider, model, API key, personality
  sessions.db     conversation history
  personalities\  custom personalities
```

`%LOCALAPPDATA%\ethos\` is disposable infrastructure. `%USERPROFILE%\.ethos\` is your data and is never touched by the installer.

## Update

Run this in any terminal:

```powershell
ethos-update
```

`ethos-update` re-runs the installer with `-SkipSetup` and preserves `node_modules` to speed up the dependency step. Your data in `%USERPROFILE%\.ethos\` is untouched.

To update to a specific version:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/ethosagent/ethos/main/scripts/install.ps1))) -SkipSetup -Tag v0.4.6
```

## Uninstall

```powershell
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\ethos"
# Remove the bin dir from User PATH manually in System Properties > Environment Variables
# Your data at %USERPROFILE%\.ethos\ is untouched — delete it separately if you want a clean slate
Remove-Item -Recurse -Force "$env:USERPROFILE\.ethos"
```

## Troubleshoot

**`ethos: command not found` after install.** Open a new terminal window. The installer added `%LOCALAPPDATA%\ethos\bin` to your User PATH, but existing shells don't pick up the change. If a new window still fails, check: `[Environment]::GetEnvironmentVariable('PATH', 'User')` should include the bin path.

**Build fails during install.** The `pnpm build` step compiles TypeScript and builds the web frontend — it needs network access to npm for any uncached packages. Retry the one-liner; it preserves `node_modules` on re-run so only the failed step repeats.

**`[scriptblock]::Create(...)` fails with a parse error.** Your download of `install.ps1` picked up a UTF-8 BOM. Use the plain `iex (irm ...)` form instead, which strips BOMs automatically.

**Node version conflict.** The installer places portable Node 24 at `%LOCALAPPDATA%\ethos\node`. The `ethos.cmd` shim hardcodes that path, so your system Node version is irrelevant — there is no conflict.

**Antivirus blocks the install.** Some AV products flag PowerShell scripts that download and execute code. Add `%LOCALAPPDATA%\ethos\` to your AV exclusion list, or run the installer from an elevated PowerShell window (admin is not required for the install itself, but some AV products require elevation to allow new executables).

## See also

- [Quickstart](../quickstart.md) — configure a provider and send your first message.
- [Configure providers](configure-providers.md) — switch between Anthropic, OpenRouter, Ollama, and Gemini.
- [Run as a daemon](run-as-daemon.md) — auto-start the gateway at Windows login via Scheduled Tasks.
- [Run in Docker](run-in-docker.md) — alternative install path using Docker Compose.
