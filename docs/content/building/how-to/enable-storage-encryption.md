---
title: "Enable storage encryption"
description: "Turn on AES-256-GCM encryption at rest for all files that pass through the Storage interface."
kind: how-to
audience: developer
slug: enable-storage-encryption
time: "5 min"
updated: 2026-05-21
---

## Task

Enable opt-in encryption at rest so that all files managed by the [Storage](../../getting-started/glossary.md#storage) interface are AES-256-GCM encrypted with per-file salts and Argon2id key derivation.

## Result

Every file read or written through the Storage interface -- personality memory (`MEMORY.md`, `USER.md`), personality configs, audit logs, and any other files that personality or team memory systems touch -- is encrypted on disk under `~/.ethos/`. Files are transparently decrypted on read and encrypted on write. No application code changes are required.

## Prereqs

- Ethos installed and running.
- A strong passphrase for key derivation (long, random, stored securely).

## Steps

### 1. Set the passphrase

Export `ETHOS_STORAGE_KEY` with a strong passphrase:

```bash
export ETHOS_STORAGE_KEY='your-strong-passphrase-here'
```

This value is run through Argon2id to derive the AES-256 key. Each file gets its own random salt, so identical plaintext produces different ciphertext across files.

### 2. Enable encryption in config

Add the `storage.encryption` flag to `~/.ethos/config.yaml`:

```yaml
storage:
  encryption: true
```

### 3. Restart Ethos

```bash
# Stop the running instance, then start again
ethos serve
```

On startup, Ethos checks for both the config flag and the environment variable. Existing unencrypted files are encrypted on first write.

## Startup guard

If `storage.encryption` is `true` but `ETHOS_STORAGE_KEY` is not set, Ethos exits immediately with a clear error. There is no fallback to unencrypted mode. This is intentional -- silent degradation to plaintext would defeat the purpose.

## What is encrypted

Everything that flows through the Storage interface:

- `MEMORY.md` and `USER.md` (personality memory)
- Personality config files
- Team memory topic files
- Audit logs
- Any other file that personality or team memory systems read/write via Storage

## What is NOT encrypted

`sessions.db`, `kanban.db`, and memory-vector index files use `better-sqlite3` with raw file paths that bypass the Storage interface. These are explicitly not covered.

Encrypting SQLite at rest requires [SQLCipher](https://www.zetetic.net/sqlcipher/), which is a separate project and not bundled with Ethos. If you need encrypted SQLite, evaluate SQLCipher independently.

## Key rotation

Changing the passphrase requires re-encrypting all files. Ethos does not handle this automatically.

### Option A: Delete and regenerate

1. Stop Ethos.
2. With the old `ETHOS_STORAGE_KEY` still set, confirm you can read your data (or back it up).
3. Set `ETHOS_STORAGE_KEY` to the new passphrase.
4. Delete the encrypted files under `~/.ethos/` (they will be recreated from memory on the next write cycle).
5. Restart Ethos.

### Option B: Re-encrypt in place

1. Stop Ethos.
2. Write a one-off script that reads each file with the old key and re-writes it with the new key.
3. Set `ETHOS_STORAGE_KEY` to the new passphrase.
4. Restart Ethos.

## Verify

Write a test file and confirm it's encrypted on disk:

```bash
# Start ethos with encryption enabled
export ETHOS_STORAGE_KEY='test-passphrase'
ethos chat
```

After writing some messages (which triggers memory writes), check that files under `~/.ethos/` are not readable as plaintext:

```bash
cat ~/.ethos/personalities/default/memory/MEMORY.md
# Should show binary gibberish, not readable text
```

If the file contents are unreadable binary data, encryption is working.

## Managed deployments (Clawrium / Docker / systemd)

Set `ETHOS_STORAGE_KEY` via the container or service environment. Do not bake the passphrase into an image or commit it to version control.

**Docker:**

```bash
docker run --env ETHOS_STORAGE_KEY='your-passphrase' ethos-image
```

**systemd:**

```ini
# /etc/ethos/env (mode 0600, owned by the ethos service user)
ETHOS_STORAGE_KEY=your-passphrase
```

```ini
# ethos.service
[Service]
EnvironmentFile=/etc/ethos/env
```

**AWS Secrets Manager:**

Inject the secret at container start via your orchestrator's native secrets integration (ECS task definition, EKS pod spec, etc.). The passphrase should never appear in logs or task metadata.
