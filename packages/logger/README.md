# @ethosagent/logger

## Purpose

Default implementations of the `Logger` interface from `@ethosagent/types`: a silent `NoopLogger` for library code and a `ConsoleLogger` that routes records to `console.*` for app entry points, with a minimum-level gate.

## Public surface

| Export | Kind | One line |
|---|---|---|
| `NoopLogger` | class | Logger that emits nothing. |
| `noopLogger` | const | Shared `NoopLogger` instance. |
| `ConsoleLogger` | class | Logger that writes to `console.*`, gated by level. |

## Seam

Implements `Logger` from `@ethosagent/types`; supports ARCHITECTURE.md section III, Law 10 (library code is silent). Archcheck layer: `support`. `ConsoleLogger.emit` is the console sink and holds exception EX-002 for rule `l10-silent-libraries` in `architecture.config.ts`.

## Testing

```
pnpm vitest run packages/logger
```

Pinning tests:
- `src/__tests__/logger.test.ts`: `NoopLogger` and `ConsoleLogger` behaviour.
