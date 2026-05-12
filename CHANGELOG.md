# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Breaking changes

- **`MemoryProvider` now requires five methods.** The contract is `prefetch`, `read`, `search`, `sync`, `list`. Any direct constructor caller of `MarkdownFileMemoryProvider` or `VectorMemoryProvider` using the old two-method shape must update to the new five-method interface. The drift gate test (`packages/types/src/__tests__/memory-method-count.test.ts`) enforces this mechanically.

### New

- **Team memory tools** — `team_memory_read`, `team_memory_write`, `team_memory_search` registered in `@ethosagent/tools-memory` under the `team_memory` toolset. Team memory is seeded at `~/.ethos/teams/<id>/memory/`; each topic is a separate markdown file.
- **Policy decorators** — `EagerPrefetchPolicy`, `LazyOnDemandPolicy`, `LastWriteWinsPolicy` in `@ethosagent/core`. Personality scope uses `EagerPrefetchPolicy`; team scope uses `LazyOnDemandPolicy(LastWriteWinsPolicy(...))`.
- **`MemoryConflictError`** — thrown by `LastWriteWinsPolicy` when a concurrent write is detected. Exported from `@ethosagent/types`. Callers may catch and retry after re-reading the affected key.
