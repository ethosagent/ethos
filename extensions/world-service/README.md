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

## Seam

Archcheck layer: `extensions`, security tier 1 (it sits on the world access trust boundary). Imports `@ethosagent/types` only; never `world-sqlite`. No file I/O: callers pass text and maps in.

Two files, two owners, both needed for access: `worlds/<slug>/world.yaml` (grants: `readers`, `proposers`, `audience`) and `personalities/<id>/worlds.yaml` (mounts). A mount the world does not list is inert; neither file is agent-writable.

Guarantees and what pins them:

- A personality cannot grant itself a world (R7): `world-access.test.ts`, 'R7 mount refused when the world does not list the personality'.
- `owner_only` worlds drop per world in a shared turn (R6): `world-access.test.ts`, 'R6 per-world audience in a shared turn'.
- The private world is visible to its own personality only: 'private world is never visible to another personality'.
- Unknown keys and duplicate aliases are refused with a line number: `world-config.test.ts`, 'unknown key fails', 'duplicate alias fails with the line'.

## Gotchas

- A turn with no known audience is treated as shared (fail closed).
- The private world is `owner_only`, so a shared turn does not see it either.
- Mount `world:` is the slug (`acme`), not `world:acme`.
