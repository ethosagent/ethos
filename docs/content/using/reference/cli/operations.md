---
title: "CLI: process, backup, import and data commands"
description: "ethos process, logs, mcp, catalog, backup, import and data commands."
kind: reference
audience: user
updated: 2026-11-05
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

## ethos catalog {#ethos-catalog}

Browse the reviewed catalog of MCP servers, plugins and skills that ships with Ethos, and install an entry from it. `list`, `search` and `show` are read-only. `install` and `grant` write, and `install` never grants anything: no personality's `mcp_servers`, `plugins` or `skills` changes until you run the grant command it prints.

Synopsis: `ethos catalog [list | search <query> | show <id>] [--kind mcp|plugin|skill] [--json]`
Synopsis: `ethos catalog install <id> [--arg K=V ...] [--env K=V ...] [-y] [--json]`
Synopsis: `ethos catalog grant <id> --personality <pid> [--json]`

| Subcommand | Description |
|---|---|
| `list` | One line per entry: `id  kind  tier  description`. |
| `search <query>` | Case-insensitive match over id, name, description and publisher. |
| `show <id>` | The full entry (pin, capabilities, licence), the `ethos catalog install` command, the by-hand command it runs, and the grant command for the kind. |
| `install <id>` | Install the entry by kind (table below). Prints the grant command and does not run it. |
| `grant <id> --personality <pid>` | Skills only. Adds `catalog/<id>` to that personality's `skills.global_ingest.allow`. A built-in personality is refused. |

`--json` prints the entries (or the one entry) as a single JSON document. An unknown id prints `Unknown catalog entry: <id>` and up to three nearby ids to stderr, and exits `1`.

What `install` does for each kind:

| Entry | What runs | Grant command it prints |
|---|---|---|
| MCP, remote, no auth | Registers the URL in `mcp.json`, as the web "Add" button does. | `ethos personality mcp <personality-id> --attach <id>` |
| MCP, remote, OAuth | `ethos mcp add <id> --url <url>`, which signs you in. | `ethos personality mcp <personality-id> --attach <id>` |
| MCP, local | `ethos mcp add <id> --preset <id>` with your `--arg` and `--env` values. The package is pinned to an exact version. | `ethos personality mcp <personality-id> --attach <id>` |
| Plugin | The `ethos plugin install` flow for `package@version`. The downloaded tarball must match the catalog's pinned sha512 or the install is blocked before the consent prompt. `-y` records the capability grant without asking. | `ethos personality plugins <personality-id> --attach <plugin-id>` |
| Skill | Fetches the pinned git commit, refuses it unless its content digest matches, and installs it under `<state dir>/catalog-skills/<id>/`. `SKILL.md` and every JS/TS source file must scan with no red and no yellow finding. Other files (reference `.md` files, data, scripts in other languages) are digest-pinned and human-reviewed at admission, not scanned. | `ethos catalog grant <id> --personality <personality-id>` |

With `--json`, `install` reports failures as one JSON error document, never prompts, and a plugin install then needs `-y`.

`--arg` and `--env` apply to local MCP entries only, and only for the names `ethos catalog show <id>` lists.

A catalog skill is invisible to every personality until it is granted, whatever the personality's `skills.global_ingest.mode` says. Plugin code can still run when Ethos starts, for every personality, whether or not it is granted: the grant decides what a turn sees. A `community` catalog plugin runs in the plugin host process; a `verified` or `official` one runs where `plugins.isolation` says, which is in-process by default.

Catalog entries that fail a check exit `1` and leave nothing installed. For the web API's error codes, see [Error reference](../../../troubleshooting/error-reference.md).

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

## ethos sessions {#ethos-sessions}

List, search and manage stored [sessions](../../../getting-started/glossary.md#session), and repair a damaged `sessions.db`.

Synopsis: `ethos sessions [list | show | rename | delete | search | repair]`

`ethos sessions repair [--deep] [--apply] [--yes] [--json]` checks `~/.ethos/sessions.db` and, with `--apply`, repairs a damaged search index or table index. Walkthrough: [Repair a damaged sessions database](../../how-to/repair-a-damaged-sessions-database.md).

| Flag | Type | Default | Description |
|---|---|---|---|
| `--deep` | boolean | off | Also run FTS5's `rank=1` consistency check on a temporary copy. The live file is untouched. |
| `--apply` | boolean | off | Repair. Without it the command is read-only: no lock, no write. |
| `--yes`, `-y` | boolean | off | Skip the `[y/N]` prompt. Required with `--json --apply`. |
| `--json` | boolean | off | Emit one report as JSON instead of the human text. |

| Class | Meaning | `--apply` action |
|---|---|---|
| `ok` | Integrity check passes. | None. |
| `fts` | The search index is damaged; `messages` is intact. | Rebuild `messages_fts`. |
| `index` | A table index is damaged. | `REINDEX`. |
| `heap` | Table data pages are damaged. | Refuses with `DB_CORRUPT`; restore with `ethos import <archive>`. |
| `unknown` | The verdict matches no repairable pattern. | Refuses with `DB_CORRUPT`. |

`--apply` takes an exclusive lock on the file and refuses with `DB_BUSY`, naming the processes that have it open, if any process does. It then copies the file verbatim to `~/.ethos/.pre-repair/<timestamp>/sessions.db`, repairs, and re-verifies. Check mode exits `0` when healthy and `1` on any finding; `--apply` exits `0` only when verification passes (answering `N` at the prompt exits `1`, because the file is still damaged; a file with nothing to repair exits `0`). With `--json`, a refusal (bad flag, `--apply` without `--yes`, an unrepairable file, `DB_BUSY`) prints `{"ok":false,"error":{"code":"...","message":"..."}}` and exits `1`. Rows with malformed JSON or timestamps are counted as `malformed rows` but never rewritten. `ethos doctor` reports the same class and points to this command. Source: [`apps/ethos/src/commands/sessions-repair.ts`](https://github.com/ethosagent/ethos/blob/main/apps/ethos/src/commands/sessions-repair.ts).

```bash
ethos sessions repair --deep
ethos sessions repair --apply --yes --json
```

## ethos support {#ethos-support}

Generate a support bundle for issue triage.

Synopsis: `ethos support [bundle [--out <path>]]`

## ethos archive {#ethos-archive}

Manage long-term archive of sessions and memory.

Synopsis: `ethos archive [list | create | restore <id>]`

## See also {#see-also}

- [CLI reference](../cli.md): the index of every section and its page.
