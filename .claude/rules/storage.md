---
paths:
  - "packages/storage-fs/**"
  - "packages/types/src/storage*.ts"
  - "packages/wiring/src/build-agent-loop.ts"
  - "packages/wiring/src/amendments.ts"
  - "apps/ethos/src/__tests__/no-raw-fs.test.ts"
---

# Storage abstraction

Storage abstraction
All filesystem reads and writes under ~/.ethos/ go through the Storage interface from @ethosagent/types. New code must NOT import from node:fs/promises (or node:fs) for ~/.ethos/ access — wire a Storage in via the constructor.

Turn-scoped Storage carries two floors besides fs_reach. Every `ScopedStorage` (and `ScopedFsImpl`, fed the same predicate) refuses writes to ANY personality's definition entries — `<stateDir>/personalities/<any>/{SOUL.md,config.yaml,toolset.yaml,mcp.yaml,tools.yaml,ETHOS.md,skills/,commands/,.expression-history/}` and the global `<stateDir>/{skills,commands}/` — via `personalityDefinitionFloor` (packages/storage-fs/src/sensitive-paths.ts, predicate `isPersonalityDefinitionPath` in @ethosagent/types), and `learning/` and the operator policy files (`constitution.yaml`, `evolve-config.json`, `allowlist.json`, `approval-leases.json`) are on the state-dir deny list (reads and writes). Both floors cover the wired `dataDir` beside `~/.ethos` and `ETHOS_STATE_DIR`: a new `ScopedStorage` construction in wiring passes `defaultAlwaysDeny([dataDir])` and `stateDirs: [dataDir]` (`shippedScopedStorageFactory`, packages/wiring/src/build-agent-loop.ts; pinned by `packages/wiring/src/__tests__/custom-datadir-floor.test.ts`). A turn changes its own definition only through `propose_self_amendment` → a pending record in `learning/amendments/` → a human applying it with `ethos personality amendments apply` (`createAmendmentIntake` / `createAmendmentService`, packages/wiring/src/amendments.ts; nothing applies itself — pinned by `packages/wiring/src/__tests__/amendments.test.ts`). The tool is opt-in: `buildPersonalityToolExclude` (packages/wiring/src/build-agent-loop.ts) is always defined and hides `propose_self_amendment` from any personality whose `toolset.yaml` does not list it, so other personalities' prompts are byte-identical (`packages/wiring/src/__tests__/amendment-exclude.test.ts`). Limitation: a personality with a shell tool on local execution can still edit files directly; `ETHOS_TOOL_PROCESS=1` in tool-spawned processes is a tripwire for the CLI, not a boundary.

Implementation	Where it lives	When to use
FsStorage	@ethosagent/storage-fs	Production wiring (CLI, web-api, gateway)
InMemoryStorage	@ethosagent/storage-fs	Tests — populate fixtures via write(), no tmpdir scaffolding
ScopedStorage	@ethosagent/storage-fs	Decorator — enforces a per-personality read/write path allowlist
Allowed exceptions (these stay raw node:fs):

Error contract: read/exists/mtime return null for missing paths (common case, not exceptional). Everything else throws. ScopedStorage throws BoundaryError (also exported from @ethosagent/types) when a path is outside the allowlist; surfaces translate it into a user-facing tool error.

Atomicity: use writeAtomic for any file where a partial write would corrupt state (config, keys, audit logs). It's a separate method, not an option, to prevent the "did the writer remember?" footgun.

See plan/storage_abstraction.md for the full migration plan (4 phases) and the Storage interface spec.
