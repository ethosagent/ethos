---
title: "config.yaml: logs, backup and trust keys"
description: "config.yaml log rotation, backup and trust keys."
kind: reference
audience: user
updated: 2026-11-03
---

## Synopsis {#synopsis}

Keys for operating a long-running install. Part of the [config.yaml reference](../config-yaml.md).

## logs.rotation {#logs-rotation}

Type: object · Default: `{ maxBytes: 10485760, maxFiles: 5, enabled: true }`

Controls rotation of `~/.ethos/logs/errors.jsonl`. When the file exceeds `maxBytes`, it is renamed to `errors.jsonl.1` and older backups shift up to `maxFiles`.

| Key | Type | Default | Description |
|---|---|---|---|
| `logs.rotation.maxBytes` | integer | `10485760` (10 MiB) | Maximum file size before rotation. Must be a positive integer. |
| `logs.rotation.maxFiles` | integer | `5` | Maximum number of rotated backup files. Must be a positive integer. |
| `logs.rotation.enabled` | boolean | `true` | Set to `false` to disable rotation entirely. |

```yaml
logs.rotation.maxBytes: 20971520
logs.rotation.maxFiles: 10
logs.rotation.enabled: true
```

## mcp.discoveryConcurrency {#mcp-discovery-concurrency}

Type: integer, `1`–`16` · Default: `4`

How many MCP servers Ethos connects to at once while it discovers their tools. Each `McpManager` applies the cap on its own. A slot is released when a server connects, fails, or reaches its connect timeout, so one server that hangs cannot hold a slot for long. Lower it on a machine that struggles when many stdio servers start together.

```yaml
mcp.discoveryConcurrency: 8
```

Notes:

- A value that is not an integer from `1` to `16` is dropped with a warning naming the key, and the default applies.
- A change takes effect on restart.

## backup.* {#backup}

Scheduled local snapshots of `~/.ethos/`. On by default: a serving process (`ethos serve`, `ethos gateway start`, `ethos boot`) seeds a `backup` cron job at first start and writes an `identity,state` archive at 04:00 local every night, keeping the newest seven. Nothing here uploads anywhere — the archive stays on this machine.

| Field | Type | Default | Description |
|---|---|---|---|
| `backup.enabled` | boolean | `true` | Set to `false` to remove the scheduled job. Any value other than the literal `true` reads as `false`; the job is created, rescheduled, or removed to match on every serving-process start. |
| `backup.cron` | cron expression | `0 4 * * *` | When the scheduled backup fires, in the host's local time. Editing it patches the existing job rather than creating a second one. |
| `backup.scope` | comma-separated list | `identity,state` | Which scopes the scheduled run archives. Values: `identity` — config, `mcp.json`, `MEMORY.md`, `USER.md`, `cron/jobs.json`, `personalities/`; `state` — the durable databases plus `skills/`, `teams/`, `users/`, `digests/`, `cron/output/` and plugin pins; `telemetry` — `observability.db`, opt-in. An unknown name fails that backup run, naming it, and leaves the other system jobs alone. |
| `backup.keep` | integer ≥ 1 | `7` | How many scheduled archives survive rotation, oldest deleted first. A non-integer or `0` is a config parse error. Rotation only ever deletes files named `ethos-scheduled-<timestamp>.tar.gz` — a manual `ethos backup` archive parked in the same directory is never swept up. |
| `backup.dir` | path | `<ethosDir>/backups` | Where archives are written and rotated. A relative value resolves under the data directory, not the process working directory. |

```yaml
backup.enabled: true
backup.cron: 0 4 * * *
backup.scope: identity,state
backup.keep: 7
backup.dir: /mnt/snapshots/ethos
```

Notes:

- `${ETHOS_HOME}` is not a token this file expands. The `<ethosDir>/backups` default is computed in code by `backupDirectory` in [`packages/wiring/src/backup-schedule.ts`](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/backup-schedule.ts); write a literal path if you want one.
- The schedule only fires while a serving process is running. `ethos chat` alone runs no cron.
- A `state` archive holds conversation history — sessions, session cards, memory. Treat the backup directory as sensitive as `~/.ethos/` itself.
- Secrets are never archived. `secrets/`, `keys.json`, `web-token`, `web-admin.json`, `web-sessions.json` and MCP OAuth token files are excluded; the archive lists what is missing so a restore can prompt for it.
- See [Back up and restore an Ethos install](../../how-to/back-up-and-restore.md) for these keys in practice, and [`ethos backup`](../cli.md#ethos-backup) for the manual command.

## security.trusted_github_orgs {#security-trusted-github-orgs}

Type: comma-separated list · Default: `ethosagent, anthropic`

The GitHub organizations whose skills and plugins install at the `trusted-repo` trust tier. Everything else on `github.com` installs at `community`. The value **replaces** the default list rather than extending it, so removing an organization you do not trust — including either shipped default — is expressible. Matching is exact on the organization path segment; `github.com/ethosagent-evil/x` does not match `ethosagent`, and any path containing `.` or `..` is refused outright.

```yaml
security.trusted_github_orgs: acme-corp, ethosagent
```

An explicitly empty value trusts no organization. It is a real setting, not the same as leaving the key out — an absent key keeps the shipped default in force.

```yaml
security.trusted_github_orgs: ""
```

Notes:

- `trusted-repo` lets an operator force past a red scanner finding with `--force`. It does **not** silently accept yellow findings — only `builtin` (code shipped inside Ethos itself) does that. Adding an organization here grants an override lever, not a scan bypass.
- Organization names are case-sensitive here. Write the organization exactly as it appears in the `github.com/<org>/<repo>` path.
- The list is read at the composition root and passed into the scanner. Defined in [`packages/safety/scanner/src/trust-tiers.ts`](https://github.com/ethosagent/ethos/blob/main/packages/safety/scanner/src/trust-tiers.ts).

## goals.allowCheckCommands {#goals-allow-check-commands}

Type: boolean · Default: `false`

Allows a goal created from the web UI or API to carry a check with a verify command. When the goal is judged, the command runs as the goal's personality would run a `terminal` call, and the check passes if it exits `0` (`createAcceptanceCheckExecutor`, [`packages/wiring/src/acceptance-check-executor.ts`](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/acceptance-check-executor.ts)).

```yaml
goals.allowCheckCommands: true
```

With the key off, a create request whose checks carry a non-empty command is refused whole with `FORBIDDEN`. The command is never dropped silently (`GoalsService.create`, [`apps/web-api/src/services/goals.service.ts`](https://github.com/ethosagent/ethos/blob/main/apps/web-api/src/services/goals.service.ts)). The goal form shows a **Verify command** field on each check only while the key is `true`.

Notes:

- **The command runs wherever that personality's shell runs.** It is refused when the personality does not hold `terminal`, when a `safety.denyRules` entry matches, or when the approval check would flag it (a judge pass has nobody to approve, so a flagged command fails the check). Under a host-local execution posture `terminal` is always flagged, so a local personality's verify commands never run on the host. Anyone who can create a goal through the web UI or API can still run commands inside the personality's sandbox. Enable this key only when every such person is trusted with that personality's shell.
- Commands time out after 30 seconds.
- The key is read on every create, so a change takes effect without a restart. Any value other than the literal `true` reads as `false`.
- The goal detail page shows each check's command, so you can see what a goal will run.

## See also {#see-also}

- [config.yaml reference](../config-yaml.md): the index of every section and its page.
