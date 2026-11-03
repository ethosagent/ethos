# @ethosagent/pause-http

## Purpose

The outbound half of a snapshot-and-restore deployment. `HttpPauseLifecycle` POSTs to an orchestrator URL when the idle watcher decides the process is safe to suspend. It only signals readiness; the orchestrator decides what happens next, and detecting a resume is left to `@ethosagent/pause-clock`.

## Public surface

Single entry point `.` (`src/index.ts`).

| Export | Kind | One line |
|---|---|---|
| `HttpPauseLifecycle` | class | `PauseLifecycle` whose `signalReadyToSuspend` POSTs to the orchestrator; `readPauseOffset` always resolves `null`. |
| `HttpPauseLifecycleOptions` | type | `url`, optional `token`, `timeoutMs` (default 5000) and an injectable `fetchImpl`. |

## Seam

Implements `PauseLifecycle` from `@ethosagent/types` (`implements` on `HttpPauseLifecycle` in `src/index.ts`). Layer `extensions`. The class throws on any failure (non-2xx, network error, timeout) and has no retry or logger, as pinned by `src/__tests__/pause-http.test.ts`; the idle-watcher caller handles the retry.

## Testing

```
pnpm vitest run extensions/pause-http
```

`src/__tests__/pause-http.test.ts` holds: a 200 resolves, a non-2xx throws, a rejected fetch throws, `readPauseOffset` is always null, `hostSignalAvailable` is true, the bearer header is sent only when a token is given, and an `AbortSignal` is passed for the timeout.
