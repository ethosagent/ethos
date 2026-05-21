---
title: Cron tools
description: "Six agent-callable cron tools — create, list, pause, resume, delete, run-now. Wiring contract, scheduler sharing, and personality opt-in."
kind: reference
audience: developer
slug: cron-tools
updated: 2026-05-17
---

# Cron tools

Six agent-callable tools let any personality schedule recurring work — `create_cron_job`, `list_cron_jobs`, `pause_cron_job`, `resume_cron_job`, `delete_cron_job`, `run_cron_job_now`. The tools register against the same `CronScheduler` instance the operator-driven `ethos cron` CLI uses, so jobs created via either path land in the same store and fire through the same engine.

## Source {#source}

Factory: [`extensions/tools-cron/src/index.ts`](https://github.com/MiteshSharma/ethos/blob/main/extensions/tools-cron/src/index.ts) (`createCronTools(scheduler)`). Scheduler implementation: [`@ethosagent/cron`](https://github.com/MiteshSharma/ethos/tree/main/packages/cron). Wiring at [`packages/wiring/src/index.ts`](https://github.com/MiteshSharma/ethos/blob/main/packages/wiring/src/index.ts) — registers all six tools when `cronScheduler` is passed in via `CreateAgentLoopOptions`.

## Availability {#availability}

The tools are registered on the agent's tool registry **only when** an `CronScheduler` is wired through to `createAgentLoop`. Two callers do this today:

| Caller | Behaviour |
|---|---|
| `ethos gateway` | Always wires a scheduler. Every personality bound to a configured bot has the cron tools available if it lists them in `toolset.yaml`. |
| `ethos serve` | Always wires a scheduler. The web Cron tab and agent-callable cron tools share the same scheduler instance. |
| `ethos chat` / CLI one-off | No scheduler — cron jobs created in an ephemeral process can't persist past exit. The tools aren't registered. |

A personality that lists a cron tool in `toolset.yaml` but runs in a context without a scheduler gets an "unknown tool" error at call time. That's intentional — calling `create_cron_job` from a CLI chat would silently create jobs that never fire.

## Personality opt-in {#opt-in}

Add the tools you want available to the personality's `toolset.yaml`:

```yaml
# ~/.ethos/personalities/<id>/toolset.yaml
- create_cron_job
- list_cron_jobs
- delete_cron_job
- pause_cron_job
- resume_cron_job
- run_cron_job_now
```

You can list a subset — e.g. an audit personality that lists only `list_cron_jobs` can inspect the schedule but not modify it.

The 6 tools are independent — no transitive dependencies between them. They share `toolset: 'cron'` for grouping but personalities pick individual tools, not the toolset name.

## Tools {#tools}

### `create_cron_job` {#create-cron-job}

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Human-readable label (e.g. `"Morning Briefing"`). |
| `schedule` | string | yes | Standard 5-field cron expression — minute hour day month weekday. All times are local. Validated via `isValidCronExpression`. |
| `prompt` | string | yes | The prompt the agent runs on each firing. |
| `personality` | string | no | Personality to fire under. Default: the personality that called the tool. |
| `deliver` | string | no | `"telegram"` / `"cli"` — where to send the output. Default: `"cli"`. |
| `missed_run_policy` | `'run-once' \| 'skip'` | no | What to do if the scheduler was down when the job's scheduled time passed. `run-once` fires the missed slot on next start; `skip` waits for the next normal occurrence. Default: `skip`. |

Returns the assigned job id, the resolved next-run timestamp, and a summary line.

### `list_cron_jobs` {#list-cron-jobs}

No parameters. Returns every job in the store with id, name, schedule, status (`active` / `paused`), next-run timestamp, and the prompt summary. Useful for the agent to inventory what's scheduled before adding a duplicate.

### `delete_cron_job` {#delete-cron-job}

| Field | Type | Required |
|---|---|---|
| `id` | string | yes |

Permanently removes the job. Cannot be undone. Use `pause_cron_job` if you want a reversible stop.

### `pause_cron_job` {#pause-cron-job}

| Field | Type | Required |
|---|---|---|
| `id` | string | yes |

Marks the job paused. The scheduler stops firing it but the row stays in the store. Resume with `resume_cron_job`.

### `resume_cron_job` {#resume-cron-job}

| Field | Type | Required |
|---|---|---|
| `id` | string | yes |

Unpauses. The next-run time is recomputed from the schedule, not from when the pause happened.

### `run_cron_job_now` {#run-cron-job-now}

| Field | Type | Required |
|---|---|---|
| `id` | string | yes |

Fires the job's prompt immediately, outside its normal schedule. Returns the output (capped at 10 000 chars). The next scheduled firing is not affected.

## Wiring contract {#wiring}

Callers thread the scheduler through `CreateAgentLoopOptions.cronScheduler`:

```ts
// packages/wiring/src/index.ts CreateAgentLoopOptions
cronScheduler?: CronScheduler;
```

When present, the wiring registers `createCronTools(scheduler)` on the AgentLoop's tool registry. The tool registry's per-personality filter then exposes only the tools the personality's `toolset.yaml` allowlists.

A typical gateway wires it like this:

```ts
// Hoist the scheduler so it can be passed into every createAgentLoop call.
// `runJob` forward-references the loop var that's assigned below.
let systemLoop: AgentLoop | null = null;
const scheduler = new CronScheduler({
  logger,
  runJob: async (job) => {
    if (!systemLoop) throw new EthosError(...);
    // ... iterate systemLoop.run(job.prompt, ...) and collect output
  },
});

const { loop } = await createAgentLoop(config, { cronScheduler: scheduler });
systemLoop = loop;

scheduler.start();   // begin polling — runJob can now safely fire
```

The same scheduler instance is reused for every personality loop the gateway builds (`buildGatewayBots` threads it through to each `createAgentLoop` call), so all personalities share one job store.

## Capability rationale {#capabilities}

`capabilities: {}` on every cron tool — no framework-level gate. Reasoning:

- The scheduler is operator-injected. Without one, no tool registration happens at all.
- The store is per-machine (under `~/.ethos/cron/`). Jobs created by the agent are visible to the operator via `ethos cron list` immediately.
- The fired prompt is just a turn of the agent — same surface area as any inbound message. There's no novel execution channel.

That said, **cron creates durable side effects** (recurring runs cost provider tokens; output may notify channels). Treat the personality opt-in as the safety boundary. Don't add cron tools to a personality that handles untrusted input unless you accept that a prompt-injected user could schedule arbitrary recurring prompts.

## Errors {#errors}

| `code` | When | Operator fix |
|---|---|---|
| `not_available` | Tool listed in toolset but no scheduler wired (e.g. `ethos chat` profile) | Run from `ethos gateway` or `ethos serve` |
| `input_invalid` | Cron expression failed `isValidCronExpression` | Fix the 5-field syntax; reject DST-ambiguous slots |
| `input_invalid` | Missing required field (`name`, `schedule`, `prompt`, or `id`) | Provide it |
| `not_available` | `delete_cron_job` / `pause_cron_job` / `resume_cron_job` / `run_cron_job_now` called with unknown id | Run `list_cron_jobs` first; ids are short-lived in tests, durable in prod |
| `execution_failed` | `run_cron_job_now` and the agent's run produces an error event | Investigate the prompt or model; the failure is in the agent, not the scheduler |

## Examples {#examples}

### Morning briefing {#example-morning-briefing}

```text
create_cron_job({
  name: "Morning briefing",
  schedule: "0 8 * * 1-5",          // weekdays at 8 am
  prompt: "Summarise overnight Slack alerts, the deploy log, and pending PRs.",
  personality: "engineer",
  deliver: "telegram"
})
```

Result: a recurring job runs every weekday at 8 am, fires the prompt under the engineer personality, and posts the output to the configured Telegram delivery.

### Operator inventory {#example-inventory}

```text
list_cron_jobs()
```

Returns the full inventory — useful before suggesting a new job to avoid duplication, or before pausing a noisy one.

### Pause-instead-of-delete {#example-pause}

```text
1. list_cron_jobs()                            → find id "job-abc"
2. pause_cron_job({ id: "job-abc" })           → reversible stop
3. (after the underlying need has passed)
   delete_cron_job({ id: "job-abc" })          → permanent removal
4. // OR
   resume_cron_job({ id: "job-abc" })          → un-pause
```

Use pause for "I don't need this right now"; reserve delete for "this job's purpose is gone".

### Test a job before scheduling it {#example-test}

```text
1. create_cron_job({ name: "Test", schedule: "0 0 31 12 *", prompt: "..." })
   // Future date so it doesn't auto-fire; we want to test manually first.
2. list_cron_jobs()                            → find the new id
3. run_cron_job_now({ id: <id> })              → fires immediately, returns output
4. (if output is what you want)
   delete_cron_job({ id: <id> })
   create_cron_job({ ... real schedule ... })  // with the real cadence
```

`run_cron_job_now` is the "dry run" path — fire once, inspect, then commit to a real schedule.

## See also {#see-also}

- [`@ethosagent/cron` package](https://github.com/MiteshSharma/ethos/tree/main/packages/cron) — the scheduler implementation.
- [`tool-shape` decision](../explanation/tool-shape.md) — cron is split into 6 tools rather than unified; the doc explains the heuristic.
- [`send_message` reference](messaging-tools.md) — pair with `create_cron_job` to schedule cross-channel notifications.
- [CLI reference](../../using/reference/cli.md) — `ethos cron list / pause / resume / delete / run / create` for the operator-driven side of the same store.
