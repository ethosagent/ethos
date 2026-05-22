# @ethosagent/tools-cron

A single action-dispatch `cron` tool that lets an agent create, list, get, read run output, update, pause, resume, run, and remove scheduled jobs managed by `@ethosagent/cron`.

## Capabilities

The tool declares empty capabilities (`{}`). It uses framework-provided domain stores and requires no direct side-effect access.

## Why this exists

The `@ethosagent/cron` package is the scheduler service — it owns `jobs.json` and the 60-second tick. This package is the thin tool surface the LLM sees. Splitting them keeps the scheduler usable from non-LLM contexts (CLI, daemons, tests) while still giving personalities a way to schedule work via natural language.

## Tool provided

| Tool name | Toolset | Purpose |
|---|---|---|
| `cron` | `cron` | Single action-dispatch tool for all cron operations: `create`, `list`, `get`, `read_run`, `update`, `pause`, `resume`, `run`, `remove`. |

## How it works

`createCronTool(scheduler)` (`src/index.ts`) returns a single-element `Tool[]` containing the `cron` tool, closing over the `CronScheduler` instance. The scheduler is constructed in `apps/ethos/src/wiring.ts` and shared with the cron service so tool-driven mutations and tick-driven runs operate on the same `jobs.json`.

The `action` field dispatches to per-action handlers. `create` validates the cron expression with `isValidCronExpression` from `@ethosagent/cron` and always pins the job to the caller's personality. `get` returns full job detail plus recent run timestamps. `read_run` reads the output of a specific historical run. `update` is not yet implemented (Phase C). `run` caps output at 10 KB via `maxResultChars`.

A backward-compat alias `createCronTools` is also exported.

## Gotchas

- The tool assumes the caller's `CronScheduler` is already started; this package never calls `scheduler.start()`.
- Job ids are derived from `name` via `slugify` inside `@ethosagent/cron` — two jobs with names that slugify to the same id will conflict on create.
- `create` always pins to `ctx.personalityId` — no cross-personality scheduling.
- All schedules are interpreted in the host's local time — there is no `timezone` option.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | Single `cron` tool factory + per-action handlers + `formatJob` helper, returned by `createCronTool(scheduler)`. |
