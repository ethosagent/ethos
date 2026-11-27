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
| `createInitiativeToolGate(allowed)` | function | L4. A `before_tool_call` handler that refuses any tool name outside `allowed`; fires via `enforceBeforeToolCall`, so model and script calls hit it alike. |
| `assertReadOnlyCapabilities(tools, meta)` | function | L3. Throws `INITIATIVE_TOOL_NOT_READ_ONLY` for a tool that declares `fs_reach.write`, `process` or `storage`, is `mcp__*`, has a `pluginId`, or sets `alwaysInclude` without being an engine tool. `meta` is bound to `DefaultToolRegistry.getPluginId` by wiring. |

The four lists are pairwise disjoint.

## Toolset semantics

`runToolNames` mirrors `DefaultToolRegistry.toolNamesForPersonality` (`packages/core/src/tool-registry.ts`): an `undefined` toolset is unrestricted (the full read list), `[]` allows nothing (ledger tools only), and `'*'` is not a wildcard. A toolset can only remove read tools, never add one.

## Enforcers

| Guarantee | Enforcer |
|---|---|
| A tool that declares a write, process, storage, MCP, plugin or stray `alwaysInclude` is refused | `src/capability-audit.ts`, `src/__tests__/initiative-capability-audit.test.ts` |
| A call outside the run's allowed names never executes, and its error `tool_result` is still persisted (model path and script bridge path) | `src/tool-gate.ts`, `src/__tests__/initiative-blocked-call.test.ts` |
| Lists are frozen, disjoint; toolset only narrows; `initiative_define` is never a run tool | `src/__tests__/initiative-allowlist.test.ts` |

## Known limits

- `INITIATIVE_NEVER_TOOLS` is best-effort until Task 2.7 reconciles it with the composed registry (`initiative-readonly-census.test.ts`, not yet written). Until then an unlisted tool is simply not allowed (L1 is an allowlist), but is not yet proven classified.
- L3 reads declared capabilities only. A tool that writes through an injected service declares `{}` and passes (`memory_write`). L1 and the L7 census cover those; `memory_write passes L3 (documented limitation) but fails L1` pins it.
- Ledger tool names (`initiative_*`) are reserved here; the tools themselves are not implemented yet.
- A personality with a local shell tool can still write `initiatives/` (same limit as every definition file, `.claude/rules/storage.md`). Initiative runs have no shell.
- MCP tools are not in the repo and are not classified here.

## Testing

```
pnpm vitest run extensions/initiative-runner
```
