---
title: "Troubleshooting: tools, skills and plugins"
description: "Tool, boundary, skill and plugin errors by symptom, with Cause, Fix and Prevent."
kind: reference
audience: shared
updated: 2026-11-03
---

## Synopsis {#tools-and-skills-synopsis}

Entries follow the same Cause / Fix / Prevent shape as [Troubleshooting](../troubleshooting.md).

## Tools and boundaries {#tools-and-boundaries}

### `Tool 'X' not found` {#tool-not-found}

Cause · The named [tool](../getting-started/glossary.md#tool) is not registered, or it is registered but not in the personality's `toolset.yaml`.

Fix ·
1. In chat, run `/tools` to list every registered tool the personality can see.
2. Add the tool to `toolset.yaml` if you want this personality to use it.
3. If the tool needs an env var (e.g. an API key), confirm `isAvailable()` returns `true`.

### `TOOL_REJECTED` {#tool-rejected}

Cause · A `before_tool_call` [hook](../getting-started/glossary.md#hook) chose not to let the tool run. The hook's reason appears in the printed cause line.

Fix · Read the cause string — it names the hook. Adjust the hook config (or the tool call) so the boundary is satisfied.

### `BoundaryError` (fs_reach violation) {#boundary-error}

Cause · A file tool tried to read or write a path outside the personality's [fs_reach](../getting-started/glossary.md#fs-reach) allowlist. `ScopedStorage` raises this; the surface translates it into a user-facing tool error.

Fix · Add the path (or a parent) to `fs_reach`, or move the file under an existing allowed path. If the path is sensitive on purpose, leave the boundary alone and work on a copy under the allowlist.

Prevent · Default-deny is intentional — broaden the allowlist deliberately, not reactively.

### `BUDGET_EXCEEDED` {#budget-exceeded}

Cause · The session crossed a token, tool-call, or cost budget configured on the personality. Session-scoped only in v1.

Fix · Run `/new` to reset the budget counter, or raise the budget in personality config.

### `MULTIPLE_IN_PROGRESS` (todo tool) {#multiple-in-progress}

Cause · The `todo` tool was asked to mark a second item `in_progress` while another is already in that state. Only one task may be in progress at a time.

Fix · Mark the existing in-progress task `done` or `pending`, then flip the new one to `in_progress`.

### Tool results are truncated {#tool-results-truncated}

Cause · Tool output exceeded the per-call slice of the turn's result budget. `ToolRegistry.executeParallel()` post-trims and appends `[truncated — N chars total]`. Default total is 80,000 characters per turn, split evenly across concurrent calls.

Fix · Paginate ("read the file 100 lines at a time"), reduce parallel tool calls, or raise `resultBudgetChars` in `AgentLoop` config (raises token costs).

## Skills and plugins {#skills-and-plugins}

### `SKILL_NOT_FOUND` {#skill-not-found}

Cause · The [skill](../getting-started/glossary.md#skill) id passed to a Skills tab action is not under `~/.ethos/skills/` — often the file was deleted out-of-band.

Fix · Refresh the Skills tab. If still missing, re-install: `ethos skills install <slug-or-url>`.

### `SKILL_INSTALL_FAILED` {#skill-install-failed}

Cause · `ethos skills install` could not complete. The temp directory is rolled back, so nothing is left half-installed.

Fix · Re-run the install — most failures are network blips. If the source URL is wrong, fix the slug. If repeated, check `~/.ethos/logs/errors.jsonl`.

### `SKILL_EXISTS` {#skill-exists}

Cause · A new skill collides with an existing file under `~/.ethos/skills/`.

Fix · Pick a different id, or open the existing skill from the Library panel and edit it in place.

### `PLUGIN_CONTRACT_INCOMPATIBLE` {#plugin-contract-incompatible}

Cause · A plugin declares a `pluginContractMajor` not supported by this CLI.

Fix · Upgrade the plugin or the CLI per `packages/plugin-contract/MIGRATIONS.md`. Check both with `ethos plugins list` and `ethos --version`.

### `PLUGIN_INSTALL_FAILED` {#plugin-install-failed}

Cause · `ethos plugins install` could not record the capability grant. Installing a plugin runs its code in your Ethos process, so the install refuses to proceed without a grant on record — and stdin is not a TTY, so nobody could be asked. The web Plugins page returns the same code, as HTTP 500, when the server's `npm pack` or `npm install` fails for a reason other than the registry or a missing npm; the message quotes npm's own error code and summary. If a failed `npm install` left files behind, the server undoes it the same way as the later failures below, so an ungranted package does not load on the next start. It also returns it when `npm install` succeeded but a later step failed — rewriting the plugins folder's `package.json` or `package-lock.json`, recording the grant, or writing the personality's `plugins.lock` pin. The server then rolls the install back, because a package with no grant still loads on the next start. If an earlier copy of the plugin was installed, the rollback removes it too: the server reinstalls it from a verified `plugins.lock` tarball pin when one exists. A grant or pin the attempt wrote is put back as it was before — the earlier record exactly, or no record at all, never a revocation. `ethos plugin install` undoes a failed install the same way, and prints the same end state without an error code. It records the grant before anything is installed, so it also puts the earlier grant back when the download, the digest check or `npm install` fails. The message says which end state it reached — restored, removed, or left on disk.

Fix · Re-run interactively and answer the prompt, or pass `--yes` to record the grant unattended. A `--yes` grant is stored with `consent: 'flag'`, so a later reader can see nobody was at the keyboard. From the web, fix what npm's quoted error reports (npm's full log is under `_logs/` in the server's `npm config get cache` directory), then install again. If the message says the earlier copy was removed, reinstall it with the `ethos plugin install <package>@<version>` command it gives. If it says a package was left on disk, run the `npm uninstall --prefix …` command it gives before restarting the server (or, from the CLI, before starting ethos again). If it says a grant or a pin could not be put back, check the grant with `ethos plugin grants` and the `plugins.lock` file it names.

Prevent · On CI and managed hosts, pass `--yes` in the install command rather than relying on a prompt that will never render.

### Workspace plugin "may not import … outside the plugin folder" {#workspace-plugin-import-outside}

Cause · A trusted plugin under `<cwd>/.ethos/plugins` or `<cwd>/node_modules` imports a file outside its own folder: a relative `../lib/x.js`, or a dependency hoisted to the project's `node_modules`. Its trust grant hashes only its folder, so the import is refused before any of that code runs (`guardWorkspacePluginImports` in `extensions/plugin-loader/src/workspace-import-guard.ts`). A `skills_dir` outside the folder is refused the same way.

Fix ·
1. Copy the imported files, or install the dependency, inside the plugin's folder (a nested `node_modules/` is part of the hash).
2. Review the plugin, then run `ethos plugin trust` in the project directory.
