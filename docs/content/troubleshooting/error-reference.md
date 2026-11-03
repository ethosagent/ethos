---
title: "Troubleshooting: error reference"
description: "Every registered Ethos error code with its meaning and the action to take."
kind: reference
audience: shared
updated: 2026-11-03
---

## Synopsis {#error-reference-synopsis}

Lookup table for the code printed in the three-line error block described on [Troubleshooting](../troubleshooting.md).

## Error reference {#error-reference}

The full list of registered codes. Every code shipped in `@ethosagent/types` `EthosErrorCode` appears here.

| Code | Cause | Action |
|---|---|---|
| `CONFIG_MISSING` | `~/.ethos/config.yaml` is absent or unreadable. | Run `ethos setup`. |
| `CONFIG_INVALID` | Config parsed but missing required fields. | Re-run `ethos setup`, or edit the file. |
| `CONFIG_CONFLICT` | The provider chain changed (another tab, or `ethos fallback`) after the page you saved from loaded it. Nothing was written. | Reload Settings, check the chain, and save again. |
| `PERSONALITY_NOT_FOUND` | Personality id does not exist. | `ethos personality list` and pick a valid id. |
| `PROVIDER_AUTH_FAILED` | LLM provider rejected the key. | Re-export the API key or run `ethos setup keys`. |
| `LLM_ERROR` | Provider returned a non-recoverable error mid-stream. | Re-run. If repeated, file a bug with the cause. |
| `STREAM_TIMEOUT` | The LLM streamed nothing for the watchdog window. | Re-run; tune `streamingTimeoutMs` if your network is slow. |
| `INVALID_INPUT` | A required CLI flag is missing or out of range. | Read the printed `Usage:` and re-run. |
| `INVALID_PROVIDER` | `--provider` names a provider Ethos does not ship. | Use one of the providers listed in the cause. |
| `INVALID_TOOLSET` | `--toolsets` names a toolset that does not exist. | Use one of the toolsets listed in the cause. |
| `FILE_NOT_FOUND` | A path passed to a CLI flag does not exist. | Verify the path and re-run. |
| `BATCH_INVALID_LINE` | A line in the batch JSONL file is malformed. | Fix the named line and re-run `ethos batch`. |
| `EVAL_INVALID_LINE` | A line in the eval JSONL file is malformed. | Fix the named line and re-run `ethos eval run`. |
| `TOOL_REJECTED` | A `before_tool_call` hook blocked the tool. | Adjust the hook config or the tool call. |
| `TOOL_EXECUTION_FAILED` | A tool returned `{ ok: false }`. | Treat the printed cause as the tool's diagnostic. |
| `SUBAGENT_TASK_DUPLICATED` | A delegated task duplicated across the child prompt. | Bug — file an issue with the parent personality and prompt. |
| `JOB_NOT_FOUND` | Cron job id does not exist. | `ethos cron list` and copy the exact id. |
| `JOB_DUPLICATE` | New cron job uses a taken id. | Pick a different id or remove the existing job. |
| `JOB_LOCK_FAILED` | Another cron command holds the lock. | Wait and re-run; kill stuck `ethos cron` processes. |
| `CRON_INVALID` | Cron expression failed validation. | Use a valid 5-field expression (see `crontab.guru`). |
| `CRON_PERSONALITY_MISSING` | The personality named on a cron job no longer exists. | Update the job to a current personality id. |
| `CRON_RUN_FAILED` | A cron job's turn ended in an error event. | `ethos cron list`, then check the job's personality and prompt. |
| `CRON_TARGET_NOT_ALLOWED` | A cron job asked to deliver into a chat that is not an approved target for that bot and personality. | Pick a target from the picker; add the chat to `channel_filter.<platform>` or message the bot once so the chat is known. |
| `RECIPE_NOT_FOUND` | No recipe with that id is shipped in the curated catalog. | Call `recipes.list` (Library → Recipes) and use an id from it. |
| `RECIPE_INVALID` | A shipped recipe bundle failed its own schema. | Report it — the catalog is first-party, so this is a packaging bug. |
| `RECIPE_STALE` | You previewed one version of a recipe and installed against a newer one. | Re-open the recipe, read what changed, and install again. |
| `RECIPE_BLOCKED` | A recipe install was refused because a prerequisite is unmet or a required field is empty. | Work through the preflight list — each row names the exact action — then install again. |
| `RECIPE_CHANNEL_SETUP_FAILED` | A recipe's inline channel setup could not complete: the bot token was refused, the platform was unreachable, or the chat you picked has not actually messaged that bot. | Re-check the token with @BotFather, then send your bot a message and press "Check for your message" again. Nothing was created. |
| `MCP_TRANSPORT_INVALID` | An MCP server entry is missing `command` (stdio) or `url` (sse). | Edit the MCP server entry in `~/.ethos/config.yaml`. |
| `MCP_SERVER_NOT_FOUND` | The named MCP server is not attached to that personality. | Attach the server first, then set its token. |
| `SECRETS_UNAVAILABLE` | The server has no secrets resolver wired. | Start the server with secrets configured. |
| `REGISTRY_FETCH_FAILED` | `ethos upgrade` could not reach the npm registry (`npm_config_registry`, default `registry.npmjs.org`). | Check network. Install manually: `npm i -g @ethosagent/cli@latest`. |
| `NETWORK_ERROR` | A non-registry network call failed. | Re-run. Check your connection. |
| `SKILL_INSTALL_FAILED` | `ethos skills install` did not complete. | Re-run; verify the source slug. |
| `SKILL_NOT_FOUND` | Skill id is not under `~/.ethos/skills/`. | Refresh the Skills tab; the file may have been deleted. |
| `SKILL_EXISTS` | A new skill collides with an existing file. | Pick a different id, or open and edit the existing skill. |
| `SKILL_READONLY` | System skills cannot be edited or deleted. | Duplicate into `~/.ethos/skills/`, then edit the copy. |
| `MISSING_SKILL` | A name passed to `-s` is not a plain filename under `~/.ethos/skills/`. | Use a bare skill name; confirm `<name>.md` exists. |
| `PERSONALITY_EXISTS` | Personality id is already taken. | Pick a different id. |
| `PERSONALITY_READ_ONLY` | Built-in personalities cannot be modified directly. | Duplicate, then edit the copy. |
| `PLUGIN_CONTRACT_INCOMPATIBLE` | Plugin declares an unsupported `pluginContractMajor`. | Upgrade the plugin or CLI per the migration guide. |
| `PLUGIN_INSTALL_FAILED` | The CLI install needs a recorded capability grant and stdin is not a TTY, or npm recorded no sha512 digest to hold it to. From the web, the server's `npm pack` or `npm install` failed (a dependency it cannot resolve, disk, permissions), and the message quotes npm's code; anything a failed `npm install` left behind was rolled back. It is also returned when a step after a successful `npm install` failed, including writing the personality's `plugins.lock` pin; the install was rolled back, any grant or pin the attempt wrote was put back as it was, and the message says whether an earlier copy was restored from its verified pin, removed, or left on disk. `ethos plugin install` undoes a failed install the same way. | CLI: install interactively, pass `--yes`, or install a published package by name. Web: fix what the message reports, then install again. Run the reinstall or `npm uninstall --prefix …` command it gives, if any. |
| `PLUGIN_SPEC_UNVERIFIABLE` | The spec names no published version with a sha512 digest, so the install cannot be verified. Nothing was installed. | Ask for a published version — list them with `npm view <package> versions`. |
| `PLUGIN_PACKAGE_NOT_FOUND` | The registry has no package by that name that the server can read. Nothing was installed. | Check the spelling. For a private package, give the server's npm a token that can read it. |
| `PLUGIN_REGISTRY_FAILED` | npm got no usable answer from the registry — no connection, or a registry error — while resolving, downloading, or installing. Nothing from the attempt is left installed: if a failed `npm install` left files behind, the server rolled them back, and the message says the end state it confirmed. | Check the server's network or npm proxy settings, then retry. |
| `PLUGIN_INTEGRITY_MISMATCH` | The downloaded tarball does not match the registry's published digest. Nothing was installed, granted, or pinned. | Retry. If it is refused again, do not install the package. |
| `PLUGIN_PACKAGE_MISMATCH` | npm installed a `package.json` naming a different package or version than the one verified. The install was rolled back; nothing was granted or pinned. If an earlier copy of the plugin was installed, the rollback removed it too, and the message says whether it was reinstalled from its verified `plugins.lock` pin or left removed. If the rollback failed, the message says the package was left on disk and will load on the next start. | Do not install the package. If the message says the earlier copy was removed, reinstall it with the `ethos plugin install …` command it gives. If it says a package was left on disk, run the `npm uninstall --prefix …` command it gives before restarting the server. |
| `TEAM_MANIFEST_INVALID` | `team.yaml` failed schema validation. | Fix the named field and re-run `ethos team start`. |
| `IMPORT_BLOCKED` | A restore was refused: an archive entry escapes the data dir or is not a regular file, the archive failed its manifest checksum, or a database it would replace is open in another process. | Read the printed cause. For a checksum failure, use a different archive. For an in-use database, stop `ethos chat` / `serve` / `gateway` / the desktop app and retry. See [Back up and restore](../using/how-to/back-up-and-restore.md). |
| `IMPORT_NEWER_SCHEMA` | A SQLite store on disk, or a backup archive, was written by a newer Ethos than the one reading it. | Upgrade Ethos to a build that understands it, then retry. |
| `MEMORY_CONFLICT` | A memory entry changed on disk between your read and your write. | Re-read the entry and retry the write. |
| `UNAUTHORIZED` | A web API request lacks valid auth. | Sign in again from the web UI. |
| `FORBIDDEN` | Authenticated, but the caller may not perform this action. | Use an account with the required role. |
| `NOT_FOUND` | A web API resource id does not resolve. | Refresh the list and re-select. |
| `NOT_CONFIGURED` | The server was started without a piece the route needs (LLM, storage, memory). | Restart the server with that component configured. |
| `SESSION_NOT_FOUND` | The session id passed to the web API does not exist. | Refresh the session list. |
| `WORKDIR_NOT_CONFIGURED` | The personality has no declared `fs_reach.workdir`, so Documents has no root to browse or write to. | Set `fs_reach.workdir` in the personality's `config.yaml`. |
| `DOCUMENT_EXISTS` | A Documents upload targeted a path that already has a file, and `overwrite` was not set. | Pick a different filename, or retry with overwrite enabled. |
| `PAYLOAD_TOO_LARGE` | An upload body exceeded the route's size cap (100MB for a Documents upload). | Upload a smaller file. |
| `INTERNAL` | An unexpected error escaped to the surface. | Re-run. If repeated, file an issue with the printed `details`. |
