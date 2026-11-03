# @ethosagent/tools-tier

## Purpose

The `think_deeper` tool, which the model calls to ask for the deep model tier on the next call. The tool itself only returns an acknowledgement string that includes the reason.

## Public surface

Exported from `src/index.ts` (single entry, no subpaths).

| Export | Kind | One line |
|---|---|---|
| `createThinkDeeperTool` | function | Builds `think_deeper`. |

## Seam

Implements `Tool` from `@ethosagent/types`. Archcheck layer: `extensions` (rule `extensions-implement-contracts` in `architecture.config.ts`). Rule `tools-read-env-through-ctx` bans `process.env` in `extensions/tools-*/src/**`, so config arrives through `ctx.*`. Tool conventions: `.claude/rules/providers-and-tools.md`. Limitation: the tier switch is not implemented in this package and no test here pins it; the tests only check the acknowledgement and tool metadata.

## Testing

```
pnpm vitest run extensions/tools-tier
```

Pinning test: `src/__tests__/think-deeper.test.ts` holds the success value containing the reason and the tool metadata.
