---
title: "Schedule tasks with cron"
description: "Create, manage, and test recurring agent tasks using the cron tool — from daily briefings to weekly reports."
kind: how-to
audience: user
slug: schedule-tasks-with-cron
time: "10 min"
updated: 2026-05-22
---

## Task

Schedule a recurring agent task (e.g. a daily briefing, a weekly report) that runs automatically on a cron schedule.

## Result

A cron job fires on schedule, runs the [personality](../../getting-started/glossary.md#personality)'s prompt through the agent loop, and delivers output to configured channels.

## Prereqs

- `ethos` installed and a provider configured ([Configure an LLM provider](configure-providers.md)).
- A personality with `cron` in its `toolset.yaml`.
- A persistent process running: `ethos gateway start` or `ethos serve --web`. The cron scheduler needs a long-lived process — `ethos chat` is ephemeral and does not wire a scheduler.

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
ethos serve --web
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

### 5. Test a job immediately

Run a job outside its normal schedule to verify the prompt produces useful output:

```text
Run the Morning Briefing job now.
```

The agent calls `cron({ action: "run", id: "morning-briefing" })` and returns the output inline. The next scheduled firing is not affected.

From the CLI:

```bash
ethos cron run morning-briefing
```

### 6. Manage jobs

**Pause** a job (reversible — the row stays in the store):

```text
Pause the Morning Briefing.
```

```bash
ethos cron pause morning-briefing
```

**Resume** a paused job (next-run time is recomputed from the schedule):

```text
Resume the Morning Briefing.
```

```bash
ethos cron resume morning-briefing
```

**Remove** a job permanently:

```text
Remove the Morning Briefing job.
```

```bash
ethos cron delete morning-briefing
```

### 7. Manage from the web dashboard

If `ethos serve --web` is running, the **Cron** tab in the web dashboard shows all jobs. From there you can:

- View run history and output for each job.
- Pause and resume jobs with a toggle.
- Trigger an immediate run.
- Remove jobs.

See [Use the web dashboard](use-web-dashboard.md) for the full dashboard guide.

## Verify

```bash
ethos cron list
```

The job appears with status `active` and a `next_run` timestamp matching the schedule. Run it once to confirm the output:

```bash
ethos cron run morning-briefing
```

The output should match what you'd expect from the prompt running through the personality.

## Notes

### Jobs are personality-scoped

Every cron job is pinned to the personality that created it. The `personalityId` field is required and set automatically from context. When the job fires, it runs under that personality's toolset, memory scope, and model configuration.

### Recursion guard

Cron-spawned sessions cannot create further cron jobs. The scheduler removes the `cron` tool from the effective toolset during job execution, preventing infinite recursion. If a cron prompt asks to "schedule another job," the agent receives an unknown-tool error.

### Delivery

Cron job output is delivered to the channels configured for the personality. For a gateway-connected bot, that means Telegram, Slack, Discord, or whichever platform the personality serves. For `ethos serve` without a gateway, output is stored in the cron run history and viewable from the web Cron tab or `ethos cron read-run <id> --at <timestamp>`.

### Missed runs

If the scheduler was down when a job's scheduled time passed, the `missed_run_policy` controls what happens on next start:

- `skip` (default) — wait for the next normal occurrence.
- `run-once` — fire the missed slot once, then resume the normal schedule.

Set the policy at creation time by telling the agent, or pass it directly:

```text
cron({
  action: "create",
  name: "Weekly Report",
  schedule: "0 9 * * 1",
  prompt: "Generate the weekly engineering report.",
  missed_run_policy: "run-once"
})
```

## Troubleshoot

**`not_available: cron tool requires a scheduler`** — The personality lists `cron` in `toolset.yaml` but the process has no scheduler wired. Switch from `ethos chat` to `ethos gateway start` or `ethos serve --web`.

**`input_invalid: invalid cron expression`** — The schedule string is not a valid 5-field cron expression. Use the format `minute hour day month weekday`. Examples: `0 8 * * 1-5` (8am weekdays), `*/15 * * * *` (every 15 minutes), `0 9 * * 1` (9am Mondays).

**`input_invalid: personality context required`** — The `create` action was called without an active personality. Switch to a personality first (`/personality <id>`).

**Job created but never fires** — The persistent process (`ethos gateway` or `ethos serve`) may have stopped. Check the process is running. Also verify the job status is `active`, not `paused`:

```bash
ethos cron list
```

**Job fires but output is empty** — The prompt may reference tools the personality doesn't have access to, or the model returned an empty response. Run the job manually and inspect the output:

```bash
ethos cron run <id>
```

**Agent refuses to create a cron job** — If the agent says the cron tool is unavailable, the personality's `toolset.yaml` may not include `cron`. Add it and retry.

## See also

- [Cron tool reference](../../building/reference/cron-tools.md) — action-dispatch schema, wiring contract, and error codes.
- [CLI reference](../reference/cli.md) — `ethos cron list / pause / resume / delete / run / create` commands.
- [Run Ethos as a daemon](run-as-daemon.md) — run the gateway or serve process under systemd, launchd, or pm2 so the cron scheduler survives reboots.
- [Use the web dashboard](use-web-dashboard.md) — manage cron jobs from the browser.
