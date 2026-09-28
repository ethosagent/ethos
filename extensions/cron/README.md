# @ethosagent/cron

File-locked cron scheduler that ticks every 60 seconds, persists jobs to `<cronDir>/jobs.json`, and writes each run's output to a per-job markdown file.

## Why this exists

Ethos personalities can schedule recurring work (morning briefings, periodic syncs, end-of-day digests). A heavyweight scheduler service is overkill — this is a single-process, file-backed scheduler that survives restarts, handles missed runs, and is safe to mutate concurrently from the CLI and the running agent.

## What it provides

- `CronScheduler` — the service. `start()` / `stop()` lifecycle, `createJob` / `listJobs` / `getJob` / `deleteJob` / `pauseJob` / `resumeJob` / `runJobNow` mutation methods. Constructor takes a `runJob` callback that the host (CLI wiring) supplies to actually execute the prompt against an `AgentLoop`.
- `CronJob`, `CronRunResult`, `CronSchedulerConfig`, `MissedRunPolicy`, `JobStatus` — types consumed by `@ethosagent/tools-cron` and the CLI.
- `isValidCronExpression(expr)` — predicate over `croner`'s `Cron` constructor.
- `nextRun(schedule)` / `nextRunAfter(schedule, after)` — date helpers used both internally and by the CLI to display next-run hints.

## How it works

`start()` (`src/index.ts:98`) fires `tick()` immediately (so missed-run jobs catch up on launch) and then schedules `setInterval(tick, tickIntervalMs)`. `tick()` (`src/index.ts:179`) reads the current `jobs.json`, walks every active job, compares `nextRunAt` to now, and either skips (advancing `nextRunAt` via `nextRunAfter`) or executes via `executeJob`, depending on `missedRunPolicy`.

`executeJob` (`src/index.ts:220`) calls the host-supplied `runJob` callback, then writes the output to `<cronDir>/output/<job-id>/<timestamp>.md`. Timestamps in filenames have `:` and `.` replaced with `-` so they're safe on every filesystem.

All mutations to `jobs.json` go through `withJobsLock` → `withLock` (`src/index.ts:49`), which uses `open(lockPath, 'wx')` — exclusive create — as an atomic primitive. If another process holds the lock, the caller spins for up to 5 seconds at 100ms intervals, then throws. The lock file is unlinked in `finally` even when the operation throws (`src/index.ts:68`).

Job ids are derived from `name` via `slugify` (`src/index.ts:305`) — lowercase, non-alphanumeric runs collapsed to `-`, trimmed, capped at 64 chars. `createJob` rejects duplicates so name collisions surface immediately.

## Gotchas

- The `runJob` callback is **required** in `CronSchedulerConfig` (`src/index.ts:38`); without it the scheduler is unusable. The CLI wires this to invoke `AgentLoop.run`.
- `tick()` swallows missing-`jobs.json` errors silently (`src/index.ts:184-187`) and per-job failures are logged with `console.error` and then ignored. This package is one of the three allowed lingering `console.warn` / `console.error` per the root CLAUDE.md.
- The `withLock` retry loop is **5 seconds at 100ms** — a stuck lock (e.g. from a crashed process that left the file behind) will block writes until you remove `<cronDir>/jobs.json.lock` manually.
- `nextRunAt` is recomputed only after a tick fires or via `pauseJob`/`resumeJob`. If the system clock jumps backwards, jobs may re-fire; if it jumps forward, the missed-run policy applies.
- `executeJob` writes the output file even when `runJob` returns an empty string — there is no "empty output, skip writing" branch. An empty output is never DELIVERED, though (`persistAndDeliver`).
- A `runJob` that throws is a failed run: `lastError` is set, `runCount` is not bumped, a job with no later occurrence (a one-shot) is paused instead of retired (`resumeJob` makes it due again), and a prompt job with an `origin` sends its chat one failure notice per `CRON_FAILURE_NOTICE_INTERVAL_MS` (`recordRunFailure`). Pinned by `src/__tests__/run-integrity.test.ts`.
- A job never executes twice at once: a fresh `runningSince` stamp makes the due-scan skip the occurrence (with an `[skipped: overlap]` run record) and makes `runJobNow` throw (`isRunning`, `claimDueJob`). A turn abandoned at `maxRunMs` keeps its stamp until its promise settles.
- The `skip` policy treats an occurrence as missed only past `max(tickIntervalMs, observed fire cadence) + tickIntervalMs`, never while the job is deferred by `maxParallelJobs`, and every skip leaves a `[skipped: missed …]` run record; a missed one-shot is retired with `lastError` and a notice to its origin (`skipMissed`).
- Both skips also reach `onDecision`, as action `missed` or `overlap-skip`, so hosts that forward it to `recordHeartbeatDecision` record them in `observability.db` as `heartbeat.decision` events. Pinned by "UBP-027 — skips reach onDecision" in `src/__tests__/run-integrity.test.ts`.
- `CronRunResult.output` is the final answer only (delivered, and tested for `[SILENT]`); `CronRunResult.transcript`, when a host sets it, is what the run file keeps.
- Cron expressions are interpreted in the host process's local timezone via `croner`. There is no per-job timezone field.
- The single-process lock model means running two `ethos` processes on the same cron directory is supported for **mutations** (the lock makes them safe) but both will tick — every job will run twice. Run only one cron-enabled process per cron dir.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | `CronScheduler` class, `withLock` helper, cron expression helpers (`isValidCronExpression`, `nextRun`, `nextRunAfter`), and the `CronJob` / `CronRunResult` / `CronSchedulerConfig` / `MissedRunPolicy` / `JobStatus` types. |
| `src/__tests__/` | Vitest coverage for tick behaviour, missed-run policies, and lock contention. |
