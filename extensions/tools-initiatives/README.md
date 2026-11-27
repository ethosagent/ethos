# @ethosagent/tools-initiatives

## Purpose

Tools an initiative run uses to record into its own ledger: `initiative_propose`, `initiative_note`, `initiative_brief`, `initiative_ideas`, `initiative_budget`, the recall tools and a run-local `clarify`. Each tool is bound to one `InitiativeLedgerPort` and one initiative id. Tier 2: the tools declare `capabilities: {}` and write only through the narrow port; the enforcement boundary is `initiative-runner` (tier 1).

## Status

Skeleton. Every tool returns a `not_available` "not implemented yet" result; Task 4.3 of `plan/phases/initiative-engine.md` fills them in.

## Public surface

Exported from `src/index.ts`.

| Export | Kind | One line |
|---|---|---|
| `createInitiativeLedgerTools(port, initiativeId)` | function | Every `INITIATIVE_LEDGER_TOOLS` tool except `clarify`. |
| `createRunClarifyTool(port, initiativeId)` | function | The run-local `clarify`. |

## Seam

Implements `Tool` from `@ethosagent/types`; depends on `@ethosagent/types` only (never `initiative-store`). Archcheck layer: `extensions`. Tool conventions: `.claude/rules/providers-and-tools.md`.

## Testing

```
pnpm vitest run extensions/tools-initiatives
```
