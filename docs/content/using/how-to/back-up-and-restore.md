---
title: "Back up and restore an Ethos install"
description: "Take an ethos backup, restore it onto another machine in one command, and tune the backup.* schedule keys."
kind: how-to
audience: user
slug: back-up-and-restore
time: "10 min"
updated: 2026-11-03
---

## Task

Archive everything your agent has become — config, [personalities](../../getting-started/glossary.md#personality) (directories of files that decide an agent's tools, memory, and model), conversation history, skills, boards — and put it back on this machine or a different one.

## Result

- A single `.tar.gz` you can copy anywhere.
- A new machine running the same agent, with the same history, after one command.
- A nightly archive you did not have to set up, and know how to turn off.

## Prereqs

- Ethos installed (`ethos --version` prints a version).
- Nothing else using this Ethos home during a restore — no `ethos chat`, `serve`, `gateway`, or desktop app.

## Parts

| Part | Covers |
|---|---|
| This page | Steps 1-3: take a backup, pick scopes, the nightly job; vault memory |
| [Restore](back-up-and-restore/restore.md) | Steps 4-5: move to a new machine, restore onto a machine that already runs Ethos |

## Steps

### 1. Take a backup

```bash
ethos backup
```

```
✓ Backup written to: ~/.ethos/backups/ethos-backup-2026-09-05T01-29-39-07c50f1a.tar.gz
  10 file(s), 272.6 KB · scopes: identity, state

  The state scope carries conversation history (sessions, cards, memory).
  Treat it as sensitive as the machine it came from.

  API keys and MCP tokens were NOT archived. The archive lists what is
  missing in secrets.manifest.yaml — refill with `ethos import --secrets prompt`.
```

With no path, the archive lands in `~/.ethos/backups/`. Pass a path (or `--out`) to write it somewhere else.

Two things are deliberately not in it. Secrets — `secrets/`, `keys.json`, `web-token`, `web-admin.json`, `web-sessions.json`, MCP OAuth tokens — are excluded, and the archive carries a `secrets.manifest.yaml` naming what a restore has to refill. Machine-local queues — the delivery ledger, the inbound-dedup window, the notify queue — are excluded because replaying them on a second machine would resend real messages to real people.

`web-admin.json` and `web-sessions.json` — the web UI's password hash and browser sessions — are deliberately never archived. On a restored machine the web UI is unclaimed again: the token-holder claims it afresh at `/welcome`, and the web token keeps working for machine clients throughout.

A third thing is not in it under one setting: see [Vault memory is not archived](#vault-memory).

### 2. Pick the scopes you want

Three scopes exist. `ethos backup` takes `identity,state` when you name none.

| Scope | Holds | In the default |
|---|---|---|
| `identity` | `config.yaml`, `mcp.json`, `MEMORY.md`, `USER.md`, `cron/jobs.json`, `personalities/` | yes |
| `state` | `sessions.db`, `cards.db`, `memory.db`, `board.db`, `jobs.db`, `calls.db`, `goals.db`, `dashboards.db`, `pairing.db`, `a2a/tasks.db`, plus `skills/`, `teams/`, `users/`, `digests/`, `cron/output/` and plugin pins | yes |
| `telemetry` | `observability.db` — metrics and traces | no, opt in |

```bash
ethos backup --scope identity
```

```
✓ Backup written to: ~/.ethos/backups/ethos-backup-2026-09-05T01-29-40-bb48e62d.tar.gz
  6 file(s), 5.5 KB · scopes: identity
```

An `identity`-only archive is the small, portable one: no conversation history, so it is the one to hand to someone else who wants your personalities.

### 3. Know what the nightly job is already doing

`backup.enabled` defaults to on. A serving process — `ethos serve`, `ethos gateway start`, or `ethos boot` — seeds a `backup` cron job on start and writes an `identity,state` archive at 04:00 local, keeping the newest seven. On an install that predates this feature, that begins at the next start; nothing asks first.

To change it, set the keys in `~/.ethos/config.yaml`:

```yaml
backup.enabled: true
backup.cron: 0 4 * * *
backup.scope: identity,state
backup.keep: 7
backup.dir: /mnt/snapshots/ethos
```

Every key is optional and every one is reconciled on the next serving-process start: a changed `cron` reschedules the existing job, and `backup.enabled: false` removes it. The full field table is in the [`backup.*` config reference](../reference/config-yaml.md#backup).

`ethos chat` alone runs no cron. A laptop that only ever runs `ethos chat` takes no scheduled backups — run `ethos backup` yourself.

Steps 4 and 5, restoring the archive, are in [restore](back-up-and-restore/restore.md).

## Verify {#verify}

`ethos status` names the newest archive:

```bash
ethos status
```

```
✓ backups       last 2026-09-05 01:29 (0.3 MB, ethos-backup-2026-09-05T01-29-39-07c50f1a.tar.gz, 2 kept)
```

## Vault memory is not archived {#vault-memory}

Under [`memory: vault`](../reference/config-yaml.md#memory) the memory lives in your own directory, outside `~/.ethos` — and every scope in the table above is relative to `~/.ethos`. So no archive holds it, and each backup says so and names the two paths:

```
  ⚠ memory: vault — /Users/you/Documents/Vault/Ethos (memory content) and
    /Users/you/Documents/Vault/Ethos/.ethos-meta (provenance history) are outside
    the data directory and are NOT in this archive. Back that directory up yourself.
```

Back that directory up the way you back up the rest of that vault — Time Machine, `restic`, the sync client that already holds it. The same line appears in the scheduled run's output file (`<ethos home>/cron/output/backup/<ts>.md`, `~/.ethos` unless `ETHOS_STATE_DIR` is set) and as a skipped row in Settings › Backup.

What a restore still carries under `memory: vault`: `config.yaml` (so the restored machine points at the same vault path), the approval queue and its tombstones, and every database in the `state` scope. Point the restored deployment at a vault directory you have restored separately, then start it.

## Troubleshoot {#troubleshoot}

**`another backup is already in progress`** — the `backups/.lock` sentinel is held. The message names the holding process. If no backup is running, delete the lock file.

**Restore from the web dashboard says it will not do `state`** — that is the design. Settings › Backup creates archives, downloads them, and restores `identity` only: the server serving that page holds every database open, so a `state` restore could never pass the in-use check. Use the CLI with the server stopped.

## See also {#see-also}

- [`ethos backup` and `ethos import`](../reference/cli.md#ethos-backup) — every flag, and the exit codes.
- [`backup.*` config reference](../reference/config-yaml.md#backup) — the five schedule keys and their defaults.
- [Secrets resolver reference](../reference/secrets-resolver.md) — where the credentials a restore prompts for are stored.
- [Sessions and history](../explanation/sessions-and-history.md) — what is inside the `state` scope, and why it is sensitive.
- [How does memory work?](../explanation/memory-model.md) — where each backend keeps its files, and which of them a backup reaches.
- [Decommission an Ethos deployment](decommission-ethos-deployment.md) — the teardown side, when the answer is to delete rather than move.
