---
title: "Schedule tasks with cron: test and manage jobs"
description: "Run a cron job on demand, pause, resume or remove it, and manage jobs from the dashboard"
kind: how-to
audience: user
time: "5 min"
updated: 2026-11-03
---

## Task

Run a cron job outside its schedule, then pause, resume or remove it from chat, the CLI or the web dashboard.

## Result

The job's output appears inline after a manual run, and `ethos cron list` shows the status you set.

## Prereqs

- Complete [part 1](../schedule-tasks-with-cron.md): a cron job such as `morning-briefing` exists and a persistent `ethos gateway start` or `ethos serve` process is running.

## Steps

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

If the job is already running (its scheduled run, or another "Run now"), the manual run is refused instead of running it a second time:

```text
Job "morning-briefing" is already running (started 2026-09-28T08:00:00.000Z) — wait for that run to finish
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

See [Use the web dashboard](../use-web-dashboard.md) for the full dashboard guide.

## Verify

```bash
ethos cron pause morning-briefing
ethos cron list
```

The job shows status `paused`. After `ethos cron resume morning-briefing` it shows `active` again with a recomputed `next_run`.

## Troubleshoot

**Job created but never fires** — The persistent process (`ethos gateway` or `ethos serve`) may have stopped. Check the process is running. Also verify the job status is `active`, not `paused`:



```bash

ethos cron list

```

**Job fires but output is empty** — The prompt may reference tools the personality doesn't have access to, or the model returned an empty response. Run the job manually and inspect the output:



```bash

ethos cron run <id>

```
