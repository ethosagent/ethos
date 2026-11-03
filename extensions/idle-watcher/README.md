# @ethosagent/idle-watcher

## Purpose

Answers "is any work in flight in this process?" for a snapshot-and-restore host. It ANDs independent busy checks supplied by the wiring site, so the package imports no other extension. A source it cannot confirm idle counts as busy.

## Public surface

Exported from `src/index.ts` (single `.` entry in `package.json` `exports`). Main entry points; the rest are options and result types.

| Export | Kind | One line |
|---|---|---|
| `IdleWatcherManager` | class | Runs the check loop and decides when the host may be snapshotted. |
| `IdleWatcherManagerConfig` | type | Manager construction options. |
| `IdleWatcherOptions` | type | Threshold, startup cooldown and check interval. |
| `sampleIdle` | function | Polls every `BusySource` and returns one `IdleSample`. |
| `BusySource` | type | A named closure reporting busy or idle. |
| `advanceStreak` | function | Extends or resets the consecutive-idle streak. |
| `streakSatisfied` | function | True once the streak has lasted the idle threshold. |
| `cooldownElapsed` | function | True once the startup cooldown has passed. |
| `evaluateArming` | function | Decides whether the watcher may arm at all. |
| `describeBusy` | function | Human-readable reason from a busy sample. |
| `DEFAULT_IDLE_THRESHOLD_MS` | const | 120000. |
| `DEFAULT_STARTUP_COOLDOWN_MS` | const | 30000. |
| `DEFAULT_CHECK_INTERVAL_MS` | const | 15000. |
| `DEFAULT_CHECK_TIMEOUT_MS` | const | Per-source timeout, 5000. |

## Seam

Not an `@ethosagent/types` contract implementation; it consumes `Logger` and `PauseLifecycle` from `@ethosagent/types` and a structural `BusySource` port. Archcheck layer: `extensions`.

Fail-awake is pinned by `src/__tests__/idle-watcher.test.ts`: a source that throws, rejects or never settles makes the conjunction busy, and every busy source is named.

## Testing

```
pnpm vitest run extensions/idle-watcher
```

Pinning test: `src/__tests__/idle-watcher.test.ts` holds the conjunction in `sampleIdle`, fail-awake on throw, reject and timeout, and the streak and cooldown primitives.
