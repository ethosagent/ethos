# @ethosagent/goal-runner

## Purpose

Drives a goal to completion in the background. `GoalRunner` takes a goal from a `LeasedGoalStore`, plans, runs attempts through `AgentLoop`, judges each attempt against the goal's acceptance checks, and retries with reflection until the goal converges, plateaus or exhausts its budget. It also owns run leases, heartbeats and orphan recovery. Persisting goals is the store's job, and channel delivery of notices is `registerGoalNotifications` plus the gateway.

## Public surface

Single entry point, `src/index.ts` (the only `exports` key in `package.json` is `.`). 17 names are exported; the main entry points are below.

| Export | Kind | One line |
|---|---|---|
| `GoalRunner` | class | Methods include `startGoal`, `steer`, `cancel`, `resume`, `judgeAttempt`, `recoverOrphans`, `getRetryContext`, `canExecute`, `shutdown`, `whenIdle`. |
| `GoalRunnerConfig` | interface | Store, `ownerId`, `heartbeatMs`, `staleMs` and the turn callbacks. |
| `LeasedGoalStore` | interface | `GoalStore` plus lease operations: `claimGoal`, `resumeGoal`, `heartbeatGoal`, `interruptStale`. |
| `AcceptanceCheckExecutor` | type | Runs a command-backed acceptance check and returns a `CommandResult`. |
| `registerGoalNotifications` | function | Subscribes goal hooks to a channel send function; returns a cleanup. |
| `judge` | function | Scores an attempt against the acceptance checks and returns a `Verdict`. |
| `isConverged` | function | True when a verdict meets a convergence threshold. |
| `NO_EXECUTOR_EVIDENCE` | const | Evidence text used when no execution backend is wired for command checks. |
| `createLLMCheckJudge` | function | Builds a `CheckJudge` backed by an LLM. |
| `LLMCheckJudgeOptions` | interface | Options for `createLLMCheckJudge`. |
| `classifyFailure` | function | Picks a `RetryStrategy` (`patch`, `pivot` or `clarify`) from the attempt history. |
| `buildRetryContext` | function | Builds the reflection text injected into the next attempt. |
| `CheckJudge` | type | Judge for a check with no command. |

The remaining exports are the `CheckJudgeInput`, `CheckJudgeResult`, `CommandResult` and `RetryStrategy` types.

## Seam

Consumes `GoalStore`, `HookRegistry`, `SteerSink`, `Verdict` and the goal payload types from `@ethosagent/types` (`packages/types/src/goal.ts`), and `withUsageScope` from `@ethosagent/core`. Archcheck layer: `extensions`. Every `AgentLoop.run` it starts is drained past its terminal event, per the non-negotiable in `AGENTS.md`.

Pinned by tests: runs are drained before a failure is recorded (`src/__tests__/turn-tail.test.ts`); a second runner's `recoverOrphans` leaves a goal another runner is executing, and exactly one of two runners resumes a goal (`src/__tests__/lease.test.ts`); a cancelled run unwinding after a resume fails every lease check (`src/__tests__/cancel-lease.test.ts`); two consecutive non-improvements end a goal early, and a substring-fallback verdict never counts as a plateau (`src/__tests__/plateau.test.ts`); attempts launched from inside a tainted context see no link (`src/__tests__/taint-isolation.test.ts`).

## Testing

```
pnpm vitest run extensions/goal-runner
```

Pinning tests in `src/__tests__/`: `src/__tests__/turn-tail.test.ts`, `src/__tests__/lease.test.ts`, `src/__tests__/cancel-lease.test.ts`, `src/__tests__/plateau.test.ts`, `src/__tests__/taint-isolation.test.ts`, `src/__tests__/judge.test.ts` (command-backed and substring checks). The directory also holds tests for planning, recovery, shutdown, halt events and transient retry.
