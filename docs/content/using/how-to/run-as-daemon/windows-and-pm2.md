---
title: "Run Ethos as a daemon: pm2 and Windows"
description: "Run ethos gateway under pm2 on any OS, or Task Scheduler on Windows."
kind: how-to
audience: user
time: "5 min"
updated: 2026-11-03
---

## Task

Run `ethos gateway start` under pm2 (macOS, Linux, Windows) or under a PowerShell supervisor started by Windows Task Scheduler.

## Result

pm2 lists `ethos-gateway` as online, or `(Get-ScheduledTask -TaskName 'Ethos gateway').State` prints `Running`.

## Prereqs

- Complete step 1 of [Run Ethos as a daemon](../run-as-daemon.md): the command works in the foreground and you have the absolute path from `which ethos`.
- For pm2: Node and npm. For Task Scheduler: Windows PowerShell and an installed `ethos.cmd`.

## Steps

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

Running gateway + serve together as one supervised unit? Don't list them as separate PM2 apps — use [Deploy in production](../deploy-in-production.md), which wraps `ethos run-all` as a single PM2 process that spawns and watches both children. That gives you in-process restart-on-crash AND PM2's reboot survival without the double-supervision footgun.

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
  # 0 = clean stop; 3 = another gateway holds the state dir; 78 = invalid config or refused tokens.
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

## Verify

Run `pm2 jlist | jq '.[] | .name'`; the output includes `"ethos-gateway"`. On Windows Task Scheduler, `(Get-ScheduledTask -TaskName 'Ethos gateway').State` prints `Running`.

## Troubleshoot

**The Windows task shows `Ready`, not `Running`.** — The supervisor exited. Read the last lines of `%USERPROFILE%\.ethos\logs\gateway.log`: exit `78` is a config error or refused bot tokens (`ethos doctor`, `ethos setup messaging`), exit `3` is another gateway holding the state directory (`ethos gateway status`). Fix it, then run `Start-ScheduledTask -TaskName 'Ethos gateway'`. If the gateway keeps running after `Stop-ScheduledTask`, stop it by command line: `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -like '*gateway start*' | ForEach-Object { Stop-Process -Id $_.ProcessId }`.

**Memory grows unbounded.** — Check `pm2 monit` or `top -p $(pgrep -f "ethos gateway")`. If the resident set climbs steadily over hours, it's likely a leak — file an issue with a `node --inspect` heap snapshot. Short-term: pm2 supports `--max-memory-restart 500M` to recycle the process at a threshold.
