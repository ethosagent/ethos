---
title: "CLI: initiatives commands"
description: "ethos initiatives run, list, show, export, pause, resume, metrics and the approve, adopt and keep decisions, with flags, output and errors."
kind: reference
audience: user
updated: 2026-11-28
---

## Synopsis {#synopsis}

Run one read-only research window, read the initiative ledger and record your decisions from a shell. Part of the [CLI reference](../cli.md). Initiatives are created in chat, never from the CLI. The [explanation](../../explanation/initiatives.md) covers the model.

Source: [`apps/ethos/src/commands/initiatives.ts`](https://github.com/ethosagent/ethos/blob/main/apps/ethos/src/commands/initiatives.ts) and [`apps/ethos/src/lib/initiatives-manage.ts`](https://github.com/ethosagent/ethos/blob/main/apps/ethos/src/lib/initiatives-manage.ts). Tests: `apps/ethos/src/commands/__tests__/initiatives-cli.test.ts`.

## ethos initiatives {#ethos-initiatives}

```
ethos initiatives run <initiative-id> (--survey | --scan | --explore <EXP-id>) [--json]
ethos initiatives (list | show <id> | export <EXP-id> | pause <id> | resume <id> | metrics
  | approve <EXP-id> | deny <EXP-id> [--reason <text>] | adopt <EXP-id> [--option X]
  | dig-deeper <EXP-id> | park <EXP-id> [--reason <text>] | keep <id> | stop <id> [--reason <text>]
  | make-mine <id>) [--personality <id>] [--days N] [--json]
```

Every subcommand except `run` reads or decides on the ledger (`initiatives.db`) and starts no model call. None of them creates the database. `--json` prints one JSON document with `"ok": true` plus the fields shown below.

### Run {#run}

| Argument | Description |
|---|---|
| `run <initiative-id>` | Starts one window now and prints it. This is the only subcommand that calls a model. |
| `--survey` | Reads the initiative and proposes explorations. |
| `--scan` | Looks for new initiatives to suggest. With `selfStart` off the drafts stay suggestions in the digest. |
| `--explore <EXP-id>` | Runs one window of an exploration you already approved. It never approves one. |

Pass exactly one of the three. A run spends against the same caps as the scheduled tick, in its own process: see [the cross-process limit](../../explanation/initiatives.md#trade-offs).

```bash
ethos initiatives run grow --survey
```

```
survey W-1 for grow: ended (done)
  tools:  web_search, initiative_propose
  reads:  2
    https://example.com/pricing
  proposed explorations: 1
    EXP-0001  Which channel converts?
  findings: 0
  cost: $0.1184
```

### Read the ledger {#read}

| Subcommand | Flags | Description |
|---|---|---|
| `list` | `--personality <id>` | One row per initiative: id, origin, personality, state, title. Prints `No initiatives saved.` when the ledger does not exist. |
| `show <id>` | | The initiative's file keys and its explorations with state and question. |
| `export <EXP-id>` | | Prints the newest brief of a briefed exploration as Markdown with its findings. In `--json` it returns `explorationId` and `markdown`. |
| `metrics` | `--days N` (default 30), `--personality <id>` | Gate approve rates, self-start outcomes, spend and unreachable guidance over the window. |

`--personality` defaults to the personality in `~/.ethos/config.yaml`.

```bash
ethos initiatives metrics --days 7
```

```
Last 7 days (personality researcher)
Gate 1 approve rate: 67% (2 of 3)
Gate 2 approve rate: 50% (1 of 2)
Self-start: 1 kept, 0 stopped
Spend: $1.2310
Unreachable guidance: 1 of 4 lines (25%)
```

The guidance line counts a line as unreachable when no connector can serve it (Mixpanel, Slack and similar). With no guidance lines it prints `Unreachable guidance: no guidance lines`. The JSON adds `"guidance": { "total": 4, "unreachable": 1, "ratio": 0.25 }`, with `ratio` null when `total` is 0. The CLI maps guidance as if every candidate tool were present, so a line the personality's toolset lacks still counts as reachable here.

### Decide {#decide}

Each decision goes through `decideInitiative` and is recorded as `owner:cli`. A decision on the wrong state changes nothing and fails with `INVALID_INPUT`.

| Subcommand | Needs state | Effect |
|---|---|---|
| `approve <EXP-id>` | `proposed` | Gate 1 yes: the exploration starts. |
| `deny <EXP-id> [--reason <text>]` | `proposed` | Gate 1 no (recorded as `reject`). |
| `adopt <EXP-id> [--option X]` | `briefed` | Gate 2 yes. `--option` names the brief option you chose. |
| `dig-deeper <EXP-id>` | `briefed` | Reopens it with a fresh `usd_per_exploration` budget and a new deadline. |
| `park <EXP-id> [--reason <text>]` | `briefed` | Gate 2 no for now. |
| `keep <id>`, `stop <id> [--reason <text>]` | initiative is `self_started` | Keeps or stops an agent-started initiative. |
| `make-mine <id>` | initiative is `self_started` | Writes nothing. Prints that you confirm the rewrite in chat. |

Snooze exists on the web and in channels, not in the CLI.

### Pause and resume {#pause-resume}

`pause <id>` and `resume <id>` change `state` through `InitiativeConfigService`, the only writer of initiative files, and print the new version.

```bash
ethos initiatives pause grow
```

```
grow: paused (version 4)
```

## Exit codes and errors {#errors}

| Cause | Code | Exit |
|---|---|---|
| Unknown subcommand, missing id, a flag without a value, wrong exploration state, `--days` not a positive number | `INVALID_INPUT` | `1` |
| Unknown initiative or exploration, or no ledger yet (except `list` and `metrics`) | `NOT_FOUND` | `1` |

Errors print the usage line or a hint such as `Check the id with "ethos initiatives list".` on stderr.

## See also {#see-also}

- [CLI reference](../cli.md) — top-level flags, exit codes and environment variables.
- [Initiative config reference](../initiatives-config.md) — the keys `pause`, `resume` and `show` touch.
- [Initiative budget and delivery](../initiatives-budget-and-delivery.md) — what a `run` is capped by.
- [Why is the initiative engine read-only, and what does it cost?](../../explanation/initiatives.md) — why `approve` and `adopt` are your step.
