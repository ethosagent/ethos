---
title: "Why is the world graph a new contract type?"
description: "RFC for the Structural amendment adding WorldGraphProvider: a typed, time-aware graph contract beside MemoryProvider, with a 14-method drift gate."
kind: explanation
audience: developer
slug: world-graph-governance
updated: 2026-11-28
---

## Context

[Memory](../../getting-started/glossary.md#memory) answers "how does Mitesh
like PRs reviewed?" well. It answers "who owns billing now?" badly. An older
note still says Priya, and nothing records that Ravi took over on 20 Nov. It
cannot answer "who knows Kafka on Platform?" at all, because that question is
about links between things, not about text.

The world model adds that shape: a typed graph of the things an agent works
with (people, teams, services, stocks) and the links between them. Every
fact records when it was true in the world, when Ethos learned it, where it
came from and who authored it. A fact is closed, never overwritten, so "who
owned billing before Ravi?" still has an answer. A personality has a private
world and can mount shared worlds that many personalities read.

Pluggable backends (a Neo4j, Graphiti or Kuzu adapter) need a stable surface
to be written against. This page is the RFC for adding that surface as a
contract. ARCHITECTURE.md §VI classifies "adding a new contract type" as a
**Structural** amendment: it needs unanimous maintainer agreement, an RFC, a
validator update in the same PR, and a migration note for non-compliant code.
The plan behind it is `plan/phases/world-model.md` (Task 0.1). The companion
decision record is [ADR 0012](../../../decisions/0012-world-graph-contract.md).

**Status: proposed.** No contract code merges until the maintainers approve
this RFC unanimously. Task 1.1, which creates `packages/types/src/world-graph.ts`
and its drift gate, waits for that approval. Approval is outstanding.

## Discussion

### Why a second knowledge contract

`MemoryProvider` is a scope-bound key/value text store
(`packages/types/src/memory.ts`): `prefetch`, `read`, `search`, `sync`,
`list`. A key holds prose. To make it answer a link question you would have
to parse prose on every read, and nothing in a text value can carry a
validity interval or a source.

`MemoryProvider` is also frozen. Its method count is pinned by
`memory-method-count` (ARCHITECTURE.md §VII). Growing it to hold entities,
links and time slices would break every memory backend written against five
methods, and mix two jobs behind one gate.

So the graph is a **sibling** of memory, not a replacement. Memory stays
untouched. Memory notes link to entities and entity pages list notes, but
neither contract imports the other.

### What the amendment adds

The contract is `WorldGraphProvider` in `packages/types/src/world-graph.ts`,
a file with zero imports like every other contract module. Its surface is 14
methods:

```ts
// excerpt: planned shape, packages/types/src/world-graph.ts (lands in Task 1.1)
export interface WorldGraphProvider {
  query(world: WorldId, q: GraphQuery, slice?: TimeSlice): Promise<Facts>;
  neighbours(world: WorldId, entityId: string, hops: number, slice?: TimeSlice): Promise<Subgraph>;
  history(world: WorldId, entityId: string): Promise<{ attributes: AttributeFact[]; edges: Edge[] }>;
  changes(world: WorldId, since: string, limit: number): Promise<ChangeRow[]>;
  assert(world: WorldId, facts: FactInput[]): Promise<WriteResult>;
  close(world: WorldId, factId: string, validTo: string, sourceRef: string, author: FactAuthor): Promise<WriteResult>;
  retire(world: WorldId, factId: string, sourceRef: string, author: FactAuthor): Promise<WriteResult>;
  getFact(world: WorldId, factId: string): Promise<AttributeFact | Edge | null>;
  getSchema(world: WorldId): Promise<WorldSchema | null>;
  applySchema(world: WorldId, schema: WorldSchema): Promise<WriteResult>;
  import(world: WorldId, data: GraphBundle): Promise<ImportReport>;
  export(world: WorldId): Promise<GraphBundle>;
  purge(world: WorldId, scope: { entityId?: string }, reason: string): Promise<{ removed: number }>;
  capabilities(): ProviderCapabilities;
}
```

There are five reads (`getFact` among them), three fact writes, two schema methods and four
lifecycle methods. The first backend is `extensions/world-sqlite`: STRICT
tables, recursive CTEs for hops and FTS5 for names.

The amendment changes ARCHITECTURE.md in two places:

| Section | Change |
|---|---|
| §VII | A roster row for the World graph contract, owned by any two repository maintainers (the same owner as Memory), bumped by adding, removing or renaming a method on `WorldGraphProvider`, gated by `world-graph-method-count`. |
| §IX | A `frozen_schemas.world_graph` entry: `frozen_method_count: 14` and the method list. |

The drift gate is `packages/types/src/__tests__/world-graph-method-count.test.ts`,
test `'world-graph method count is 14'`. It lands in Task 1.1 with the type,
the way `decision-provider-method-count.test.ts` landed with
`DecisionProvider`. Until that test exists and passes, the 14-method freeze
is planned, not a guarantee. After it lands, a fifteenth method fails on
both halves: the source and the manifest.

### What stays above the contract, and why

A backend only stores and queries. Everything that makes a shared world
trustworthy lives in `extensions/world-service`, above the contract:
`WorldService` (access, mounts, audience, write routing, proposals,
conflicts), `WorldSchemaService` (the only writer of every `schema.yaml`) and
`WorldConfigService` (the only writer of `world.yaml` and of the
per-personality `worlds.yaml` mount file).

The line is drawn so that a backend cannot weaken a guarantee. ARCHITECTURE.md
Law 11 says a module outside the security kernel must not be able to weaken a
guarantee the kernel enforces. A graph backend is a replaceable extension,
often a third-party database, so it must never be the thing that decides
whether a guarantee holds. Two things in particular must not be possible
from inside a backend:

1. **Accepting proposals.** On a shared world an agent only proposes. If the
   contract had an `acceptProposal` method, a backend could accept one.
   There is no proposal method: a backend stores only live facts, and the
   proposals table lives in `service.db`, owned by `WorldService`.
2. **Skipping the audience rule.** An `owner_only` world is never read in a
   shared or incognito turn (G-MEM, `docs/content/security/security-boundary.md`).
   Every method on the contract takes a `WorldId` and no audience. The
   audience check runs in `WorldService` before a call reaches a provider, so
   a provider has no audience to skip.

Each bound has a named enforcer. Tests marked "planned" do not exist yet, and
until each exists and passes its row is a plan, not a guarantee:

| Guarantee | Enforcer | Test | Task |
|---|---|---|---|
| Shared-world writes are proposals only. | `WorldService.writeFacts` and `closeFact` routing in `extensions/world-service` | `write-routing.test.ts` R1 (planned) | 2.4 |
| User-authored facts are never overwritten by the agent. | `WorldService.writeFacts`, `AUTHORITATIVE_AUTHORS` | `write-routing.test.ts` R2 (planned) | 2.4 |
| `owner_only` worlds are never read in shared or incognito turns. | `resolveAccess` rule 3 in `extensions/world-service` | `world-access.test.ts` R6 (planned) | 2.1 |
| Facts are never deleted, only closed or retired. | `edges_no_rewrite` and `edges_no_delete` triggers in `extensions/world-sqlite` | `graph-store.test.ts` R3 (planned) | 1.2 |
| Tools never reach a provider, `purge` or the owner-only writers. | `WorldToolPort` in `extensions/world-service` | `world-port.test.ts` R13 (planned) | 2.4 |

`purge` is on the contract so a backend can erase data, but no tool reaches
it: `WorldToolPort` is frozen and narrow.

### Why not a tool or a model role

Tools are how a model asks questions, not a storage contract: a second
backend still needs a surface to implement, and the access and write rules
must hold whichever tool, app or import path reaches the graph. Model roles
(`MODEL_ROLE_NAMES`, `packages/types/src/model-registry.ts`) answer "which
model writes this turn", and a graph writes nothing.

### The tools and S1

The ten `world_*` tools are ordinary tools in toolset group `world`. A
personality gets them only when its `toolset.yaml` lists them, so S1 holds:
mounting a world grants data access, not tools. Framework-internal
`alwaysInclude` tools (the initiative engine's pattern) would put
graph-writing tools in every prompt the day `world.enabled` flips. That
option is flagged, not chosen.

### What the amendment does not change

There is no §II or §IX layer edit. The three new packages
(`extensions/world-sqlite`, `extensions/world-service`,
`extensions/tools-world`) match the existing `extensions/*/src/**` layer
(archcheck `extensions-implement-contracts`), so no manifest change is
expected. The contract sits in `packages/types`, backends and services in
`extensions`, and composition in `packages/wiring/src/worlds.ts`. Apps never
import a provider (Law 5). `world-service` and `tools-world` never import
`world-sqlite`.

`PersonalityConfig` is unchanged: mounts live in a sidecar
`personalities/<id>/worlds.yaml`, so the frozen field count in
`packages/types/src/__tests__/personality-field-count.test.ts` does not
move. `MemoryProvider`, `AgentEvent`, `Tool`, `Storage`, the plugin contract
and `PromptContext` are unchanged.

**Migration: none required.** No existing module becomes non-compliant. With
`world.enabled` off, no world code runs and every turn behaves byte for byte
as it does today.

## Trade-offs

**A Structural amendment costs review time up front.** Unanimous approval is
slower than the two-maintainer sign-off an additive change gets. The cost
buys a surface that a third-party adapter can be written against without it
shifting underneath.

**Fourteen methods is more than the other contracts.** `DecisionProvider` has
one, `MemoryProvider` five. The graph needs reads over time, three distinct
write verbs (assert, close, retire) so history is never lost, schema
handling and bulk transfer. `getFact` (get by id) earned its slot because closing or promoting one fact must not read the whole world through `export`. Fewer methods would push those into the service
layer, where a backend could not optimise them (a graph database traverses
hops natively; a recursive CTE is the SQLite answer). The 14-method gate
makes the growth deliberate.

**Freezing before a second backend exists.** Open decision O-8 puts the
contract on the §VII roster now. Waiting means adapters get written against a
moving target. Freezing early risks a wrong shape that costs a Structural
amendment to fix. The plan takes that risk because `capabilities()` lets a
backend declare what it lacks without a method change.

## See also

- [ADR 0012: World graph contract](../../../decisions/0012-world-graph-contract.md):
  the decision record, with the deny-list and write-floor entries.
- [Why is a decision provider a new contract type?](decision-provider-governance.md):
  the previous RFC for a new contract type, and this page's model.
- [Security boundary](../../security/security-boundary.md): the G-MEM
  shared-turn rule the graph's access check reuses.
- [Why is a personality a governed contract?](personality-governance.md):
  the worked example of a frozen schema and its drift gate.
- [Why does a dashboard see four layers of memory instead of one?](sdk-memory-model.md):
  the memory layers the graph sits beside.
