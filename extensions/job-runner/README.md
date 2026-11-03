# @ethosagent/job-runner

## Purpose

Runs background jobs claimed from a `JobStore`. `BackgroundExecutor` owns the pool, heartbeats, cancel and cost-breach handling, shutdown hand-off and completion callbacks; `EthosJobRunner` is the default in-process runner that drives a child `AgentLoop` turn. Persisting job rows is left to `extensions/job-store`.

## Public surface

Exported from `src/index.ts` (single `.` entry in `package.json` `exports`).

| Export | Kind | One line |
|---|---|---|
| `BackgroundExecutor` | class | Claims queued jobs, runs them in a bounded pool, heartbeats, drains and shuts down. |
| `BackgroundExecutorConfig` | interface | Pool size, stale and heartbeat timings, queue TTL, spend cap, retention. |
| `BackgroundExecutorDeps` | interface | `JobStore`, `AgentLoop`, optional runner registry, owner. |
| `EthosJobRunner` | class | Default `JobRunner`; runs the job as a child loop turn. |
| `ETHOS_RUNNER_NAME` | const | Name of the default runner. |
| `jobRoomAudience` | function | Resolves a job's room audience from its stamp or origin. |
| `narrowedToolset` | function | Intersects the personality toolset with the parent turn's narrowing. |
| `JOB_ABORTED_BY_SHUTDOWN` | const | Error reason that distinguishes shutdown from cancel. |
| `BoundedLogBuffer` | class | Capped runner log lines. |
| `RunnerLogLine` | type | One buffered log line. |
| `SUMMARY_INSTRUCTION` | const | Prompt suffix asking the child for a summary section. |

## Seam

`EthosJobRunner` implements `JobRunner` from `@ethosagent/types` (`implements JobRunner` in `src/ethos-job-runner.ts`). Depends on `@ethosagent/core` for `AgentLoop`. Archcheck layer: `extensions`.

Pinned guarantees:

- A job stamped shared runs shared, an unstamped group-origin job fails closed to shared (`src/__tests__/room-audience.test.ts`).
- The child turn is drained past `done`, so the turn-end tail runs before the job finishes (`src/__tests__/turn-tail.test.ts`).
- Taint from untrusted reads reaches the review turn and does not leak into an unrelated job (`src/__tests__/untrusted-taint.test.ts`, `src/__tests__/taint-isolation.test.ts`).
- The child keeps the parent's tool narrowing (`src/__tests__/toolset-narrowing.test.ts`). Limitation documented there: an exclusion cannot be subtracted from an unrestricted toolset.

## Testing

```
pnpm vitest run extensions/job-runner
```

Pinning tests in `src/__tests__/`: `src/__tests__/executor.test.ts` (claim, cost breach, cancel, parked runs, pool size, boot sweep, shutdown, drain, `onComplete`), `src/__tests__/room-audience.test.ts`, `src/__tests__/turn-tail.test.ts`, `src/__tests__/untrusted-taint.test.ts`, `src/__tests__/taint-isolation.test.ts`, `src/__tests__/toolset-narrowing.test.ts`.
