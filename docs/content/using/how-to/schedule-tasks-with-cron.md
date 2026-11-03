---
title: "Schedule tasks with cron"
description: "Create and list recurring agent tasks with the cron tool; later parts cover testing, managing and tuning jobs."
kind: how-to
audience: user
slug: schedule-tasks-with-cron
time: "10 min"
updated: 2026-11-03
---

## Task

Schedule a recurring agent task (e.g. a daily briefing, a weekly report) that runs automatically on a cron schedule.

## Result

A cron job fires on schedule, runs the [personality](../../getting-started/glossary.md#personality)'s prompt through the agent loop, and delivers output to configured channels.

## Prereqs

- `ethos` installed and a provider configured ([Configure an LLM provider](configure-providers.md)).
- A personality with `cron` in its `toolset.yaml`.
- A persistent process running: `ethos gateway start` or `ethos serve`. The cron scheduler needs a long-lived process — `ethos chat` is ephemeral and does not wire a scheduler.


## Parts

| Part | Covers |
|---|---|
| This page | Steps 1-4: add `cron` to the toolset, start a persistent process, create and list a job |
| [Test and manage jobs](schedule-tasks-with-cron/test-and-manage.md) | Steps 5-7: run a job now, pause, resume, remove, use the web dashboard |
| [Delivery, active hours and missed runs](schedule-tasks-with-cron/job-behavior.md) | Notes: <a id="active-hours"></a>personality scope, recursion guard, delivery, active hours, overlap, failed one-shots, missed runs |

## Steps

### 1. Add cron to the personality's toolset

Edit `~/.ethos/personalities/<id>/toolset.yaml` and add `cron`:

```yaml
# ~/.ethos/personalities/<id>/toolset.yaml
- read_file
- search_web
- terminal_run
- cron
```

The personality registry reloads on the next turn — no restart needed.

### 2. Start a persistent process

If not already running:

```bash
ethos gateway start
```

Or, if you only need the web UI and cron (no Telegram/Slack bots):

```bash
ethos serve
```

The cron tool is unavailable in `ethos chat` because chat sessions are ephemeral. Jobs created in an ephemeral process would never fire.

### 3. Ask the agent to create a job

In chat (web or gateway-connected channel), switch to the personality with cron access and ask naturally:

```text
/personality engineer
Schedule a daily morning briefing at 8am on weekdays. Summarise overnight
Slack alerts, the deploy log, and pending PRs.
```

The agent calls the cron tool:

```text
cron({
  action: "create",
  name: "Morning Briefing",
  schedule: "0 8 * * 1-5",
  prompt: "Summarise overnight Slack alerts, the deploy log, and pending PRs."
})
```

The job is pinned to the calling personality automatically — `personalityId` is set from context.

### 4. List jobs

Ask the agent:

```text
List my cron jobs.
```

Or from the CLI:

```bash
ethos cron list
```

Both paths read the same store. Output includes the job ID, name, schedule, status, and next-run timestamp.

Continue with [Test and manage jobs](schedule-tasks-with-cron/test-and-manage.md).

## Verify

```bash
ethos cron list
```

The job appears with status `active` and a `next_run` timestamp matching the schedule. Run it once to confirm the output:

```bash
ethos cron run morning-briefing
```

The output should match what you'd expect from the prompt running through the personality.

## Troubleshoot

**`not_available: cron tool requires a scheduler`** — The personality lists `cron` in `toolset.yaml` but the process has no scheduler wired. Switch from `ethos chat` to `ethos gateway start` or `ethos serve`.

**`input_invalid: invalid cron expression`** — The schedule string is not a valid 5-field cron expression. Use the format `minute hour day month weekday`. Examples: `0 8 * * 1-5` (8am weekdays), `*/15 * * * *` (every 15 minutes), `0 9 * * 1` (9am Mondays).

**`input_invalid: personality context required`** — The `create` action was called without an active personality. Switch to a personality first (`/personality <id>`).

**Agent refuses to create a cron job** — If the agent says the cron tool is unavailable, the personality's `toolset.yaml` may not include `cron`. Add it and retry.

## See also

- [Cron tool reference](../../building/reference/cron-tools.md) — action-dispatch schema, wiring contract, and error codes.
- [CLI reference](../reference/cli.md) — `ethos cron list / pause / resume / delete / run / create` commands.
- [Run Ethos as a daemon](run-as-daemon.md) — run the gateway or serve process under systemd, launchd, or pm2 so the cron scheduler survives reboots.
- [Use the web dashboard](use-web-dashboard.md) — manage cron jobs from the browser.
