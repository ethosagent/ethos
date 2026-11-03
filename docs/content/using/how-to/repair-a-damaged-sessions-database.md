---
title: "Repair a damaged sessions database"
description: "Check sessions.db for a damaged search index, rebuild it with ethos sessions repair, and restore from a backup when table data is damaged."
kind: how-to
audience: user
slug: repair-sessions-database
time: "10 min"
updated: 2026-11-03
---

## Task

Find out whether `~/.ethos/sessions.db` (the SQLite file holding every [session](../../getting-started/glossary.md#session) and message) is damaged, and repair it without losing history.

## Result

- Search works again and new messages save, after a rebuild of the damaged index.
- A verbatim copy of the old file sits in `~/.ethos/.pre-repair/<timestamp>/sessions.db`.
- If the damage is in the table data itself, you know to restore from a backup instead.

## Prereqs

- Ethos installed, with a `~/.ethos/sessions.db` (created by your first chat).
- For `--apply` only: stop everything that has the file open. That means `ethos gateway`, `ethos serve`, `ethos boot`, `ethos chat`, the desktop app, and any `ethos run-all` supervisor (it restarts a stopped gateway within seconds).

## Steps

### 1. Check without changing anything

```bash
ethos sessions repair
```

```
sessions.db  /home/you/.ethos/sessions.db  (112.0 KB)
  integrity_check          FAILED  fts5: corruption found reading blob 2336462209025 from table "messages_fts"
  FTS drift (docsize)      unindexed 0 · dangling 0
  malformed rows           none
Class: fts  (the messages table is intact; the search index is not)
Effect: Search is down and new messages cannot be saved or pruned until the index is rebuilt.
Plan:   rebuild messages_fts, after a verbatim copy to /home/you/.ethos/.pre-repair/<...>/
Run:    ethos sessions repair --apply
```

Check mode opens the file read-only, takes no lock, and runs while Ethos is up. It exits `0` when healthy and `1` when it finds a problem. `ethos doctor` runs the same integrity check and prints the same class.

If the output ends with `✓ sessions.db is healthy.`, stop here. A healthy file with a slow or empty search is not this problem.

### 2. Read the class

| Class | What is damaged | What `--apply` does |
|---|---|---|
| `fts` | The full-text search index (`messages_fts`). The `messages` table is intact. | Rebuilds the index from `messages`. |
| `index` | A table index. The data pages are intact. | Runs `REINDEX`. |
| `heap` | Table data pages. Rows may be unreadable. | Refuses with `DB_CORRUPT`. Go to [step 5](#restore). |
| `unknown` | A verdict that matches no repairable pattern. | Refuses with `DB_CORRUPT`. Go to [step 5](#restore). |

### 3. Optional: run the deep check

```bash
ethos sessions repair --deep
```

```
  FTS deep check           FAILED  fts5: corruption found reading blob 2336462209025 from table "messages_fts"
```

`--deep` runs FTS5's authoritative `rank=1` consistency check on a temporary copy, so the live file is still untouched. It finds index drift that the default check misses, at the cost of copying the file. The default check reports drift as `unindexed` (messages missing from the index) and `dangling` (index entries with no message); drift alone does not change the exit code of `ethos doctor`.

### 4. Apply the repair

Stop the processes listed under Prereqs, then run:

```bash
ethos sessions repair --apply
```

The command prints the report, asks `Repair sessions.db now? A verbatim copy is taken first. [y/N]`, and on `y` does this in order:

1. Takes an exclusive lock on the file. If another process has it open, the command refuses (see Troubleshoot).
2. Copies `sessions.db` byte for byte into `~/.ethos/.pre-repair/<timestamp>/`.
3. Rebuilds the index, runs `REINDEX`, or both, as the plan says.
4. Re-runs the integrity check and the drift check.

```
✓ Repaired (rebuild_fts) and verified in 9 ms.
  Pre-repair copy (verbatim): /home/you/.ethos/.pre-repair/2026-11-03T13-57-18-999Z-YeEXSE/sessions.db
```

Add `--yes` (or `-y`) to skip the prompt. Add `--json` for one machine-readable report; `--json --apply` requires `--yes`, because it cannot prompt. Refusals under `--json` print one `{"ok":false,"error":{"code","message"}}` document and exit `1`. Answering `N` at the prompt exits `1`, since the file is still damaged.

If the last step does not verify clean, the command prints `✗ Repair ran but sessions.db did not verify clean` and exits `1`. Keep the pre-repair copy and go to step 5.

### 5. Restore from a backup {#restore}

If the class is `heap` or `unknown`, or verification failed, `--apply` cannot help:

```
✗ DB_CORRUPT: sessions.db is damaged beyond what this tool repairs (heap): ...
  restore from a backup: ethos import <archive>
```

Stop Ethos, then restore the `state` scope from your latest archive:

```bash
ethos import <archive> --scope state
```

The restore moves the files it replaces into `~/.ethos/.pre-restore/<timestamp>/`. See [`ethos import`](../reference/cli/operations.md#ethos-import) for the flags. Messages written after that archive are not in it; the `.pre-repair` copy, if you have one, still holds them and `sqlite3` can read what is readable.

## Verify

```bash
ethos sessions repair
```

```
  integrity_check          ok
  FTS drift (docsize)      unindexed 0 · dangling 0
  malformed rows           none
✓ sessions.db is healthy.
```

Then run `ethos sessions search <word>`. It returns hits instead of an error.

## Troubleshoot

| Symptom | Cause | Fix |
|---|---|---|
| `DB_BUSY: sessions.db is in use by another process, so it cannot be repaired` | A process has the file open. The message lists them by name and pid, plus a gateway pid if one holds the state dir. | Stop each listed process and retry. Stop an `ethos run-all` supervisor too, and any systemd or PM2 unit that runs the gateway. |
| `DB_BUSY: sessions.db is locked by another process (waited ...)` during normal use | A long write (a `VACUUM`, `ethos data recompute-costs`) held the lock past the busy timeout. The message names the holders. | Wait for the operation, or stop the process named, and retry. |
| `malformed rows  metadata 2 · timestamps 1` | A few rows have invalid JSON or a bad timestamp. | Nothing to repair. Reads show those rows with the bad field dropped; the command counts them but never rewrites them. |
| `IMPORT_NEWER_SCHEMA` | The file was written by a newer Ethos. | Upgrade Ethos, then retry. Repair never downgrades a database. |
| The `.pre-repair` directory keeps growing | Each `--apply` adds a full copy. | Delete old timestamp directories once you have confirmed the repair. |

## See also

- [Back up and restore an Ethos install](back-up-and-restore.md): the archive that `ethos import` restores from.
- [`ethos sessions`](../reference/cli/operations.md#ethos-sessions): every flag and exit code.
- [Error reference](../../troubleshooting/error-reference.md): `DB_BUSY` and `DB_CORRUPT`.
- [Sessions and history](../explanation/sessions-and-history.md): what the file holds.
