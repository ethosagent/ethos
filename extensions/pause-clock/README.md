# @ethosagent/pause-clock

## Purpose

Detects that a snapshot-and-restore pause just ended, from inside the process. `ClockDriftPauseLifecycle` samples the wall clock on an interval and reports a jump above 60 seconds as a pause duration; a control plane or host agent can report a known duration through `notifyResume()` instead. It only measures the pause; what gets corrected is up to the handlers that subscribe.

## Public surface

Single entry point `.` (`src/index.ts`).

| Export | Kind | One line |
|---|---|---|
| `ClockDriftPauseLifecycle` | class | `PauseLifecycle` with `start`, `stop`, `notifyResume`, `onResume` and `readPauseOffset`. |
| `ClockDriftPauseLifecycleOptions` | type | `intervalMs`, `thresholdMs` and an injectable `now`. |
| `ResumeHandler` | type | Callback receiving the drained pause duration in milliseconds. |
| `DEFAULT_DRIFT_INTERVAL_MS` | const | Sampling cadence, 1000 ms. |
| `DEFAULT_DRIFT_THRESHOLD_MS` | const | Drift above 60000 ms in one interval counts as a pause. |

## Seam

Implements `PauseLifecycle` from `@ethosagent/types` (`implements` on `ClockDriftPauseLifecycle` in `src/index.ts`). Layer `extensions`. Its outbound sibling is `@ethosagent/pause-http`; the two are not composed.

## Testing

```
pnpm vitest run extensions/pause-clock
```

`src/__tests__/pause-clock.test.ts` holds: no pause on a cold boot, an explicit resume is consumed on read, two resumes accumulate, non-finite and non-positive durations are ignored, a multi-hour jump is detected, a sub-threshold jump is not pushed, a pushed pause is drained so a later read returns null, a pause stays pending when no handler is registered, one throwing handler does not stop the others, and unsubscribe stops delivery.
