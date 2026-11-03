---
title: "CLI: batch, eval, evolve, learning and plugin commands"
description: "ethos batch, eval, evolve, learning, skills, keys and team commands."
kind: reference
audience: user
updated: 2026-11-03
---

## Synopsis {#synopsis}

Commands for batch runs, evaluation, evolution and skill, key and team management. Part of the [CLI reference](../cli.md).

## ethos batch {#ethos-batch}

Run a JSONL of prompts in parallel against the configured agent. Outputs JSONL. Required positional: `<tasks.jsonl>` — one task per line as `{"id": "...", "prompt": "..."}`. Optional: `--concurrency` (default `3`), `--output` (default `<input>.output.jsonl`), `--checkpoint` (default `<input>.checkpoint.json`) — re-running with the same checkpoint skips already-completed tasks.

Synopsis: `ethos batch <tasks.jsonl> [--concurrency <n>] [--output <out>] [--checkpoint <cp>]`

## ethos eval {#ethos-eval}

Score the agent's output against expected answers. Required: `--expected <file>` (JSONL keyed by `id`). Optional: `--scorer` (`exact` / `contains` / `regex` / `llm`, default `contains`), `--concurrency` (default `3`), `--output` (default `<input>.eval.jsonl`), `--evolve` to chain skill evolution after scoring, `--auto-approve` (with `--evolve`) to replay each evolved candidate inside the command so one that passes can promote under the [auto-promotion rules](../../explanation/learning-inbox.md#when-a-candidate-promotes-itself). Without `--auto-approve`, candidates wait in the learning inbox.

Synopsis: `ethos eval run <tasks.jsonl> --expected <expected.jsonl> [--scorer <name>] [--concurrency <n>] [--output <out>] [--evolve [--auto-approve]]`

## ethos evolve {#ethos-evolve}

Generate candidate skill files from session history or a prior eval run and submit them to the [learning inbox](../../explanation/learning-inbox.md) for the default personality. Nothing this command drafts goes live without a `pass` replay or a human. Supports both a newer subcommand style and the original flag-based style.

Synopsis (subcommand style):

```
ethos evolve status
ethos evolve run [--quiet]
ethos evolve apply <candidate-id | filename> | --all
ethos evolve prune [--older-than <days>] [--yes]
ethos evolve archive [--older-than <days>]
```

Synopsis (legacy flag style — backwards-compatible):

```
ethos evolve --eval-output <file> [--auto-approve]
ethos evolve --list-pending
ethos evolve --approve <candidate-id | filename> | --approve-all
ethos evolve --reject <candidate-id | filename>
```

### Subcommands {#ethos-evolve-subcommands}

| Subcommand | Description |
|---|---|
| `status` | Show the last evolver run from `~/.ethos/evolver-history.jsonl` and every skill candidate waiting in the learning inbox, with its id, destination filename, personality, origin and verdict. For Expression candidates too, use [`ethos learning list`](#ethos-learning). |
| `run [--quiet]` | Export recent sessions (last 7 days from `sessions.db`), run the evolver against them, and submit candidates to the learning inbox. `--quiet` suppresses progress output — the cron-safe equivalent of the legacy `--eval-output` path. |
| `apply <candidate-id \| filename> \| --all` | Approve a waiting skill candidate through the learning inbox, named by id or by its destination filename. Approves only a candidate whose replay verdict is `pass`; any other needs `ethos learning approve <id> --override "<reason>"`. `--all` tries every waiting skill candidate. A filename that matches more than one candidate is refused. |
| `prune [--older-than <days>] [--yes]` | Reject waiting skill candidates submitted more than `<days>` ago (default `7`) through the learning inbox. Nothing is deleted: each stays on record as `rejected` and writes a `learning.reject` row. Asks for confirmation unless `--yes`. |
| `archive [--older-than <days>]` | Move live skill files (`~/.ethos/skills/*.md`) whose modification time is older than `<days>` (default `30`) into `~/.ethos/skills/.archive/<YYYY-MM-DD>/`, with a `manifest.json`. Measured by file mtime, not by use. |

### Legacy flags {#ethos-evolve-legacy-flags}

| Flag | Description |
|---|---|
| `--eval-output <file>` | Run evolution against a specific eval output file and submit candidates to the learning inbox. |
| `--auto-approve` | With `--eval-output`, replay each new candidate inside the command. A candidate promotes only on a `pass` verdict, to a personality-scoped destination, when the personality sets no explicit `review`. The flag stands in for the global `autoApprove` knob for this run. |
| `--list-pending` | List waiting skill candidates from every origin. |
| `--approve <candidate-id \| filename>` | Same as `apply`: approves a `pass` candidate only. `--accept` is an alias. |
| `--approve-all` | Same as `apply --all`. `--accept-all` is an alias. |
| `--reject <candidate-id \| filename>` | Reject a waiting skill candidate. It stays on disk with status `rejected`. |

## ethos learning {#ethos-learning}

Review, replay, approve, reject and roll back learning candidates: every skill and Expression change a learning path drafted. Decisions go through `LearningInbox` ([`extensions/learning-inbox/src/inbox.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/learning-inbox/src/inbox.ts)), the same class the web dashboard's Learning page and Living Soul section decide through. For what a replay measures and when a candidate promotes itself, see [Why does a learned change need a replay before it goes live?](../../explanation/learning-inbox.md).

Synopsis:

```
ethos learning list [--personality <id>] [--all]
ethos learning show <id>
ethos learning replay <id>
ethos learning approve <id> [--override "<reason>"]
ethos learning reject <id> [--reason "<text>"]
ethos learning rollback <id> [--reason "<text>"]
```

### Subcommands {#ethos-learning-subcommands}

| Subcommand | Description |
|---|---|
| `list` | Candidates waiting for a decision (`pending_replay`, `pending_review`), newest first. `--personality <id>` filters to one personality. `--all` lists every status. |
| `show <id>` | Evidence, proposed content, the newest replay scorecard with its limitations, rollback availability for a promoted candidate, and the candidate's timeline from `audit.jsonl`. |
| `replay <id>` | Replay a waiting candidate now: a dry run of every selected case on real models, which costs money. May auto-promote under the resolver. Refused when `learningReplay.enabled` is `false`. |
| `approve <id>` | Promote a waiting candidate. A verdict other than `pass`, including never replayed, is refused unless `--override "<reason>"` is given; the reason is recorded in `audit.jsonl`. Writes a `learning.approve` or `learning.override` row to `ethos audit decisions`. |
| `reject <id>` | Mark a waiting, `invalid` or `stale` candidate `rejected`. `--reason` is optional. Writes `learning.reject`. |
| `rollback <id>` | Undo a promotion. A skill gets its prior bytes back, or a created file is removed; refused when the live file was edited since promotion. An Expression reverts only when it is the personality's latest promoted Expression candidate. Writes `learning.rollback`. |

### Examples {#ethos-learning-examples}

```
ethos learning list --personality researcher
ethos learning approve c-mf3k2x-a1b2c3 --override "replay incomplete: new personality, no case pool yet"
ethos learning rollback c-mf3k2x-a1b2c3 --reason "tone drifted in real chats"
```

### Exit codes {#ethos-learning-exit-codes}

| Code | Meaning |
|---|---|
| `0` | Success, including a replay that ended in a verdict other than `pass`. |
| `1` | Missing id, unknown subcommand, unknown candidate, or a refusal (`override_required`, `stale`, `invalid`, `live_edited`, `not_latest`, `replay_unavailable`). |

## ethos plugin {#ethos-plugin}

Install, list, and remove individual plugins (npm packages or local paths), and manage the capability grant each install records. For a personality-attachment overview, use [`ethos plugins`](setup-and-chat.md#ethos-plugins).

Synopsis: `ethos plugin [list | install <path-or-pkg> [--personality <id>] [--yes] | remove <id> | grants [--json] | revoke <id> | credentials <id>]`

A plugin runs inside the `ethos` process with your files, your environment, and your API keys. Installing one is equivalent to running arbitrary code as your user. The pre-install safety scan is a static read of the source: advisory, not a sandbox. `install` shows what the plugin declares, takes your consent, and writes a capability grant before any code lands.

| Subcommand or flag | What it does |
|---|---|
| `install <pkg>` | Downloads to a temp dir, scans, shows the declared capabilities, prompts, then installs. Red scan findings block the install outright. |
| `install <pkg> --yes` | Records the grant unattended. Without a TTY (or under `ETHOS_MANAGED=1`) and without `--yes`, the install is refused rather than auto-granted. |
| `grants [--json]` | Lists each recorded grant: source, declared capabilities, consent mode, and the scan findings as they stood at install. |
| `revoke <id>` | Withdraws a grant. The loader refuses to import that plugin from the next load, and will not auto-install it from a personality lockfile. It cannot undo what an already-loaded plugin did. |

## ethos skills {#ethos-skills}

Install ClawHub-compatible skills (markdown files with frontmatter). `list` (default) shows installed skills. `install <slug>` installs from ClawHub — slug formats: `owner/repo`, `github:owner/repo`, `github:owner/repo/path`. `update [<slug>]` updates one or all. `remove <slug>` uninstalls.

Synopsis: `ethos skills [list | install <slug> | update [<slug>] | remove <slug>]`

## ethos keys {#ethos-keys}

Manage the API-key rotation pool at `~/.ethos/keys.json` (chmod 600). `list` (default) prints masked keys with labels and priorities. `add <key> [--label <name>] [--priority <n>]` appends; priority defaults to `50` and higher values are chosen first. `remove <index>` deletes the 1-based entry.

Synopsis: `ethos keys [list | add <api-key> [--label <name>] [--priority <n>] | remove <index>]`

## ethos set {#ethos-set}

Set or inspect the active context that `chat` and `serve` route through. `ethos set` with no args prints the current context. `ethos set personality <id>` routes to a single personality; `ethos set team <name>` routes to a team coordinator (start it separately with `ethos team start <name>`).

Synopsis: `ethos set [personality <id> | team <name>]`

## ethos team {#ethos-team}

Manage team manifests and the supervisor lifecycle.

Synopsis: `ethos team [list | create <name> | <name> add <personality> | <name> remove <personality> | start <name> | stop <name> | status <name> | logs <name> [--member <id>]]`

## ethos mesh {#ethos-mesh}

Inspect mesh-level runtime state (live member counts, per-mesh registries).

Synopsis: `ethos mesh [list | status <name> | create <name> | destroy <name>]`

## See also {#see-also}

- [CLI reference](../cli.md): the index of every section and its page.
