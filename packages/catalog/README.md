# @ethosagent/catalog

## Purpose

The unified catalog index: one typed `CatalogEntry` per reviewed capability, one TS file per entry under `src/entries/<kind>/<id>.ts` and a hand-kept barrel at `src/entries/index.ts`. TS rather than JSON so each entry keeps its verification notes (what was launched, when, how the licence and tool count were determined). Pure data plus a data-free filter; depends only on `@ethosagent/types`. Phase 1 holds the 16 seed `mcp` entries; `MCP_PRESETS` and `MCP_REMOTE_PRESETS` in `@ethosagent/tools-mcp` are derived views over them.

## Public surface

| Export | Kind | One line |
|---|---|---|
| `CATALOG_ENTRIES` | const | Every entry, in barrel order. |
| `getCatalogEntry` | function | Entry by id, or `undefined`. |
| `catalogEntriesOfKind` | function | Entries of one `CatalogKind`. |
| `filterCatalog` | function | `@ethosagent/catalog/filter`: case-insensitive match on id, name, description, publisher, plus kind and tier filters. Imports no entry data. |
| `pinSpec` | function | `name@version` for an npm or PyPI pin. Also exported from `./filter`. |
| `launcherArgs` | function | npx argv (`-y --ignore-scripts spec`) or uvx argv (`spec`) for a pin. Also exported from `./filter`. |

## Seam

Types: `CatalogEntry` and the `CATALOG_*` vocabularies in `packages/types/src/catalog.ts`. Wire schema: `CatalogEntrySchema` in `packages/web-contracts/src/schema/catalog.ts`, pinned equal by `catalog-schema-drift.test.ts`. Archcheck layer: `support`. Plan: `plan/phases/unified-catalog.md` section 4.

## Testing

```
pnpm vitest run packages/catalog
```

Pinning tests:
- `src/__tests__/index.test.ts`: schema parse, unique ids, barrel matches `entries/`, exact pins, `mcp` block iff npm/pypi, no `official` unless publisher is Ethos, no `community` plugin, non-null licence for code.
- `src/__tests__/filter.test.ts`: `filterCatalog`.
- `src/__tests__/pin.test.ts`: `pinSpec` and `launcherArgs`.
