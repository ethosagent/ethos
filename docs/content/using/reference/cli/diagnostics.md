---
title: "CLI: trace, audit, errors, perf and bench commands"
description: "ethos trace, audit, errors, perf, bench and tail commands."
kind: reference
audience: user
updated: 2026-11-03
---

## Synopsis {#synopsis}

Commands for inspecting what an install did and how fast. Part of the [CLI reference](../cli.md).

## ethos trace {#ethos-trace}

Inspect persisted traces from the observability store.

Synopsis: `ethos trace [list | show <id> | export <id> [--out <path>]]`

## ethos audit {#ethos-audit}

Inspect the audit events in `~/.ethos/observability.db`, newest first. Source: [`apps/ethos/src/commands/audit.ts`](https://github.com/ethosagent/ethos/blob/main/apps/ethos/src/commands/audit.ts).

Synopsis: `ethos audit [transitions | decisions] [--since <duration>] [--category <pattern>] [--limit <n>]`

| Subcommand / flag | Description |
|---|---|
| (none) | Every audit event, filtered by `--category` when given. |
| `transitions` | Events in category `audit.transition`. |
| `decisions` | Human and safety decisions: categories `audit.approval`, `audit.block` and `audit.watcher`, merged. Learning decisions appear here with codes `learning.approve`, `learning.override`, `learning.reject` and `learning.rollback`, beside outbox decisions (`outbox.approve`, `outbox.reject` and the rest). A candidate that promoted itself after a `pass` replay appears with code `learning.auto_promote`, attributed to the system. |
| `--since <duration>` | Only events newer than the duration: an integer plus `ms`, `s`, `m`, `h` or `d` (`30m`, `7d`). Any other shape is ignored and no time filter applies. |
| `--category <pattern>` | Without a subcommand, an exact category. With one, a case-insensitive substring filter on the category. |
| `--limit <n>` | Maximum events shown. Default `50`. |

```
ethos audit decisions --since 7d
```

## ethos security audit {#ethos-security-audit}

Run the local security audit — permission diffs, exposed secrets, untrusted skill warnings. `--fix` auto-remediates the safe subset; `--json` emits machine-readable findings; `--deep` runs the slower, network-touching checks. Exits `2` on usage error (e.g. `ethos security` with no `audit` arg).

Synopsis: `ethos security audit [--fix] [--json] [--deep]`

## ethos errors {#ethos-errors}

Inspect `~/.ethos/logs/errors.jsonl`.

Synopsis: `ethos errors [list | show <id> | clear]`

## ethos perf {#ethos-perf}

Per-turn performance summaries from the local trace store.

Synopsis: `ethos perf [summary | turn <id>]`

## ethos bench {#ethos-bench}

Measure the per-turn context cost of every personality. `context` is the only subcommand.

Synopsis: `ethos bench context [--cwd <dir>] [--live] [--scenario <id>] [--turns <n>] [--write-baseline]`

| Flag | Type | Default | Description |
|---|---|---|---|
| `--cwd <dir>` | path | current directory | Directory the project context (`AGENTS.md`/`CLAUDE.md`) is measured in. A personality with its own `fs_reach.workdir` is measured there instead. |
| `--live` | flag | off | Run live scenarios against the configured provider and record per-turn token usage. |
| `--scenario <id>` | string | all | Run one live scenario: `hi`, `one-tool`, `multi-tool` or `long-session`. |
| `--turns <n>` | integer | `10` | Turns for the `long-session` scenario. |
| `--write-baseline` | flag | off | Write the results to `evals/local/context-baseline.json`. |

The static table always prints, with no LLM calls:

| Column | Meaning |
|---|---|
| `soul ch` | `SOUL.md` size in characters. |
| `tools` | Number of tool schemas the personality's toolset exposes. |
| `schema ch` | Serialized tool-schema size in characters. |
| `tool_loading_chars` | Serialized tools sent on a turn's first step when on-demand tool loading is active. |
| `project ch` | The `## Project Context` block a turn sends from the measured directory. |
| `~tokens` | The static prefix at chars/4: SOUL, tool schemas, injection-defense prelude and project context. The same arithmetic as the small-window check (`measureStaticFloor`). |

```bash
ethos bench context
ethos bench context --cwd ~/code/my-repo
ethos bench context --live --scenario hi
```

Exits `1` on an unknown flag or scenario. Source: [`apps/ethos/src/commands/bench.ts`](https://github.com/ethosagent/ethos/blob/main/apps/ethos/src/commands/bench.ts).

## ethos tail {#ethos-tail}

Live-tail every known Ethos log file in one stream.

Synopsis: `ethos tail [--lines <n>] [--interval-ms <n>]`

## See also {#see-also}

- [CLI reference](../cli.md): the index of every section and its page.
