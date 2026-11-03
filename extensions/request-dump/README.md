# @ethosagent/request-dump

## Purpose

An append-only JSONL store for LLM request dumps. `JsonlRequestDumpStore` writes one record per line into a daily file, rotates by size, and reads back the most recent records with optional session and time filters. It stores and reads records only; deciding what to record is left to the caller.

## Public surface

Single entry point `.` (`src/index.ts`).

| Export | Kind | One line |
|---|---|---|
| `JsonlRequestDumpStore` | class | `RequestDumpStore` writing `requests-<date>.<seq>.jsonl` files under a directory. |

Constructor takes `{ dir, maxBytes? }`; the default rotation size is 10 MiB. `recent()` strips `system`, `tools`, `messages` and `responseText` unless `includeContent` is set.

## Seam

Implements `RequestDumpStore` from `@ethosagent/types` (`packages/types/src/observability.ts`; `implements` on `JsonlRequestDumpStore` in `src/index.ts`). Layer `extensions`. It uses raw `node:fs` and is listed in the allow-list in `apps/ethos/src/__tests__/no-raw-fs.test.ts`, which is the test that pins that exception. Limitation: no test in this package pins rotation or filtering behaviour.

## Testing

```
pnpm vitest run extensions/request-dump
```

No tests in this package.
