# @ethosagent/tools-x-search

## Purpose

The `x_search` tool. It calls xAI's Responses API with the `x_search` tool type, so xAI performs the X/Twitter search server-side; it does not call X's own search API. There is one provider and no backend selection.

## Public surface

Exported from `src/index.ts` (single entry, no subpaths).

| Export | Kind | One line |
|---|---|---|
| `createXSearchTool` | function | Builds `x_search`. |
| `xSearchTool` | const | Default instance. |
| `CreateXSearchToolOptions` | interface | Factory options. |
| `XSearchArgs` | interface | Tool input. |
| `XSearchSetting` | interface | Per-personality secret binding. |

## Seam

Implements `Tool` from `@ethosagent/types`; resolves the key with `resolveToolSecretRef` from `@ethosagent/core`. Archcheck layer: `extensions` (rule `extensions-implement-contracts` in `architecture.config.ts`). Rule `tools-read-env-through-ctx` bans `process.env` in `extensions/tools-*/src/**`, so config arrives through `ctx.*`. Tool conventions: `.claude/rules/providers-and-tools.md`.

## Testing

```
pnpm vitest run extensions/tools-x-search
```

Pinning test: `src/__tests__/x-search.test.ts` holds availability, `not_available` without capability backends, and input validation.
