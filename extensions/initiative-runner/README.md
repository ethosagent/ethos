# @ethosagent/initiative-runner

## Purpose

Runs initiative explorations read-only. An exploration may search, read and record into its own ledger; it may not write anywhere else. This package holds the enforcement layers (L1 to L9 in `plan/phases/initiative-engine.md`) and, later, the runner that uses them. It sits on a trust boundary (tier 1).

## Public surface

Exported from `src/index.ts`.

| Export | Kind | One line |
|---|---|---|
| `INITIATIVE_READ_TOOLS` | frozen array | Search and read tools a run may use. Fixed in code. |
| `INITIATIVE_LEDGER_TOOLS` | frozen array | Engine tools (`initiative_*`, `clarify`) always available to a run. |
| `INITIATIVE_CHAT_TOOLS` | frozen array | `initiative_define`, `initiative_add_ideas`: owner-chat only, never in a run. |
| `INITIATIVE_NEVER_TOOLS` | frozen `ReadonlySet` | Tools that must never run, named so the census tells a refusal from an oversight. |
| `runToolNames(toolset)` | function | `READ ∩ toolset`, then every LEDGER tool. |

The four lists are pairwise disjoint.

## Toolset semantics

`runToolNames` mirrors `DefaultToolRegistry.toolNamesForPersonality` (`packages/core/src/tool-registry.ts`): an `undefined` toolset is unrestricted (the full read list), `[]` allows nothing (ledger tools only), and `'*'` is not a wildcard. A toolset can only remove read tools, never add one.

## Enforcers

| Guarantee | Enforcer |
|---|---|
| Lists are frozen, disjoint; toolset only narrows; `initiative_define` is never a run tool | `src/__tests__/initiative-allowlist.test.ts` |

## Known limits

- `INITIATIVE_NEVER_TOOLS` is best-effort until Task 2.7 reconciles it with the composed registry (`initiative-readonly-census.test.ts`, not yet written). Until then an unlisted tool is simply not allowed (L1 is an allowlist), but is not yet proven classified.
- Ledger tool names (`initiative_*`) are reserved here; the tools themselves are not implemented yet.
- MCP tools are not in the repo and are not classified here.

## Testing

```
pnpm vitest run extensions/initiative-runner
```
