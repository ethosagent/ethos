---
title: "CLI: systemd-unit, usage, claw, doctor and upgrade commands"
description: "ethos systemd-unit, usage, claw, doctor and upgrade commands."
kind: reference
audience: user
updated: 2026-11-03
---

## Synopsis {#synopsis}

Commands for service units, usage reporting, health checks and upgrades. Part of the [CLI reference](../cli.md).

## ethos systemd-unit {#ethos-systemd-unit}

Generate a systemd service unit file for a given Ethos command. Writes to stdout — pipe to a file or inspect before installing.

Synopsis: `ethos systemd-unit <name>`

| Name | Description |
|---|---|
| `ethos-gateway` | Unit for `ethos gateway start`. |
| `ethos-serve` | Unit for `ethos serve`. |
| `ethos-runall` | Unit for `ethos run-all`. |

Placeholder values are substituted from environment variables at generation time:

| Placeholder | Env var | Default |
|---|---|---|
| `{{ETHOS_BINARY}}` | `ETHOS_BINARY` | `ethos` |
| `{{ETHOS_USER}}` | `ETHOS_USER` | `$USER` (current user) |
| `{{ETHOS_HOME}}` | `ETHOS_HOME` | `$HOME` |

Generated units set `ETHOS_MANAGED=1` and load `~/.ethos/.env` via `EnvironmentFile`. Values containing newlines are rejected.

```bash
ethos systemd-unit ethos-gateway > ~/.config/systemd/user/ethos-gateway.service
systemctl --user daemon-reload
systemctl --user enable --now ethos-gateway
```

## ethos usage {#ethos-usage}

Aggregate token usage and estimated cost over a time window. Tokens and cost come from `~/.ethos/sessions.db`; turn outcomes and the `tool`/`skill` breakdowns come from `~/.ethos/observability.db` (zeros when it is absent).

Synopsis: `ethos usage --since <duration> [--by <dimension>] [--json]`

| Flag | Required | Description |
|---|---|---|
| `--since <duration>` | yes | Time window ending now. Format: `Nh` (hours), `Nd` (days), `Nm` (minutes). Example: `24h`, `7d`, `30m`. A missing or malformed value exits `2`. |
| `--by <dimension>` | no | Add a breakdown: `day`, `model`, `personality`, `channel`, `session`, `tool`, or `skill`. An unknown dimension exits `2`. |
| `--json` | no | Emit one JSON object instead of a human-readable summary. |

Cost is the sum of the stored message rows in the window: LLM usage on assistant rows plus any cost a tool reported (`cost_usd`) on its tool-result row. A forked session's copied history carries no usage, so a fork does not count its source's spend twice.

`--json` fields (`UsageResult` in [`apps/ethos/src/commands/usage.ts`](../../../../../apps/ethos/src/commands/usage.ts)):

| Field | Type | Description |
|---|---|---|
| `since`, `until` | ISO-8601 string | The window, half-open `[since, until)`. |
| `totals` | object | `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `estimatedCostUsd`, `messages` (rows carrying usage), and `cacheHitRate` (0–1: cache reads over input + cache reads + cache writes). |
| `daily` | array | One row per UTC day: `key` (`YYYY-MM-DD`) plus the same token, cost and `messages` fields as `totals`, without `cacheHitRate`. |
| `outcomes` | object | Turn counts from observability: `completed`, `errored`, `halted`, `running`. |
| `by` | object, only with `--by` | `{ dimension, rows }`. For `day`/`model`/`personality`/`channel`/`session`, rows have the `daily` row shape keyed by that dimension. For `tool`: `{ tool, calls, errors }`. For `skill`: `{ skill, invoked, exposed }`. |

```bash
ethos usage --since 7d
ethos usage --since 24h --by model --json
```

The web dashboard shows the same totals under Activity → **Usage**. Both fold the rows with `summarizeUsageRows` in `extensions/session-sqlite/src/index.ts`. Turn outcomes and `--by tool|skill` are CLI-only.

## ethos claw {#ethos-claw}

Migrate an OpenClaw install (`~/.claw/`) into Ethos (`~/.ethos/`). Idempotent.

Synopsis: `ethos claw migrate [--dry-run] [--preset all|user-data] [--overwrite] [--yes]`

`--dry-run` prints the plan without writing. `--preset all` (default) migrates everything; `user-data` skips personalities. `--overwrite` replaces existing Ethos files on conflict. `--yes` / `-y` skips the confirmation prompt.

## ethos doctor {#ethos-doctor}

Diagnostic — checks config, provider auth, session-store integrity, key permissions. It opens every database without migrating it, so a newer version's `ethos doctor` leaves the databases readable by the older one. `ethos gateway status` follows the same rule.

Synopsis: `ethos doctor [--json]`

## ethos upgrade {#ethos-upgrade}

Install the newest published `@ethosagent/cli` (or the version `--version` names) and keep it only if it passes `ethos doctor`. A source clone gets the `git pull` / `pnpm install` / `pnpm build` steps instead, and nothing is installed.

Synopsis: `ethos upgrade [--version <version-or-tag>] [--no-rollback]`

| Flag | Required | Description |
|---|---|---|
| `--version <version-or-tag>` | no | Install this exact version (`0.7.3`) or dist-tag (`next`) instead of `latest`. The registry resolves it to one exact version, which the health gate checks for. A range (`^0.7`) is refused before the registry is contacted. |
| `--no-rollback` | no | Keep the new version even if its health check fails. The failed checks and the way back are still printed. |

The registry is `npm_config_registry` when set, otherwise `https://registry.npmjs.org`. An npm-global upgrade runs these steps in order. Source: [`apps/ethos/src/commands/upgrade.ts`](https://github.com/ethosagent/ethos/blob/main/apps/ethos/src/commands/upgrade.ts).

| Step | What runs | On failure |
|---|---|---|
| Baseline | The running binary's `ethos doctor --json`. | Stops. Nothing is installed. |
| Backup | `ethos backup` into the backup directory. The archive path is printed. | Stops. Nothing is installed. |
| Install | `npm install -g @ethosagent/cli@<resolved-version>`. | Exits with npm's exit code. |
| Health gate | The new binary's `ethos doctor --json`, run from `$(npm root -g)/@ethosagent/cli` with the current Node, never from `PATH`. On success, prints `What changed:` with the [changelog](../../../changelog.md) entry for the new version. | Rolls back, unless `--no-rollback`. |
| Rollback | `npm install -g @ethosagent/cli@<previous>`, then the old binary's doctor, which must match the baseline. | Prints the archive path and the `ethos import <archive>` command. |

The health gate rolls back on any of these:

| Trigger | Doctor JSON field |
|---|---|
| The new doctor cannot be started, or prints no JSON report | — |
| The new binary reports a different version than the one installed | `version.version` |
| A core SDK does not load | `sdks[].loadable` where `required` |
| `sessions.db` does not open | `db.ok === false` |
| A database fails `PRAGMA integrity_check` | `storeIntegrity[].status === 'failed'` |
| A check that passed in the baseline now fails: a configured channel SDK, a secret, AWS Secrets Manager, secrets-directory permissions, a rejected channel token, call-capture dependencies, or the inbound spool failing to open | `sdks[]`, `secrets[]`, `awsSecrets`, `secretsDir`, `channels[].reason === 'rejected'`, `callCapture`, `inboundSpool.status` |

These are printed and never roll back: a check that already failed in the baseline, a stale gateway or call-capture heartbeat, an unreachable or rate-limited channel, and owed inbound-spool messages for a bot no longer configured.

`ethos upgrade` never restarts a gateway and never restores a backup. If a gateway is running, restart it yourself to run the new version, for example `systemctl --user restart ethos-gateway`. Roll back before that restart: a gateway on the new version may migrate its databases, and the older version then refuses to open them.

| Exit code | Meaning |
|---|---|
| `0` | Upgraded, already on the target version, or a source clone. |
| `1` | `--version` missing its value or not a version or dist-tag, registry unreachable or the version unpublished, baseline or backup failed, the new version failed its health gate (rolled back, or kept with `--no-rollback`), or the rollback failed. |
| npm's exit code | `npm install -g` of the new version failed. Nothing was changed. |

```bash
ethos upgrade
ethos upgrade --no-rollback
ethos upgrade --version 0.7.3
npm_config_registry=http://localhost:4873 ethos upgrade
```

## See also {#see-also}

- [CLI reference](../cli.md): the index of every section and its page.
