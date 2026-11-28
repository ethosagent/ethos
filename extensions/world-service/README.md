# @ethosagent/world-service

## Purpose

The rules layer of the world model. A world backend (`WorldGraphProvider`, `packages/types/src/world-graph.ts`) stores facts; this package decides who may see or write them. It holds the config shapes, the access function, the schema and proposal services, `WorldService` (the one reader and writer of facts) and the narrow `WorldToolPort` the `world_*` tools get.

## Public surface

Single entry point, `src/index.ts`.

| Export | Kind | One line |
|---|---|---|
| `resolveAccess` | function | Pure: mounts ∩ grants ∩ turn audience -> visible worlds with a mode, plus inert mounts with a reason. |
| `displayTag` | function | `acme:Ravi` / `private:billing-svc`. |
| `parseWorldId`, `privateWorldId`, `sharedWorldId`, `worldSlug`, `isSafeSlug` | functions | `world:<slug>` / `personality:<pid>` ids; slugs go through `assertSafeId`. |
| `parseWorldYaml`, `parseMountsYaml` | functions | Zod `.strict()` parse of `world.yaml` / `worlds.yaml`; errors are `WorldConfigError` with one `{ line, message }` per problem. |
| `WorldFileSchema`, `MountsFileSchema`, `WorldConfigError` | values | The schemas and the error class. |
| `WorldConfigService` | class | The only writer of `world.yaml` and `worlds.yaml`: validates, `writeAtomic`, records `# written by <who> at <time>`; `listWorlds` / `readMounts` re-validate on load. Compose-time Storage only. |
| `WorldSchemaService`, `worldSchemaPath` | class, function | The only writer of every `schema.yaml` and of `schema_versions`: `apply`, `requestChange` (the R12 rules table), `load` (hand edits, R14), `undoLast`. Shared worlds live at `worlds/<slug>/schema.yaml`, private ones at `worlds/.private/<pid>/schema.yaml` (a dot cannot be in a slug, so no shared world collides). |
| `parseSchemaYaml`, `serializeSchemaYaml` | functions | Canonical and short (`"A -> B"`, attribute-less edges only) forms; errors carry line and column. `sensitive: true` on an attribute is a world-service extension kept out of the frozen `WorldSchema`. |
| `SchemaChange`, `classifySchemaChange`, `applyChange` | type, functions | The eight change ops, additive vs rewrite, and the pure application of one to a schema. |
| `SQLiteWorldServiceStore`, `serviceDbPath` | class, function | `worlds/service.db` (WAL, `synchronous = FULL`, STRICT): `schema_versions`, `schema_load_errors`, `proposals`, `proposal_tombstones`. `propose` / `decide` / `inbox` are the proposal queue: dedup by fingerprint, tombstone on reject, per-world cap (default 500) and TTL (default 30 days). |
| `WorldService`, `WorldServiceError` | class | The one place facts are read or written. Reads span visible worlds and tag every result `acme:Ravi` (R8). `writeFacts` routes per fact: refuse (no world with 2+ visible, read-only mount, vetting), proposal (shared world, authoritative collision, confidence under 0.7) or direct write with unique collisions closed. Owner surfaces only: `acceptProposal` (replays with the original author, records `decided_by`), `rejectProposal` (tombstone), `promoteToUser`, `ownerWrite`, `ownerImport`, `purge`. |
| `createWorldToolPort`, `WorldToolPort` | function, type | A frozen object of eleven methods bound to a `WorldService`: no provider, no `purge`, no `acceptProposal`, no config writer. `build` refuses `not_implemented` until plan P5. |
| `vetFact` | function | Pure content check before a write or proposal: secrets (`detectSecrets`), personal data (`redactPii`, agent only), `sensitive: true` attributes (agent never), schema fit, confidence range. A refusal reason never echoes the matched text. |
| `parseAssertPayload`, `parseClosePayload`, `parseSchemaPayload` | functions | `safeParse` of the JSON a proposal row carries; an unreadable payload fails closed on accept. |

### Codecs

Pure functions over a `GraphBundle` (text in, text or drafts out; no provider, no Storage). Exports: `toBundleJson`, `toGraphML`, `toMermaid` (capped at `MERMAID_MAX_NODES`), `sliceBundle` (time slice before an export), `exportFactsYaml` / `importFactsYaml`, `exportCsv` / `importCsv` / `parseCsv` (entities and links files; import infers a mapping and returns drafts plus `MappingIssue`s), `exportMcpJsonl` / `importMcpJsonl` (MCP memory server interop). Imports return drafts, never write; the owner commits them through `WorldService.ownerImport`. Behaviour is pinned by `csv.test.ts`, `facts-yaml.test.ts`, `mcp-jsonl.test.ts` and `exports.test.ts`.

## Seam

Archcheck layer: `extensions`, security tier 1 (it sits on the world access trust boundary). Imports `@ethosagent/types` and `@ethosagent/safety-redact`; never `world-sqlite`. `WorldConfigService` reads and writes the two config files through the `Storage` it is handed; the service store opens its own SQLite file; everything else takes text and maps in.

Two files, two owners, both needed for access: `worlds/<slug>/world.yaml` (grants: `readers`, `proposers`, `audience`) and `personalities/<id>/worlds.yaml` (mounts). A mount the world does not list is inert; neither file is agent-writable (`packages/wiring/src/__tests__/world-floor.test.ts`).

Guarantees and what pins them:

- A personality cannot grant itself a world (R7): `world-access.test.ts`, 'R7 mount refused when the world does not list the personality'.
- `owner_only` worlds drop per world in a shared turn (R6): `world-access.test.ts`, 'R6 per-world audience in a shared turn'.
- The private world is visible to its own personality only: 'private world is never visible to another personality'.
- Unknown keys and duplicate aliases are refused with a line number: `world-config.test.ts`, 'unknown key fails', 'duplicate alias fails with the line'.
- Every schema change follows the rules table, and a used type is never removed: `schema-rules.test.ts`, 'R12 change rules table', 'remove of a used type is refused with the count'.
- An invalid hand edit keeps the last good version and is not overwritten: `schema-service.test.ts`, 'R14 invalid hand edit keeps the last good version'.
- `schema.yaml` is written only through the injected `Storage.writeAtomic`: `schema-service.test.ts`, 'apply writes schema.yaml only through the injected Storage.writeAtomic ...'.
- A payload is queued once, a rejected one never again, the queue is capped and expires, and the inbox lists conflicts first: `proposals.test.ts`, 'same payload twice → one pending row', 'rejected fingerprint is not re-proposed', 'cap expires the oldest', 'ttl expires stale pending proposals', 'inbox lists conflicts first, then by created_at, rowid', 'batch_id groups a first-build or shared-world batch'.
- `service.db` is STRICT and `synchronous = FULL`: `schema-service.test.ts`, 'schema_versions is STRICT; durability posture is FULL'.
- Writes: an agent write on a shared world is a proposal, a user or import fact is never overwritten or closed by the agent (a conflict proposal instead), a tool's claimed author is ignored, and a secret, personal data or sensitive attribute is refused (R1, R2, R11): `write-routing.test.ts` 'R1 shared-world writes are proposals only', 'R2 user facts are never overwritten by the agent', 'an agent cannot claim the user author'; `fact-vetting.test.ts` 'R11 a fact carrying a secret is refused', 'sensitive attribute refused for the agent, allowed for the owner'.
- A write with no world and 2+ visible worlds is refused `WORLD_REQUIRED` (R9): 'R9 null world with 2+ visible worlds → WORLD_REQUIRED'. The tool port exposes no owner method (R13): `world-port.test.ts` 'R13 tool port is narrow'.

## Gotchas

- A turn with no known audience is treated as shared (fail closed).
- The private world is `owner_only`, so a shared turn does not see it either.
- Mount `world:` is the slug (`acme`), not `world:acme`.
- Limitation: `WorldGraphProvider` cannot retire or retype an entity, so renaming or merging an entity type re-asserts the entities under the new type and moves their attributes and edges, but the old entity rows remain in the backend under a type the schema no longer lists.
- `undoLast` is refused after a rename or merge (facts were rewritten); apply the inverse change instead.
- Limitations: `closeFact` and `promoteToUser` find a fact by reading `export(world)` (the contract has no lookup by id), each fact is asserted on its own, and an imported bundle carries live facts only (`FactInput` has no `validTo`).
