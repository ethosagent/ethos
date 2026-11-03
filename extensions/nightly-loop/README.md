# @ethosagent/nightly-loop

## Purpose

The nightly governed-learning pass and the memory consolidation it runs. `runNightlyPass` runs six checkpointed steps for one personality (gather evidence, judge alignment, maybe draft an Expression, maybe create skills, replay learning candidates, consolidate memory) with every external effect injected. The memory side decays, archives, restores, supersedes and retracts sections of `MEMORY.md`. Promotion itself is left to `extensions/learning-inbox`.

## Public surface

Exported from `src/index.ts` (single `.` entry in `package.json` `exports`). Main entry points; the rest are option and result types.

| Export | Kind | One line |
|---|---|---|
| `runNightlyPass` | function | Runs the six steps for one window, skipping steps already completed for that window. |
| `NightlyPassDeps` | interface | Injected effects for each step. |
| `NightlyPassResult` | interface | Per-step outcome of a pass. |
| `NightlyState` | interface | Checkpoint of completed steps for a window. |
| `casePoolOverflowNotice` | function | Message when the replay case pool overflows. |
| `consolidateMemory` | function | LLM-distils `MEMORY.md` and `USER.md` into scored sections. |
| `buildConsolidationUpdates` | function | Turns a consolidation result into memory updates. |
| `planConsolidation` | function | Pure decay plan: which sections are kept or archived. |
| `resolveDecayParams` | function | Applies decay defaults and overrides. |
| `DEFAULT_DECAY_CONFIG` | const | Default decay settings. |
| `parseMemoryMeta` | function | Reads per-slug bookkeeping. |
| `formatArchiveBlock` | function | Renders an archived section. |
| `parseArchiveBlocks` | function | Reads archived sections back. |
| `supersedeSlug` | function | Moves a section to the archive in favour of a newer one. |
| `retractSlug` | function | Archives a section and tombstones its facts. |
| `restoreArchivedSlug` | function | Restores an archived section by slug. |

## Seam

A pure, dependency-injected pipeline over `@ethosagent/types` and `@ethosagent/personality-judge`; it implements no types interface. Archcheck layer: `extensions`.

Pinned by `src/__tests__/orchestrator.test.ts` (re-running the same window skips completed steps; a fresh window resets the checkpoint; memory consolidation still runs when the judge has insufficient data), `src/__tests__/memory-decay.test.ts` (USER.md exempt from decay; `lastSeen` kept across a reword), `src/__tests__/decay-integration.test.ts` (every pre-run byte stays recoverable and restore round-trips) and `src/__tests__/memory-lifecycle.test.ts` (retract archives and tombstones; read-modify-write keeps other slugs' bookkeeping).

## Testing

```
pnpm vitest run extensions/nightly-loop
```

Pinning tests in `src/__tests__/`: `src/__tests__/orchestrator.test.ts`, `src/__tests__/memory-consolidation.test.ts` (parsing and degradation to `scored=false`), `src/__tests__/memory-decay.test.ts`, `src/__tests__/memory-lifecycle.test.ts`, `src/__tests__/decay-integration.test.ts`.
