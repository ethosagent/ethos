# @ethosagent/export-langfuse

## Purpose

Exports completed turn traces from the observability database to Langfuse's batch ingestion endpoint. A polling loop claims unexported traces from `SQLiteObservabilityStore`, maps them to Langfuse events, POSTs them, and either stamps them exported or releases the claim. The trace store and the Ethos-side recording live in `extensions/observability-sqlite`.

## Public surface

Single entry point, `src/index.ts` (the only `exports` key in `package.json` is `.`).

| Export | Kind | One line |
|---|---|---|
| `LangfusePollLoop` | class | Self-rescheduling claim, export, stamp-or-release poller; one tick returns a `LangfuseTickResult`. |
| `LangfusePollConfig` | type | Store, credentials, `intervalMs`, `batchSize`, `staleClaimCutoffMs`, `onError`. |
| `LangfuseTickResult` | type | Counts of `exported`, `failed` and `skipped` traces for one tick. |
| `buildLangfuseBatch` | function | Maps one trace into a batch of Langfuse ingestion events. |
| `LangfuseIngestionEvent` | type | One ingestion envelope. |
| `postToLangfuse` | function | POSTs one batch with Basic Auth; reports whether it was fully accepted. |
| `LangfuseClientConfig` | type | `baseUrl`, `publicKey`, `secretKey`. |

The field-by-field mapping, and a note that the legacy ingestion API is deprecated by Langfuse, are in `MAPPING.md` in this directory.

## Seam

No `@ethosagent/types` interface is implemented; the package consumes `SQLiteObservabilityStore` from `@ethosagent/observability-sqlite`. Archcheck layer: `extensions`. Concurrency rests on the store's atomic claim, so two pollers on one file do not export the same trace (`src/__tests__/poller.test.ts`, case `two stores on the same file never claim the same trace`).

Pinned in `src/__tests__/poller.test.ts`: a dead endpoint releases the claim and does not throw; a 207 response with a non-empty `errors` array counts as failure and the trace is not marked exported; an exported trace is not exported again; a stale claim from a crashed poller is reclaimed.

## Testing

```
pnpm vitest run extensions/export-langfuse
```

Pinning tests in `src/__tests__/`: `src/__tests__/mapping.test.ts` (fixture turn maps to the expected batch, error tool calls get an `ERROR` level, platform metadata omitted when absent), `src/__tests__/poller.test.ts` (claim, export, release, skip when spans were pruned).
