# @ethosagent/tools-debug

## Purpose

Self-diagnosis tools for an agent: read its own session events, observability traces, recent errors and a doctor health check. Data sources are injected, so the package holds formatting and the shared-session read rule, not storage.

## Public surface

Exported from `src/index.ts` (single entry, no subpaths).

| Export | Kind | One line |
|---|---|---|
| `buildDebugTools` | function | Returns the four debug tools for the given deps. |
| `DebugToolsDeps` | interface | `SessionStore`, optional `ObservabilityStore`, error reader, health check, private-chat set. |
| `buildGetSessionEvents` | function | Builds `get_session_events`. |
| `buildGetObservability` | function | Builds `get_observability`. |
| `buildGetErrorLog` | function | Builds `get_error_log`. |
| `buildRunDoctor` | function | Builds `run_doctor`. |

## Seam

Implements `Tool` from `@ethosagent/types`; reads `SessionStore` and `ObservabilityStore` from the same package and uses `turnWasShared` from `@ethosagent/core`. Archcheck layer: `extensions` (rule `extensions-implement-contracts` in `architecture.config.ts`). Rule `tools-read-env-through-ctx` bans `process.env` in `extensions/tools-*/src/**`, so config arrives through `ctx.*`. Tool conventions: `.claude/rules/providers-and-tools.md`.

## Testing

```
pnpm vitest run extensions/tools-debug
```

Pinning test: `src/__tests__/get-session-events.test.ts` holds that `get_session_events` refuses a session stamped shared from another session, refuses an unstamped group lane, and reads the caller's own shared session, a DM lane, and a group listed in `privateChats`.
