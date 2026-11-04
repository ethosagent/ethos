---
title: "CLI: setup, chat, personality and memory commands"
description: "ethos setup, chat, personality, plugins and memory commands."
kind: reference
audience: user
updated: 2026-11-03
---

## Synopsis {#synopsis}

Commands for first-run setup, chatting, and managing personalities, plugins and memory. Part of the [CLI reference](../cli.md).

## ethos setup {#ethos-setup}

Interactive first-run wizard. Writes `~/.ethos/config.yaml`. Re-running is safe — answers default to the current config.

Synopsis: `ethos setup [auth | model | personality | messaging | memory | providers | keys]`

| Arg | Description |
|---|---|
| (none) | Start the wizard at the first step. |
| `auth` | Jump to the auth step. |
| `model` | Jump to the model-selection step. |
| `personality` | Jump to the personality step. |
| `messaging` | Jump to the channel-credentials step. |
| `memory` | Jump to the memory-backend step. |
| `providers` | Jump to the provider-chain step. |
| `keys` | Jump to the key-rotation step. |

If the wizard completes with "launch chat", the process continues into `ethos chat` against the freshly written config.

```bash
ethos setup messaging
```

## ethos chat {#ethos-chat}

Interactive REPL with streaming output, persisted sessions, and [slash commands](../slash-commands.md). Sessions are keyed by `cli:<basename of cwd>`. See [session](../../../getting-started/glossary.md#session).

Synopsis: `ethos chat [--verbose] [--skin <name>] [-q <prompt>] [--continue] [--resume <id>] [--team <name>] [--dry-run] [--incognito]`

| Flag | Default | Description |
|---|---|---|
| `--verbose` | off | Print a per-turn timing summary (LLM time, TTFT, tool wall-clock, total, tokens, cost) after every response. Persistent equivalent: `verbose: true` in config. |
| `--skin <name>` | from config | Override the resolved [skin](../config-yaml.md#skin) for this process only. Does not write to disk. |
| `-q <prompt>`, `--query <prompt>` | off | Single-query mode. Stream one answer and exit. `--query=<prompt>` is also accepted. |
| `--continue`, `-c` | off | Resume the most recent CLI session. Scoped to `cli:*` sessions only — never crosses into gateway sessions. |
| `--resume <id>`, `-r <id>` | off | Resume a specific session by ID or title. Tries exact ID match first, then case-insensitive title match. When multiple sessions match, lists candidates instead of picking one. |
| `--no-resume-hint` | off | Suppress the session-resume hint printed on exit. |
| `--team <name>` | off | Override [`activeContext`](../config-yaml.md#active-context) for this process, routing through a team coordinator. Does not write to disk. |
| `--dry-run` | off | Dry-run mode — tools are planned but not executed. Toggle within a session with `/dry-run on\|off`. |
| `--incognito` | off | Start on a fresh session that is not remembered or learned from. Also accepted with `-q`. See [Start an incognito session](../../how-to/incognito-sessions.md). |

```bash
ethos chat --verbose
ethos chat --continue
ethos chat --resume "research session"
ethos chat --team eng --dry-run
ethos -q "summarize the changes since yesterday"
```

## ethos personality {#ethos-personality}

Manage [personalities](../../../getting-started/glossary.md#personality). With no subcommand, lists every personality (built-in plus user) and marks the default.

Synopsis: `ethos personality [list | create [name] [--blank | --from <id>] | show <id> | set <id> | duplicate <src> <dst> | mcp <id> [--attach <name> | --detach <name>] | plugins <id> [--attach <plugin-id> | --detach <plugin-id>] | amendments <subcommand> | birth skip <id>]`

| Subcommand | Description |
|---|---|
| `list` *(default)* | List built-ins and user personalities, marking the default. |
| `create [name] [--blank \| --from <id>]` | Create a user personality: `--blank` from a starter `SOUL.md` and toolset, `--from <id>` as a copy of another personality, and with neither an AI-assisted chat with the personality architect. Every path makes the personality **born**: it records a birth marker and adds `propose_self_amendment` to a declared toolset, so its first private CLI or web conversation runs the [birth ritual](../../how-to/run-a-birth-ritual.md). |
| `show <id>` | Print the generated [character sheet](../../../building/explanation/personality-governance.md) — identity, display (emoji and avatar), routing, memory scope, toolset, MCP servers, plugins, `fs_reach`, and the prompt size, including the project context of a declared `fs_reach.workdir`. |
| `set <id>` | Persist `<id>` as the default personality in `~/.ethos/config.yaml`. |
| `duplicate <src> <dst>` | Copy `<src>` into `~/.ethos/personalities/<dst>/` so it becomes user-editable. |
| `mcp <id> [--attach\|--detach <name>]` | Show, attach, or detach MCP servers from `~/.ethos/mcp.json`. |
| `plugins <id> [--attach\|--detach <id>]` | Show, attach, or detach installed plugins. |
| `amendments list [--personality <id>] [--all] [--json]` | Requests a personality filed with `propose_self_amendment`: a toolset request changes its own `toolset.yaml`, an identity request its `name`, `description` and `display.emoji` in `config.yaml`. Lists `pending` and `stale` by default; `--all` lists every status. |
| `amendments show <id> [--json]` | The review, recomputed from the live files: permission diff (widening rows and `[high-risk]` marked; an identity request prints `none — an identity change grants nothing`), the `Not compared:` line, the diff of the file it changes, flags, rationale, evidence, provenance, history and the review hash. |
| `amendments apply <id>` | Print the review, ask for the personality id to be typed back, then write exactly the reviewed bytes. Refused without a TTY on stdin and stdout, and when `ETHOS_TOOL_PROCESS=1` (a tripwire the host shell tools set, not a boundary). Refused `CONFIG_CONFLICT` when the file changed since filing. Applying an identity request ends the personality's birth ritual. |
| `amendments decline <id> --reason "<text>"` | Close a `pending` or `stale` request. The reason is required. |
| `amendments rollback <id>` | Restore the `toolset.yaml` or `config.yaml` saved at apply time. Same gate as `apply`; refused when the file was edited after the apply, so roll back several applies newest first. |
| `birth skip <id>` | End a personality's birth ritual without changing it: removes its birth marker, so it never asks again. Prints `Skipped the birth ritual for <id>. It will not ask again.`, or `<id> has no birth ritual waiting; nothing to skip.` |

```bash
ethos personality show engineer
ethos personality duplicate engineer engineer-paired
ethos personality mcp engineer --attach github
ethos personality amendments show a-mukzpjf2-qiiphi
```

Every `amendments` failure prints `✗ <CODE>: <cause>` and exits `1`. Walkthrough: [Review a personality's change request](../../how-to/review-personality-change-requests.md).

## ethos plugins {#ethos-plugins}

Print a plugin-by-personality attachment matrix. To install or remove plugins, use [`ethos plugin`](evolve-and-learn.md#ethos-plugin).

Synopsis: `ethos plugins`

## ethos memory {#ethos-memory}

View and edit the [memory](../../../getting-started/glossary.md#memory-scope) files (the notes an agent keeps between turns). Every verb acts on the backend `memory:` selects — `markdown` (default), `vault`, or `vector` — in the active personality's scope. See [`memory`](../config-yaml.md#memory).

Synopsis: `ethos memory [show | add "<text>" | clear | export [path] | history | pending | restore <slug> | supersede <slug> --by <slug> | retract <slug>]`

| Subcommand | Args | Description |
|---|---|---|
| `show` *(default)* | `[--json]` | File backends: print `MEMORY.md` + `USER.md`. Vector mode: print the 20 most recent chunks. |
| `add` | `"<text>"` | Append to `MEMORY.md`. In vector mode, embed and chunk. |
| `clear` | — | Wipe `MEMORY.md`. In vector mode, prompts for confirmation. |
| `export` | `[path]` | Vector mode only. Export all chunks to a markdown file. Default: `~/.ethos/memory-export-<ts>.md`. |
| `history` | `[--personality <id>] [--key MEMORY.md] [--source <source>] [--since 7d] [--limit 50] [--diff <n>] [--json]` | Print the provenance history newest-first: who wrote what, when, and the diff. `--source` is one of `tool`, `capture`, `consolidation`, `dream`, `web-editor`, `global-entry`, `restore`. |
| `pending` | `[--approve <id> \| --reject <id>] [--personality <id>] [--json]` | List parked candidates from the approve-before-store gate; approve replays one into memory under its original source, reject tombstones its fact so capture never re-proposes it. See [`memoryApproval`](../config-yaml.md#memory-approval). |
| `restore` | `<slug> [--personality <id>]` | Move an archived section back into the file it came from. Recorded under source `restore`. |
| `supersede` | `<slug> --by <slug> [--personality <id>]` | Archive a section as replaced by a newer one. |
| `retract` | `<slug> [--reason <text>] [--personality <id>]` | Archive a section and tombstone its facts, so nothing re-proposes them. |

Under `memory: vector` every file verb — `history`, `pending`'s approve, `restore`, `supersede`, `retract` — refuses with `NOT_CONFIGURED`: that backend keeps entries in `memory.db`, not in files. Use `show` / `add` / `export`.

```bash
ethos memory add "Mitesh prefers terse explanations."
```

## See also {#see-also}

- [CLI reference](../cli.md): the index of every section and its page.
