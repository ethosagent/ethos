# @ethosagent/watchers

## Purpose

Declarative watcher primitives. A watcher is a deterministic differ over a file, HTTP endpoint, RSS feed or process, with persisted last-seen state, ticking as a system job on the existing cron scheduler with no LLM involved. On a change `WatcherManager` calls injected `deliver` and `wake` callbacks, which wiring binds to the gateway send path and to lane message synthesis. It adds no dedup of its own and holds no scheduler or gateway dependency.

## Public surface

Single entry point `.` (`src/index.ts`).

| Export | Kind | One line |
|---|---|---|
| `WatcherManager` | class | Creates, ticks, pauses, resumes and removes watchers; persists `watchers.json` through `Storage`. |
| `WatcherManagerConfig` | type | `storage`, `deliver`, `wake`, `deliveryGate`, `targetAudience`, `fetchFn`, `processProbe`. |
| `WatcherSchedulerPort` | type | Structural slice of the cron scheduler the manager drives. |
| `WatcherDeliveryGate` | type | Structural outbound-policy questions asked before every delivery. |
| `WatcherRecord` | type | One stored watcher. |
| `WatcherCreateInput` | type | Input to create a watcher. |
| `WatcherKind` | type | `file`, `http`, `rss` or `process`. |
| `WatcherOnChange` | type | `deliver` and/or `wake` target. |
| `WatcherOwner` | type | The agent turn that created a watcher, with its room audience. |
| `WatcherLimits` | type | `expiresAt`, fire budget and cooldown. |
| `WatcherWakeEvent` | type | Payload handed to `wake`. |
| `validateWatcherInput` | function | Rejects malformed input and limits. |
| `effectiveMaxFires` | function | Fire budget after defaults and the agent ceiling. |
| `isForeignDeliverForGatedOwner` | function | True when a delivery would publish a gated personality's output to a third party. |
| `WATCHER_SYSTEM_TASK` | const | The `watcher-tick` system task name. |
| `MIN_INTERVAL_SECONDS` | const | 60. |
| `DEFAULT_WATCHER_MAX_FIRES` | const | 20. |
| `MAX_AGENT_WATCHER_FIRES` | const | 100. |
| `MAX_WATCHERS_PER_OWNER` | const | 10. |
| `parseFeedItems` | function | Parses RSS or Atom items. |
| `sha256` | function | Content hash used by the differs. |
| `MAX_SEEN_GUIDS` | const | Cap on remembered RSS GUIDs. |

Also exported: the differ state types (`WatcherState`, `FileWatcherState`, `HttpWatcherState`, `RssWatcherState`, `ProcessWatcherState`, `DiffOutcome`, `ProcessProbe`) and the small result types `WatcherTickResult`, `WatcherStopped`, `WatcherDeliverTarget`, `WatcherWakeTarget`, `WatcherDeliveryWithheld`.

## Seam

Layer `extensions`. It implements no single `@ethosagent/types` interface; it takes `Storage`, `Logger` and `TurnAudience` from it. Wake turns carry a room audience computed by `WatcherManager.wakeAudience`, which fails closed to shared; `src/__tests__/wake-audience.test.ts` pins that. The fire budget, expiry, cooldown, per-owner cap and agent ceiling are pinned by `src/__tests__/limits.test.ts`. The outbound-policy hold is declared structurally (`WatcherDeliveryGate`) and pinned by the `delivery gate` block in `src/__tests__/watchers.test.ts`.

## Testing

```
pnpm vitest run extensions/watchers
```

- `src/__tests__/watchers.test.ts`: input validation, unchanged ticks write no state, file, http, rss and process differs, wake payload, delivery gate, pause and resume, scheduler registration.
- `src/__tests__/limits.test.ts`: fire budget, expiry, cooldown, owner-less watchers stay unlimited, `MAX_AGENT_WATCHER_FIRES` and `MAX_WATCHERS_PER_OWNER`, strict ISO-8601 `expiresAt`, serialized `watchers.json` writes.
- `src/__tests__/wake-audience.test.ts`: ownerless and group-created watchers wake shared, private owner to a DM wakes private, no classifier means shared.
