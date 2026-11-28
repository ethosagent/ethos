# @ethosagent/world-service

## Purpose

The rules layer of the world model. A world backend (`WorldGraphProvider`, `packages/types/src/world-graph.ts`) stores facts; this package decides who may see or write them. This task ships the config shapes and the access function; `WorldService`, `WorldSchemaService` and the tool port land in later tasks.

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
| `SQLiteWorldServiceStore`, `serviceDbPath` | class, function | `worlds/service.db` (WAL, `synchronous = FULL`, STRICT): `schema_versions`, `schema_load_errors`, `proposals`, `proposal_tombstones`. |

## Seam

Archcheck layer: `extensions`, security tier 1 (it sits on the world access trust boundary). Imports `@ethosagent/types` only; never `world-sqlite`. `WorldConfigService` reads and writes the two config files through the `Storage` it is handed; the service store opens its own SQLite file; everything else takes text and maps in.

Two files, two owners, both needed for access: `worlds/<slug>/world.yaml` (grants: `readers`, `proposers`, `audience`) and `personalities/<id>/worlds.yaml` (mounts). A mount the world does not list is inert; neither file is agent-writable (`packages/wiring/src/__tests__/world-floor.test.ts`).

Guarantees and what pins them:

- A personality cannot grant itself a world (R7): `world-access.test.ts`, 'R7 mount refused when the world does not list the personality'.
- `owner_only` worlds drop per world in a shared turn (R6): `world-access.test.ts`, 'R6 per-world audience in a shared turn'.
- The private world is visible to its own personality only: 'private world is never visible to another personality'.
- Unknown keys and duplicate aliases are refused with a line number: `world-config.test.ts`, 'unknown key fails', 'duplicate alias fails with the line'.
- Every schema change follows the rules table, and a used type is never removed: `schema-rules.test.ts`, 'R12 change rules table', 'remove of a used type is refused with the count'.
- An invalid hand edit keeps the last good version and is not overwritten: `schema-service.test.ts`, 'R14 invalid hand edit keeps the last good version'.
- `schema.yaml` is written only through the injected `Storage.writeAtomic`: `schema-service.test.ts`, 'apply writes schema.yaml only through the injected Storage.writeAtomic ...'.
- `service.db` is STRICT and `synchronous = FULL`: `schema-service.test.ts`, 'schema_versions is STRICT; durability posture is FULL'.

## Gotchas

- A turn with no known audience is treated as shared (fail closed).
- The private world is `owner_only`, so a shared turn does not see it either.
- Mount `world:` is the slug (`acme`), not `world:acme`.
- Limitation: `WorldGraphProvider` cannot retire or retype an entity, so renaming or merging an entity type re-asserts the entities under the new type and moves their attributes and edges, but the old entity rows remain in the backend under a type the schema no longer lists.
- `undoLast` is refused after a rename or merge (facts were rewritten); apply the inverse change instead.
