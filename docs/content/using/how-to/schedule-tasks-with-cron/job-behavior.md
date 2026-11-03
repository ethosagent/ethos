---
title: "Schedule tasks with cron: delivery, active hours and missed runs"
description: "How cron jobs scope to a personality, deliver output, skip hours, overlap, and recover"
kind: how-to
audience: user
time: "10 min"
updated: 2026-11-03
---

## Task

Tune where a cron job delivers output, when it runs, and what happens to missed, overlapping or failed runs.

## Result

A job delivers to the intended chat, skips occurrences outside its active hours, and follows the missed-run policy you chose.

## Prereqs

- Complete [part 1](../schedule-tasks-with-cron.md): a cron job exists and a persistent process is running.

## Steps

Pick the section under Notes that matches the behavior you want to change. Each shows the CLI command or tool call to use.

## Verify

```bash
ethos cron list
```

The job appears with the schedule and, if you set one, its active hours.

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

**`Invalid activeHours: "…"`** — The window is not `HH:MM-HH:MM`, or its start equals its end. Use a value like `09:00-21:00`, or `off` on update.
