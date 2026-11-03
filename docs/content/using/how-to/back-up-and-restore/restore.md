---
title: "Back up and restore an Ethos install: restore"
description: "Restore an ethos backup onto a new machine in one command, or onto a machine that already runs Ethos."
kind: how-to
audience: user
time: "10 min"
updated: 2026-11-03
---

## Task

Restore an `ethos backup` archive onto a new machine, or onto one that already runs Ethos.

## Result

The agent runs on the target machine with the archived config, personalities and history, and `ethos doctor` reports the stores intact.

## Prereqs

- An archive from [steps 1-3](../back-up-and-restore.md), copied to the target machine.
- Nothing else using this Ethos home during a restore — no `ethos chat`, `serve`, `gateway`, or desktop app.

## Steps

### 4. Move to a new machine

Copy the archive across first — `scp`, a USB stick, whatever you already trust. `--restore` takes a local path, never a URL.

On the new machine:

```bash
curl -fsSL https://ethosagent.ai/install.sh | bash -s -- --restore ~/ethos-backup.tar.gz
```

```
✓ Will restore from /home/ada/ethos-backup.tar.gz after install
✓ Detected Linux x86_64
✓ Node 24.8.0 is already installed
✓ Installed @ethosagent/cli 0.7.3

Verifying /home/ada/ethos-backup.tar.gz...
✓ Archive verified against its manifest

✓ Restored 10 file(s) into /home/ada/.ethos
  scopes: identity, state · archive created 2026-09-05T01:29:39.252Z

  in-use check: ran — there was no existing database to displace.

✓ Restored. Verify with:
    ethos doctor
```

The order is fixed: install, then restore. `ethos import` is what does the restoring, so `ethos` has to exist first.

The installer verifies before it writes. It runs `ethos import --dry-run`, which streams the whole archive and checks every entry against the sha256 in the manifest — a truncated or edited archive is refused there, with your Ethos home untouched.

Under `curl … | bash` there is no terminal attached, so no secret prompts are shown. The import prints an `ethos secrets set <ref> <value>` line per missing credential instead; run those to finish. To be asked one question per secret instead, restore from a terminal:

```bash
ethos import ~/ethos-backup.tar.gz --secrets prompt
```

`ethos backup --bootstrap` prints the install and import lines for the archive it just wrote — the same move in two commands instead of one.

### 5. Restore onto a machine that already runs Ethos

Stop everything using this Ethos home first — `ethos chat`, `serve`, `gateway`, the desktop app.

Check what a restore would do before it does it:

```bash
ethos import ~/ethos-backup.tar.gz --dry-run
```

```
· Would restore 10 file(s) into /home/ada/.ethos
  scopes: identity, state · archive created 2026-09-05T01:29:39.252Z
  Dry run — nothing on disk was changed.

  in-use check: NOT made — a dry run cannot take the locks that answer it.
    A real restore may still be refused because something is running.
```

Then run it for real:

```bash
ethos import ~/ethos-backup.tar.gz --secrets prompt
```

Files the restore replaces are moved to `~/.ethos/.pre-restore/<timestamp>/`, not deleted. If you restored the wrong archive, that directory is what you copy back.

Restoring `identity` overwrites `config.yaml` and `mcp.json`, which are read at boot. The report says to restart; a process that was already running is still using the old ones.

## Verify

After a restore, `ethos doctor` runs `PRAGMA integrity_check` over every store:

```bash
ethos doctor
```

```
Store integrity
  ✓  PRAGMA integrity_check ok on 4 store(s) (10 not created yet)
```

Then start the agent and ask it something only the old machine would know.

## Troubleshoot

**`sessions.db is in use by another process`** — a `state` restore takes an exclusive lock on every database it is about to replace, and something is holding one. Stop `ethos chat`, `serve`, `gateway` and the desktop app, then retry. `--force` skips the check, and skipping it means nothing verified that another process was not mid-write.

**`Backup archive is corrupt: …`** — the archive failed its manifest checksum, and nothing was written. Restore from a different archive; a partial copy cannot be repaired.

**`IMPORT_NEWER_SCHEMA`** — the archive was written by a newer Ethos than the one reading it. Upgrade this machine, then retry.

## See also

- [Back up and restore an Ethos install](../back-up-and-restore.md) — taking the backup, scopes and the nightly job.
- [`ethos backup` and `ethos import`](../../reference/cli.md#ethos-backup) — every flag, and the exit codes.
