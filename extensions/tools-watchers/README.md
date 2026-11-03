# @ethosagent/tools-watchers

## Purpose

Five watcher tools: `watcher_create`, `watcher_list`, `watcher_pause`, `watcher_resume` and `watcher_delete`. They manage watchers on an injected `WatcherManager`; polling and firing belong to `@ethosagent/watchers`. This package adds ownership checks, limits, room-audience stamping and the delivery gate.

## Public surface

Exported from `src/index.ts`, plus subpath `./compose` (`compose`, `WatcherToolsCompose`), a `WiringContext` entry point.

| Export | Kind | One line |
|---|---|---|
| `createWatcherTools` | function | Returns the five watcher tools for a manager. |
| `WatcherToolsOptions` | interface | Outbox gate and allowed-targets reader. |
| `WatcherOutboxGate` | type | Approval outbox contract for deliveries. |

## Seam

Implements `Tool` from `@ethosagent/types`; `compose` takes a `WiringContext`. Archcheck layer: `extensions` (rule `extensions-implement-contracts` in `architecture.config.ts`). Rule `tools-read-env-through-ctx` bans `process.env` in `extensions/tools-*/src/**`, so config arrives through `ctx.*`. Tool conventions: `.claude/rules/providers-and-tools.md`.

## Testing

```
pnpm vitest run extensions/tools-watchers
```

Pinning tests in `src/__tests__/`: `src/__tests__/ownership.test.ts` (a wake naming another personality is refused and stores nothing, another personality's watchers are hidden), `src/__tests__/untrusted-taint.test.ts` (a wake watcher is refused after an untrusted read), `src/__tests__/room-audience.test.ts` (shared turns see only shared watchers), `src/__tests__/outbox-deliver-refusal.test.ts` (foreign deliver targets refused for gated personalities), `src/__tests__/limits.test.ts` (default budget, `max_fires: 0` refused), `src/__tests__/watcher-tools.test.ts` (lifecycle, interval floor, audience stamp).
