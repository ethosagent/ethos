---
title: "Schedule tasks with cron"
description: "Create, manage, and test recurring agent tasks using the cron tool — from daily briefings to weekly reports."
kind: how-to
audience: user
slug: schedule-tasks-with-cron
time: "10 min"
updated: 2026-09-29
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

Cron job output is delivered to the chat the job was created from, by the bot it was created with, and into the same thread when it was created in one. For `ethos serve` without a gateway, output is stored in the cron run history and viewable from the web Cron tab or `ethos cron read-run <id> --at <timestamp>`.

Delivery to a chat follows the same rules as any tracked notice:

| Situation | What happens |
|---|---|
| Quiet hours, or the chat is muted with `/mute` | Output is held and sent when the hold ends. |
| The platform refuses the send | The delivery sweep retries it. |
| The run fails (a provider error, a turn with no answer) | Nothing is delivered. The chat gets one failure notice, at most once every 6 hours per job. `lastError` records every failure. |
| A job created before jobs recorded their bot, on a platform with several bots | Delivery is refused with `CRON_TARGET_NOT_ALLOWED` rather than sent by the wrong bot. Recreate the job from the chat it should reply to. |

### Active hours

Give a recurring job a daily window, and an occurrence outside it is skipped before any model call. A check-in every three hours then costs nothing overnight.

Ask the agent (`active_hours` on the `cron` tool), or set it from the CLI:

```bash
ethos cron create -n "Check-in" -s "0 */3 * * *" -p "Check in." --active-hours 09:00-21:00
```

```text
✓ Created "Check-in" (check-in)
Active hours: 09:00-21:00
Next run: 30/09/2026, 09:00:00
```

| Rule | Detail |
|---|---|
| Format | `HH:MM-HH:MM`. Start inclusive, end exclusive. A start later than the end crosses midnight (`22:00-06:00`). Start and end must differ. |
| Clock | The host's clock, the same one the schedule runs on, so `0 20 * * *` with `19:00-21:00` always runs. `notifications.timezone` moves quiet hours only. |
| Skipped occurrence | No turn, no script, no precheck. It is audited as `inactive-hours-skip`, is not counted as a run, and never fires later as a missed run. A `repeat` count is not used up by it. |
| Manual run | `ethos cron run <id>` and the tool's `run` action ignore the window. |
| One-shot jobs | Refused: `activeHours is not allowed on a one-shot schedule`. A one-shot already names its exact time. |
| Clear it | `ethos cron update <id> --active-hours off`, or `active_hours: "off"` on the tool's `update`. |

Active hours save the turn. Quiet hours and `/mute` still hold the delivery of a run inside the window. The web Cron tab shows no field for the window yet; set it from the CLI or the agent.

For a ready-made check-in, install the **Heartbeat check-in** recipe from the web **Recipes** page. It adds a check-in section to a personality you already have and a job with `09:00-21:00` active hours that stays silent (`[SILENT]`) when there is nothing worth saying.

### Overlapping runs

A job never runs twice at once. If an occurrence falls due while the previous run is still executing, that occurrence is skipped and a `[skipped: overlap]` entry appears in the run history. "Run now" is refused while a run is executing. A run left behind by a process that crashed or was restarted does not block the job: it runs at the next tick.

### Failed one-shot jobs

A one-shot job (a single date or "in 2 hours") whose run fails is **paused**, not retired, so it can be retried. Resume it once the cause is fixed:

```bash
ethos cron resume <id>
```

### Missed runs

If the scheduler was down when a job's scheduled time passed, the `missed_run_policy` controls what happens on next start:

- `skip` (default) — wait for the next normal occurrence. The skipped slot is recorded as a `[skipped: missed]` entry in the run history.
- `run-once` — fire the missed slot once, then resume the normal schedule.

A slot counts as missed only when it fell due before the scheduler's previous tick, or before the process started. A slot that fell due between two ticks always runs, however far apart the ticks are. That covers an external `POST /cron/fire` every 5 minutes, and a laptop that slept while `ethos` kept running. A missed one-shot job is retired, with `lastError` set and a notice sent to its chat.

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

**`Invalid activeHours: "…"`** — The window is not `HH:MM-HH:MM`, or its start equals its end. Use a value like `09:00-21:00`, or `off` on update.

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
