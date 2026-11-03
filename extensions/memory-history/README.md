# @ethosagent/memory-history

## Purpose

Append-only provenance log for memory mutations. `HistoryMemoryProvider` decorates a memory provider and records one labelled entry per mutated key, with before and after hashes, an inline diff, and a content-addressed blob when the diff exceeds a cap, so pre-mutation content stays recoverable. Approval, capture and consolidation policy are left to neighbouring packages.

## Public surface

Exported from `src/index.ts` (single `.` entry in `package.json` `exports`).

| Export | Kind | One line |
|---|---|---|
| `HistoryMemoryProvider` | class | Memory decorator that records history on writes and passes reads through. |
| `withHistory` | function | Wraps a provider in the decorator. |
| `WithHistoryOptions` | interface | Decorator options. |
| `HistoryStore` | class | Writes and reads the history file and blobs. |
| `HistoryStoreOptions` | interface | Data dir, storage and `diffCapBytes`. |
| `RecordInput` | interface | One mutation to record. |
| `HistoryEntry` | interface | One log entry. |
| `HistoryReadFilter` | interface | Filter for reading history. |
| `HistoryReadResult` | interface | Entries oldest first plus a `corruptLines` count. |
| `HistorySource` | type | Origin label: tool, consolidation, dream, capture, web-editor, global-entry, restore. |
| `HISTORY_FILE` | const | History file name. |
| `BLOB_DIR` | const | Blob directory name. |

## Seam

`HistoryMemoryProvider` implements `MemoryProvider` and `GlobalMemoryStore` from `@ethosagent/types` (`implements MemoryProvider, GlobalMemoryStore` in `src/decorator.ts`). Contract rules in `.claude/rules/memory.md`. Archcheck layer: `extensions`.

Pinned by `src/__tests__/decorator.test.ts` (a decorated sync writes the same file content as the raw provider; reads pass through; a failed atomic global write leaves the original intact), `src/__tests__/history-store.test.ts` (no-op mutations are skipped; diff cap boundary is strict) and `src/__tests__/recover.property.test.ts` (before-state recoverable across the cap).

## Testing

```
pnpm vitest run extensions/memory-history
```

Pinning tests in `src/__tests__/`: `src/__tests__/decorator.test.ts`, `src/__tests__/history-store.test.ts`, `src/__tests__/integration.test.ts` (one correctly labelled entry per source), `src/__tests__/recover.property.test.ts`.
