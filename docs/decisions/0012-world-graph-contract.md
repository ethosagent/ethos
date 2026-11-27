# ADR 0012 — The world graph is a new contract, and `worlds` joins the protected paths

## Status

Proposed, 2026-11-28. Not approved. The approvals this record needs are listed under [Approvals](#approvals) and both are outstanding. Nothing in it is implemented: the plan is `plan/phases/world-model.md` (Task 0.1 files this record), and every test named below as "planned" does not exist yet. Until a named test exists and passes, its row is a plan, not a guarantee.

The RFC for the contract type itself is [Why is the world graph a new contract type?](../content/building/explanation/world-graph-governance.md). This record covers the contract roster entry, the two safety-path entries, and the decisions the plan takes.

## Context

Ethos is adding a **world**: a typed graph of the things agents work with and the links between them. Every fact records when it was true, when Ethos learned it, its source and its author. Facts are closed, never overwritten. A personality has a private world and can mount shared worlds that several personalities read; on a shared world agents only propose. The graph sits beside memory and does not replace it.

The change touches these parts of ARCHITECTURE.md. Each is listed with what it means here.

| Part | What the plan touches |
|---|---|
| §II Runtime boundary | Three new packages sit in the `extensions` layer. The contract sits in `contracts` (`packages/types`). Composition sits in `wiring`. No layer is added or moved. |
| Law 3, wiring is the only composition root | `packages/wiring/src/worlds.ts` is the only place `world-service`, `tools-world` and the backend meet. `world-service` and `tools-world` never import `world-sqlite`. |
| Law 4, extensions implement contracts | `extensions/world-sqlite` implements `WorldGraphProvider`. Sibling edges between the new packages are allowed; reaching wiring or apps is not. |
| Law 7, Storage guards the personality boundary | `schema.yaml`, `world.yaml` and `worlds.yaml` are written through `Storage` (`writeAtomic`) by one service each. SQLite files go through `@ethosagent/sqlite`, not raw `node:fs`. |
| Law 10, library code is silent | None of the new packages uses `console.*`. Errors go to an injected `Logger` or `onError`. |
| Law 11, kernel guarantees are not weakenable from outside | A graph backend is an extension. It must not be able to accept a proposal, skip the audience rule, or write a protected file. Those checks live above the contract and in the kernel floors below. |
| S1, the toolset is the sole authority | The ten `world_*` tools are ordinary tools in toolset group `world`. A personality gets them only when its `toolset.yaml` lists them. A mount grants data access, not tools. |
| S6, retrieved text passes injection | Core sanitises only the memory snapshot. `WorldContextInjector` calls the injected `AgentSafety.injection.sanitize` itself (Task 4.4). |
| S7, boundary errors are user-facing | A refused world access returns a typed error code (`WORLD_REQUIRED` on an ambiguous write, an access error on an unmounted world), never a silent empty result. |
| S9, secrets live only in SecretsResolver | `vetFact` (Task 2.4) refuses to store a secret or sensitive value as an agent fact. Pinned by `fact-vetting.test.ts` R11 (planned). |
| §VI Change governance | Adding a contract type is a **Structural** amendment: RFC, unanimous maintainers, validator update in the same PR, migration note. Touching a safety path needs maintainer review. |
| §VII Frozen schemas | `WorldGraphProvider` joins the roster with a method-count gate of 13. `PersonalityConfig` does not change. |

Rules that already exist and are reused, not changed: G-MEM (`docs/content/security/security-boundary.md`), which keeps private memory out of shared turns, and its resolver `resolveTurnAudience` (`packages/core/src/agent-loop/audience.ts`).

## Decision

### 1. `worlds` joins the turn deny list

Add `'worlds'` to `STATE_DIR_DENY_ENTRIES` in `packages/storage-fs/src/sensitive-paths.ts`, and extend the comment block above it.

- **Guarantee it buys.** No turn reads or writes `<dataDir>/worlds/` through a file tool: not `<world>/schema.yaml`, `<world>/world.yaml`, `graph.db` or `service.db`. A turn that could write `schema.yaml` could change what an agent believes an entity type is. A turn that could read `graph.db` could read an `owner_only` world inside a shared room, bypassing the audience rule. The entry closes both. The deny list covers reads and writes, as it does for `learning` and `channels`.
- **Enforcer.** The deny list, applied to turn Storage by `shippedScopedStorageFactory` (`packages/wiring/src/build-agent-loop.ts`) through `ScopedStorage` (`packages/storage-fs/src/scoped-storage.ts`), with the entries listed in `packages/storage-fs/src/sensitive-paths.ts`. The only writers are services holding compose-time Storage: `WorldSchemaService` for `schema.yaml` and `WorldConfigService` for `world.yaml`.
- **Test that pins it.** R4, `packages/wiring/src/__tests__/world-floor.test.ts`, test `'R4 file tools cannot write worlds/ or worlds.yaml'`. **Planned, lands in Task 2.5. It does not exist yet.** It also runs on a custom `dataDir`, following the `custom-datadir-floor.test.ts` pattern.

### 2. `worlds.yaml` joins the personality definition write floor

Add `'worlds.yaml'` to `PERSONALITY_DEFINITION_ENTRIES` in `packages/types/src/personality-definition.ts`.

- **Guarantee it buys.** A personality cannot mount a world by writing its own sidecar `personalities/<id>/worlds.yaml`. A mount works only when the personality's `worlds.yaml` and the world's own `world.yaml` (`readers` / `proposers`) agree, and the first file would otherwise be agent-writable. The floor applies to every personality's directory, so one personality cannot write another's mounts either. It is a write floor only: a turn may read `worlds.yaml`.
- **Enforcer.** `isPersonalityDefinitionPath` (`packages/types/src/personality-definition.ts`) and `personalityDefinitionFloor` (`packages/storage-fs/src/sensitive-paths.ts`). The only writer is `WorldConfigService`, which holds compose-time Storage. The rule that both files must agree is `resolveAccess` rule 2 (`world-access.test.ts` R7, planned, Task 2.1).
- **Test that pins it.** The same R4 test above, `'R4 file tools cannot write worlds/ or worlds.yaml'`, covers the write refusal and the read that still succeeds. **Planned, Task 2.5, not yet existing.**

### 3. Agents reach schema and facts only through `WorldService`

The deny list costs no feature. An agent never needs a file tool for the graph: it reads and proposes through the `world_*` tools, which call `WorldToolPort`, which calls `WorldService`. `WorldService` applies mounts, the audience rule, write routing and proposals, then calls the backend. A schema change goes through `WorldSchemaService.requestChange`. A mount change goes through `WorldConfigService`, reached from web-api and the CLI only. Pinned by `world-port.test.ts` R13 (planned, Task 2.4) and `worlds-wiring.test.ts` (planned, Task 4.6).

### 4. Every row of "Contract / frozen-schema changes"

| Change | Why | Gate | Task |
|---|---|---|---|
| New contract file `packages/types/src/world-graph.ts` | Pluggable backends need a stable surface; `MemoryProvider` is key/value text and is frozen. | §VI Structural (new contract type): RFC + unanimous maintainers | 0.1, 1.1 |
| `WorldGraphProvider` on the §VII roster with a method-count gate | Neo4j, Graphiti and Kuzu adapters are written against it. | §VII roster row; O-8. Gate: `packages/types/src/__tests__/world-graph-method-count.test.ts`, `'world-graph method count is 13'` (lands in Task 1.1) | 0.1, 1.1 |
| `'worlds'` in `STATE_DIR_DENY_ENTRIES` | No turn reads or writes `schema.yaml`, `world.yaml`, `graph.db` or `service.db` raw. | Security kernel (`packages/storage-fs`); Law 11 | 2.5 |
| `'worlds.yaml'` in `PERSONALITY_DEFINITION_ENTRIES` | A personality cannot mount worlds by writing its own sidecar. | Safety module in `packages/types`; Law 7, Law 11 | 2.5 |
| `UsageSourceKind += 'world_extract'` | Extraction spend shows under its own source. | `packages/types` change (O-6) | 6.2 |
| `share_links.kind` column | World snapshots. | Not frozen; the share-links FULL posture is unchanged | 7.6 |
| Two register rows | Rule 12: a guarantee names its enforcer. | `scripts/check-architecture.mjs` | 2.5 |

Not a change: `PersonalityConfig` (`.personality-field-count` does not move), `MemoryProvider` (method count unchanged), `AgentEvent`, `Tool`, `Storage`, the plugin contract, `PromptContext`.

### 5. Packages and layers

Three new packages, all in the existing `extensions` layer:

- `extensions/world-sqlite`: the built-in backend. STRICT tables in `<dataDir>/worlds/graph.db`.
- `extensions/world-service`: `WorldService`, `WorldSchemaService`, `WorldConfigService`, codecs, extraction router and `WorldContextInjector`. Its own STRICT store is `<dataDir>/worlds/service.db`.
- `extensions/tools-world`: the ten `world_*` tools.

They match `extensions/*/src/**`, the `match` of archcheck rule `extensions-implement-contracts` in `architecture.config.ts` (confirmed by reading the file; this record does not edit it). That rule's `mayImport` list covers `contracts`, `security-kernel`, `core`, `vendored`, `support`, `core-adapters` and `observability-sqlite`. So **no manifest change is expected**. If `pnpm arch` disagrees in Task 1.2, work stops and the finding goes to the maintainer with the rule id and proposed diff. `architecture.config.ts` is a protected path and no agent edits it.

### 6. Open decisions taken

The plan's open decisions are recorded at their leaning. A maintainer may overturn any of them at approval.

| # | Question | Taken |
|---|---|---|
| O-1 | Who may accept agent proposals on a shared world | Only the owner in v1. |
| O-2 | Shared world in group chats by default | `owner_only` for people data (company template); `shareable` for a watchlist (watchlist template). |
| O-3 | Expertise levels | Evidence-based agent proposals the user accepts. |
| O-4 | Graph library for web | Cytoscape.js; Task 7.3 includes a 2k-node smoke. |
| O-5 | Reuse memory-approval for the inbox | Reuse the pattern, not the code. |
| O-6 | Extraction spend attribution | Add `UsageSourceKind 'world_extract'`. |
| O-7 | Initiative runs and `owner_only` worlds | Leave the rule as is: initiative runs see only `shareable` worlds. |
| O-8 | `WorldGraphProvider` on the §VII roster | Yes, with a method-count gate of 13, owner "any two repository maintainers", like Memory. |
| O-9 | Cross-world links | Not in v1. |
| O-10 | A single shared budget for memory and graph | v1: separate caps. |
| O-11 | `world_build` save consent | The skill asks; the World page preview has a Save button too. A known limit, written down. |

The conflict between the world tools and S1 is also resolved: Option A, ordinary toolset-gated tools. Option B, framework-internal `alwaysInclude`, is flagged and not chosen.

## Consequences

**Positive.** A new knowledge shape arrives without widening trust. A backend can only store and query, so a bad or third-party adapter cannot accept proposals or skip the audience rule. The deny list and the definition floor close the two file-tool paths to the graph's configuration.

**Costs.** Two safety-path edits need maintainer review and a documented test. A frozen 13-method contract is harder to change than an unfrozen one (O-8): a fourteenth method needs an amendment. Every tool call takes a hop through `WorldService`.

**Migration: none required.** With `world.enabled` off no world code runs, and every turn behaves as it does today. No existing module becomes non-compliant.

**Known limits.** The tests named above do not exist yet. The 13-method gate lands with the type in Task 1.1; before then the count is a plan. `world_build` cannot see the user's yes (O-11).

## Approvals

Both approvals are **OUTSTANDING**. Neither has been given.

| Approval | Needed before | Approver | State |
|---|---|---|---|
| RFC [world-graph-governance](../content/building/explanation/world-graph-governance.md) (Structural amendment: unanimous maintainers) | Task 1.1 merges | Repository maintainers | OUTSTANDING |
| This ADR (the `worlds` deny entry and the `worlds.yaml` floor entry, safety paths) | Task 2.5 merges | Repository maintainers | OUTSTANDING |
