# @ethosagent/tools-goals

## Purpose

Goal tools: `goal_create`, `goal_status` and `goal_complete`. They write through an injected `GoalStore` and derive a goal's room audience from its origin, since a goal has no audience column. Scheduling and running goals belong to other packages.

## Public surface

Exported from `src/index.ts` (single entry, no subpaths).

| Export | Kind | One line |
|---|---|---|
| `createGoalTools` | function | Returns the three goal tools for a `GoalStore`. |
| `GoalOriginAudience` | type | Maps a `GoalOrigin` to a `TurnAudience`; wiring binds it to `gateway.private_chats`. |

## Seam

Implements `Tool` from `@ethosagent/types`; uses `GoalStore`, `Goal`, `GoalOrigin`, `AcceptanceSpec` and `TurnAudience` from the same package. Archcheck layer: `extensions` (rule `extensions-implement-contracts` in `architecture.config.ts`). Rule `tools-read-env-through-ctx` bans `process.env` in `extensions/tools-*/src/**`, so config arrives through `ctx.*`. Tool conventions: `.claude/rules/providers-and-tools.md`.

## Testing

```
pnpm vitest run extensions/tools-goals
```

Pinning tests in `src/__tests__/`: `src/__tests__/goal-audience.test.ts` (a shared delegated child with no origin is refused, a one-to-one origin on a shared turn is refused, no derivation wired means every shared-turn goal is refused), `src/__tests__/acceptance-spec-schema.test.ts` (`acceptance_spec.checks` must be an array of well-formed items).
