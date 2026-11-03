---
title: "Troubleshooting"
description: "Error catalogue for Ethos — common failure modes by symptom, with Cause / Fix / Prevent per entry."
kind: reference
audience: shared
slug: troubleshooting
updated: 2026-11-03
---

When something goes wrong, the CLI prints a three-line block: a code, a one-line cause, and a one-line action. Search this page for the code or the symptom you saw. Each entry follows the same shape: **Cause**, **Fix**, **Prevent** (when applicable).

## Parts {#parts}

| Part | Covers |
|---|---|
| This page | Synopsis; install and setup, provider and API keys, personality, sessions and memory. |
| [Troubleshooting: tools, skills and plugins](./troubleshooting/tools-and-skills.md) | Tools and boundaries; skills and plugins. |
| [Troubleshooting: channels, gateway and cron](./troubleshooting/channels-and-cron.md) | Channels and gateway; cron and jobs. |
| [Troubleshooting: error reference](./troubleshooting/error-reference.md) | Error reference: every registered error code. |

## Where things moved {#where-things-moved}

| Section | Page |
|---|---|
| <a id="tools-and-boundaries"></a>[Tools and boundaries](troubleshooting/tools-and-skills.md#tools-and-boundaries) | [Troubleshooting: tools, skills and plugins](troubleshooting/tools-and-skills.md) |
| <a id="tool-not-found"></a>[`Tool 'X' not found`](troubleshooting/tools-and-skills.md#tool-not-found) | [Troubleshooting: tools, skills and plugins](troubleshooting/tools-and-skills.md) |
| <a id="tool-rejected"></a>[`TOOL_REJECTED`](troubleshooting/tools-and-skills.md#tool-rejected) | [Troubleshooting: tools, skills and plugins](troubleshooting/tools-and-skills.md) |
| <a id="boundary-error"></a>[`BoundaryError` (fs_reach violation)](troubleshooting/tools-and-skills.md#boundary-error) | [Troubleshooting: tools, skills and plugins](troubleshooting/tools-and-skills.md) |
| <a id="budget-exceeded"></a>[`BUDGET_EXCEEDED`](troubleshooting/tools-and-skills.md#budget-exceeded) | [Troubleshooting: tools, skills and plugins](troubleshooting/tools-and-skills.md) |
| <a id="multiple-in-progress"></a>[`MULTIPLE_IN_PROGRESS` (todo tool)](troubleshooting/tools-and-skills.md#multiple-in-progress) | [Troubleshooting: tools, skills and plugins](troubleshooting/tools-and-skills.md) |
| <a id="tool-results-truncated"></a>[Tool results are truncated](troubleshooting/tools-and-skills.md#tool-results-truncated) | [Troubleshooting: tools, skills and plugins](troubleshooting/tools-and-skills.md) |
| <a id="skills-and-plugins"></a>[Skills and plugins](troubleshooting/tools-and-skills.md#skills-and-plugins) | [Troubleshooting: tools, skills and plugins](troubleshooting/tools-and-skills.md) |
| <a id="skill-not-found"></a>[`SKILL_NOT_FOUND`](troubleshooting/tools-and-skills.md#skill-not-found) | [Troubleshooting: tools, skills and plugins](troubleshooting/tools-and-skills.md) |
| <a id="skill-install-failed"></a>[`SKILL_INSTALL_FAILED`](troubleshooting/tools-and-skills.md#skill-install-failed) | [Troubleshooting: tools, skills and plugins](troubleshooting/tools-and-skills.md) |
| <a id="skill-exists"></a>[`SKILL_EXISTS`](troubleshooting/tools-and-skills.md#skill-exists) | [Troubleshooting: tools, skills and plugins](troubleshooting/tools-and-skills.md) |
| <a id="plugin-contract-incompatible"></a>[`PLUGIN_CONTRACT_INCOMPATIBLE`](troubleshooting/tools-and-skills.md#plugin-contract-incompatible) | [Troubleshooting: tools, skills and plugins](troubleshooting/tools-and-skills.md) |
| <a id="plugin-install-failed"></a>[`PLUGIN_INSTALL_FAILED`](troubleshooting/tools-and-skills.md#plugin-install-failed) | [Troubleshooting: tools, skills and plugins](troubleshooting/tools-and-skills.md) |
| <a id="workspace-plugin-import-outside"></a>[Workspace plugin "may not import … outside the plugin folder"](troubleshooting/tools-and-skills.md#workspace-plugin-import-outside) | [Troubleshooting: tools, skills and plugins](troubleshooting/tools-and-skills.md) |
| <a id="channels-and-gateway"></a>[Channels and gateway](troubleshooting/channels-and-cron.md#channels-and-gateway) | [Troubleshooting: channels, gateway and cron](troubleshooting/channels-and-cron.md) |
| <a id="duplicate-outbound"></a>[Duplicate outbound message on a channel adapter](troubleshooting/channels-and-cron.md#duplicate-outbound) | [Troubleshooting: channels, gateway and cron](troubleshooting/channels-and-cron.md) |
| <a id="bot-not-responding"></a>[Telegram or Discord bot does not respond](troubleshooting/channels-and-cron.md#bot-not-responding) | [Troubleshooting: channels, gateway and cron](troubleshooting/channels-and-cron.md) |
| <a id="team-manifest-invalid"></a>[`TEAM_MANIFEST_INVALID`](troubleshooting/channels-and-cron.md#team-manifest-invalid) | [Troubleshooting: channels, gateway and cron](troubleshooting/channels-and-cron.md) |
| <a id="ffmpeg-not-found"></a>[`ffmpeg not found` at gateway startup](troubleshooting/channels-and-cron.md#ffmpeg-not-found) | [Troubleshooting: channels, gateway and cron](troubleshooting/channels-and-cron.md) |
| <a id="voice-note-missing"></a>[Text reply arrives but the voice note does not](troubleshooting/channels-and-cron.md#voice-note-missing) | [Troubleshooting: channels, gateway and cron](troubleshooting/channels-and-cron.md) |
| <a id="voice-note-redelivered"></a>[A voice note arrives twice, or long after the fact](troubleshooting/channels-and-cron.md#voice-note-redelivered) | [Troubleshooting: channels, gateway and cron](troubleshooting/channels-and-cron.md) |
| <a id="voice-in-empty"></a>[A voice memo is answered as if it were empty](troubleshooting/channels-and-cron.md#voice-in-empty) | [Troubleshooting: channels, gateway and cron](troubleshooting/channels-and-cron.md) |
| <a id="cron-and-jobs"></a>[Cron and jobs](troubleshooting/channels-and-cron.md#cron-and-jobs) | [Troubleshooting: channels, gateway and cron](troubleshooting/channels-and-cron.md) |
| <a id="job-not-found"></a>[`JOB_NOT_FOUND`](troubleshooting/channels-and-cron.md#job-not-found) | [Troubleshooting: channels, gateway and cron](troubleshooting/channels-and-cron.md) |
| <a id="job-lock-failed"></a>[`JOB_LOCK_FAILED`](troubleshooting/channels-and-cron.md#job-lock-failed) | [Troubleshooting: channels, gateway and cron](troubleshooting/channels-and-cron.md) |
| <a id="cron-invalid"></a>[`CRON_INVALID`](troubleshooting/channels-and-cron.md#cron-invalid) | [Troubleshooting: channels, gateway and cron](troubleshooting/channels-and-cron.md) |
| <a id="cron-already-running"></a>[`Job "<id>" is already running`](troubleshooting/channels-and-cron.md#cron-already-running) | [Troubleshooting: channels, gateway and cron](troubleshooting/channels-and-cron.md) |
| <a id="cron-target-not-allowed"></a>[`CRON_TARGET_NOT_ALLOWED`](troubleshooting/channels-and-cron.md#cron-target-not-allowed) | [Troubleshooting: channels, gateway and cron](troubleshooting/channels-and-cron.md) |
| <a id="error-reference"></a>[Error reference](troubleshooting/error-reference.md#error-reference) | [Troubleshooting: error reference](troubleshooting/error-reference.md) |

## Synopsis {#synopsis}

User-facing errors are rendered by `formatError` in [`packages/types/src/errors.ts`](https://github.com/ethosagent/ethos/blob/main/packages/types/src/errors.ts):

```
✗ INVALID_INPUT: --concurrency must be a positive integer
  → Pass a positive integer, e.g. --concurrency 4.
```

The [Error reference table](troubleshooting/error-reference.md#error-reference) at the bottom lists every registered code. Entries above cover the symptoms users hit most often — install, provider, [personality](getting-started/glossary.md#personality), [session](getting-started/glossary.md#session), [tool](getting-started/glossary.md#tool), [skill](getting-started/glossary.md#skill), and channel adapter failures. For a local diagnostics view, run `ethos logs summary` or `ethos logs bundle`.

## Install and setup {#install-and-setup}

### `ethos: command not found` {#command-not-found}

Cause · The CLI binary is not on your `PATH`, or the shell has not picked up the new install yet.

Fix ·
1. Open a new terminal. Confirm Node 24: `node --version` (or `nvm use 24`).
2. Reinstall globally: `npm install -g @ethosagent/cli`, then verify with `ethos --version`.

Prevent · Pin Node 24 in `.nvmrc` for any project that calls `ethos` from scripts.

### `CONFIG_MISSING` {#config-missing}

Cause · The first-run setup wizard never completed, or `~/.ethos/config.yaml` was deleted or moved.

Fix · Run `ethos setup`. The wizard writes a fresh `~/.ethos/config.yaml`. For a clean slate, `rm -rf ~/.ethos/` first.

### `CONFIG_INVALID` {#config-invalid}

Cause · The config file parses as YAML but is missing one of `provider`, `model`, or `apiKey`.

Fix · Re-run `ethos setup` — answers default to the current config — or edit the file by hand and re-run.

### SQLite {#sqlite}

Ethos uses Node 24's built-in `node:sqlite` module (wrapped by `@ethosagent/sqlite`). There is no native compilation step — if Node 24 runs, SQLite works. If you see SQLite-related errors, confirm your Node version is 24 or later (`node --version`).

## Provider and API keys {#provider-and-api-keys}

### `PROVIDER_AUTH_FAILED` {#provider-auth-failed}

Cause · The LLM provider rejected the API key. The key is wrong, the env var is unset, or the key was rotated.

Fix ·
1. Re-export the key, e.g. `export ANTHROPIC_API_KEY="sk-ant-..."` or `export OPENAI_API_KEY="sk-..."`.
2. To persist, run `ethos setup keys`.
3. Sanity-check the key with a raw `curl` against the provider's `/v1/messages` or `/v1/chat/completions` endpoint.

Prevent · Store keys in a password manager and inject them via a shell init file — never commit them.

### `LLM_ERROR` {#llm-error}

Cause · The provider terminated the streamed response with a hard error (usually a 5xx or a content-policy refusal).

Fix · Re-run the same prompt — transient 5xxs clear on retry. If it repeats, capture the printed `cause` and file a bug.

### `STREAM_TIMEOUT` {#stream-timeout}

Cause · The provider opened the stream but did not produce a token for longer than `streamingTimeoutMs`.

Fix · Re-run the request. If your network is slow, raise `streamingTimeoutMs` in the personality `config.yaml`.

Prevent · On flaky connections, prefer a smaller model — first-token latency is lower.

### Rate-limited by the provider {#rate-limited}

Cause · You crossed the per-minute or per-day quota for the provider's tier.

Fix · Wait a minute and retry — most limits reset per minute. For development, switch to a cheaper model. For sustained load, configure `AuthRotatingProvider` from `@ethosagent/llm-anthropic` with multiple API keys.

## Personality {#personality}

### `PERSONALITY_NOT_FOUND` {#personality-not-found}

Cause · The configured personality id does not match any built-in or `~/.ethos/personalities/<id>/` directory.

Fix ·
1. Run `ethos personality list` and copy a valid id.
2. Switch with `ethos personality set <id>`, or edit `personality:` in `~/.ethos/config.yaml`.
3. For a custom personality, check the directory contains `SOUL.md`, `config.yaml`, and `toolset.yaml`.

### `PERSONALITY_READ_ONLY` {#personality-read-only}

Cause · You tried to edit or delete one of the built-in personalities. Built-ins are immutable on disk.

Fix · Duplicate first: `ethos personality duplicate <built-in-id> <new-id>`, then edit the copy under `~/.ethos/personalities/<new-id>/`.

### `PERSONALITY_EXISTS` {#personality-exists}

Cause · The id passed to `ethos personality duplicate` or `personalities.create` already names an existing personality.

Fix · Pick a different id, or remove the existing user copy first.

### Personality is not hot-reloading {#personality-not-reloading}

Cause · `FilePersonalityRegistry.loadFromDirectory()` is mtime-cached on six fingerprinted paths per personality directory: `config.yaml`, `SOUL.md`, `toolset.yaml`, `mcp.yaml`, `tools.yaml`, and the `skills/` directory (the list is owned by `loadOne` in `extensions/personalities/src/index.ts`). A change to any of them is picked up on the next turn or command. The `skills/` entry is the directory's own mtime, which moves when a file is added, removed, or renamed — not when an existing skill file is edited in place.

Fix ·
1. Confirm the file you edited is one of the six fingerprinted paths. Edits elsewhere in the directory are not watched.
2. If you edited an existing file under `skills/` in place, run `touch ~/.ethos/personalities/<id>/skills` to move the directory mtime, or re-save the file under a new name.

Prevent · Keep skill edits as add/remove operations, or touch the `skills/` directory after in-place edits.

## Sessions and memory {#sessions-and-memory}

### Agent forgets context mid-conversation {#agent-forgets-context}

Cause · `getMessages(sessionId, { limit })` returns the most recent N messages — the LLM sees the tail, not the head. Long conversations drop older context.

Fix ·
1. Use `/new` in chat to start a fresh [session](getting-started/glossary.md#session) when context is stale.
2. Ask the agent to write key facts to memory: "Remember that X" — they land in `~/.ethos/MEMORY.md`.
3. Raise the message `limit` in personality config (costs more tokens per turn).

Prevent · Keep important state in memory, not in conversation. Memory survives `/new` and session resets.

### `sessions.db` shows the wrong order or duplicates {#sessions-db-order}

Cause · Same-millisecond inserts need rowid tie-breaking. The current SQLite store handles this — if you see the symptom, the DB was written by an older build.

Fix · Back up (`cp ~/.ethos/sessions.db ~/.ethos/sessions.db.bak`), then delete (`rm ~/.ethos/sessions.db`). A fresh DB is created on the next run.

Prevent · Upgrade the CLI before reusing a database written by a build older than 0.2.0.

## Getting help {#getting-help}

When filing a bug, include `node --version`, `pnpm --version`, your OS, the full three-line error block, the relevant slice of `~/.ethos/logs/errors.jsonl`, and steps to reproduce. Open an issue at [github.com/ethosagent/ethos/issues](https://github.com/ethosagent/ethos/issues) or a discussion at [github.com/ethosagent/ethos/discussions](https://github.com/ethosagent/ethos/discussions).

## See also {#see-also}

- [Glossary](getting-started/glossary.md) — every domain term in one place.
- [CLI reference](using/reference/cli.md) — every subcommand and flag.
- [Changelog](changelog.md) — what changed in each release.
