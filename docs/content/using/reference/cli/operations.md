---
title: "CLI: process, backup, import and data commands"
description: "ethos process, logs, mcp, backup, import and data commands."
kind: reference
audience: user
updated: 2026-11-03
---

## Synopsis {#synopsis}

Commands for operating an install and moving its data. Part of the [CLI reference](../cli.md).

## ethos process {#ethos-process}

Inspect and stop background processes started by the `process_*` tool family inside `ethos chat`. The subcommands drive the same registry helpers the tools use, so `list` / `logs` / `stop` produce the same output and lifecycle behaviour the agent sees — letting you watch or kill a process from a separate shell.

Synopsis: `ethos process [list [--json] | logs <id> [--lines N] [--stream stdout|stderr|both] | stop <id> [--signal SIGTERM|SIGKILL]]`

| Subcommand | Args / flags | Description |
|---|---|---|
| `list` *(default)* | `--json` | List every tracked process with PID, status, and duration. Runs a liveness check (marks dead `running` entries as `orphan`) and reaps stale terminal entries. `--json` emits the raw array instead of a table. |
| `logs <id>` | `--lines N`, `--stream stdout\|stderr\|both` | Print the last `N` lines (default `200`) of a process's logs. `--stream` selects which log; default `both` interleaves stdout then stderr. |
| `stop <id>` | `--signal SIGTERM\|SIGKILL` | Signal a running process. Default `SIGTERM` waits up to 5 s for a graceful exit, then escalates to `SIGKILL`. |

```bash
ethos process list
ethos process logs 6f6c1e2a-... --lines 50 --stream stderr
ethos process stop 6f6c1e2a-...
```

`logs` and `stop` exit `1` for an unknown id (`PROCESS_NOT_FOUND`). The `process_*` tool family it mirrors — `process_start`, `process_list`, `process_logs`, `process_stop`, `process_wait` — is documented in [`extensions/tools-process/README.md`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-process/README.md); it is gated by a personality's `toolset.yaml` like every other tool.

## ethos logs {#ethos-logs}

Inspect and bundle local diagnostics from `~/.ethos/logs/`.

Synopsis: `ethos logs [list | summary | note | bundle [--out <path>] [--lines <n>] | tail [--lines <n>] [--interval-ms <n>]]`

## ethos mcp {#ethos-mcp}

Expose Ethos to MCP-compatible clients (Claude Desktop, Cursor, OpenCode, Continue, Zed) over stdio.

Synopsis: `ethos mcp [serve | install --client <name> | init | doctor | inspect]`

Supported `--client` values: `claude-desktop`, `cursor`, `opencode`, `continue`, `zed`.

## ethos backup {#ethos-backup}

Snapshot `~/.ethos/` into a gzipped tar archive. With no path, writes `<ethosDir>/backups/ethos-backup-<timestamp>-<random>.tar.gz`. A path argument (or `--out`) names the archive file; its parent directory is created if missing.

Synopsis: `ethos backup [<path>] [--out <path>] [--scope identity,state,telemetry] [--bootstrap] [--json]`

| Flag | Type | Default | Description |
|---|---|---|---|
| `--out <path>` | path | `<ethosDir>/backups/ethos-backup-<timestamp>-<random>.tar.gz` | Where to write the archive. Takes precedence over a positional path. |
| `--scope <names>` | comma-separated list | `identity,state` | Which scopes to archive. `identity` — `config.yaml`, `mcp.json`, `MEMORY.md`, `USER.md`, `cron/jobs.json`, `personalities/`. `state` — the durable databases (`sessions.db`, `cards.db`, `memory.db`, `board.db`, `jobs.db`, `calls.db`, `goals.db`, `dashboards.db`, `pairing.db`, `a2a/tasks.db`) plus `skills/`, `teams/`, `users/`, `digests/`, `cron/output/` and the plugin pins. `telemetry` — `observability.db`, opt-in. |
| `--bootstrap` | boolean | off | Also print the two commands that rebuild this machine somewhere else. |
| `--json` | boolean | off | Emit one JSON document instead of the human report. |

Secrets are never archived: `secrets/`, `keys.json`, `web-token` and MCP OAuth token files are excluded, and the archive instead carries a `secrets.manifest.yaml` naming what a restore must refill. Delivery, dedup and notify-queue databases, `cache/`, `logs/`, `processes/`, `plugins/node_modules` and previous backups are excluded too.

A `state` archive contains conversation history. Treat it as sensitive as the machine it came from.

Exits `1` when another backup holds the `backups/.lock` sentinel, or when `--scope` names something outside `identity` / `state` / `telemetry`.

## ethos import {#ethos-import}

Restore an `ethos backup` archive into `~/.ethos/`. The whole archive is streamed and hashed against its manifest before anything is written; a truncated or tampered archive is refused with nothing changed.

Synopsis: `ethos import <archive> [--scope <names>] [--dry-run] [--force] [--secrets <file | - | prompt>] [--json]`

| Flag | Type | Default | Description |
|---|---|---|---|
| `--scope <names>` | comma-separated list | every scope the archive holds | Restore only these scopes. Same three values as `ethos backup`. |
| `--dry-run` | boolean | off | Verify the archive and report what would be restored. Writes nothing — including the exclusive database locks, so it cannot tell you whether a real restore would be refused as in-use. |
| `--force` | boolean | off | Skip the in-use check. Nothing then verifies that another process has these databases open. |
| `--secrets <source>` | path, `-`, or `prompt` | none | Refill the vault from a manifest file, from stdin, or by answering one question per missing secret. `prompt` cannot be combined with `--json`. |
| `--json` | boolean | off | Emit one JSON document instead of the human report. |

Before replacing any database, the restore takes an exclusive lock on the live file. Anything holding it — `ethos chat`, `serve`, `gateway`, the desktop app — makes the restore refuse with `IMPORT_BLOCKED` rather than write over a store in use. An `identity`-only restore touches no database and so needs no lock, but `config.yaml` and `mcp.json` are read at boot: the report says to restart.

Files the restore replaces are moved to `.pre-restore/<timestamp>/` rather than deleted.

Exits `1` on a corrupt archive, a locked database, an archive written by a newer format (`IMPORT_NEWER_SCHEMA`), or a `--secrets` payload that fails to inject. When secrets injection is the only failure, the restore itself has still completed — the report says which half landed.

There is no `--merge`. Use `--scope` to restore part of an archive.

## ethos retention {#ethos-retention}

Inspect and run retention sweeps for observability data.

Synopsis: `ethos retention [show | run [--dry-run]]`

## ethos data {#ethos-data}

Inspect local data stores (sessions, traces, blobs).

Synopsis: `ethos data [stats | sessions | traces]`

## ethos support {#ethos-support}

Generate a support bundle for issue triage.

Synopsis: `ethos support [bundle [--out <path>]]`

## ethos archive {#ethos-archive}

Manage long-term archive of sessions and memory.

Synopsis: `ethos archive [list | create | restore <id>]`

## See also {#see-also}

- [CLI reference](../cli.md): the index of every section and its page.
