# @ethosagent/tools-world

## Purpose

The ten `world_*` tools an agent uses to read and change the knowledge graph (worlds). The tools take a narrow `WorldToolPort` (`@ethosagent/world-service`) and nothing else: no provider, no `purge`, no `acceptProposal`, no config writer. Every rule (who may see a world, which writes land, what becomes a proposal) lives in `WorldService`; the tools shape arguments and results.

## Public surface

Single entry point, `src/index.ts`.

| Export | Kind | One line |
|---|---|---|
| `createWorldTools(port)` | function | The `world_*` tools over one port. |
| `WORLD_TOOL_NAMES` | const | The ten tool names. |

### Read tools (`read-tools.ts`)

`world_query`, `world_neighbours`, `world_history`. `toolset: 'world'`, `capabilities: {}` (service-mediated, like `memory_read`), `maxResultChars: 8000`, `outputIsUntrusted: true`. Without `world` they span every visible world; every line starts with its world tag (`acme:Ravi (Person) ...`) and ends with the fact's `#id`.

Pinned by `world-tools.test.ts`: 'R8 unscoped queries are tagged and span only mounted worlds', 'same name in two worlds is two entities', 'shared turn drops owner_only worlds from results', 'as_of returns the earlier owner'.

### Write tools (`write-tools.ts`)

`world_assert`, `world_close`, `world_propose`, `world_schema_change`. Arguments are parsed with Zod `safeParse`; the author is always `agent` (`WorldService.agentCtx` overrides whatever is sent). The reply reads `applied 2 · proposed 1 (conflicts with your fact: …) · refused 0`, then one line per refusal. A call where nothing applied or proposed and something was refused returns `input_invalid`.

Pinned by `world-tools.test.ts`: 'R9 write without world refused when 2+ mounted', 'assert on acme becomes a proposal; on private applies', 'read mount cannot propose', 'schema change on private adds mentors and reports the version'.

### Bulk tools (`bulk-tools.ts`)

`world_import` (facts-yaml or mcp-jsonl, read through `ctx.scopedFs`, `fs_reach: { read: 'from-personality' }`), `world_export` (facts-yaml, json, graphml, mermaid, mcp-jsonl, csv; `as_of` slices; `save_to` writes through `ctx.scopedFs`), `world_build` (calls `WorldToolPort.build`, which refuses `not_implemented` until plan P5). Import and build are refused in a shared turn; export of a world the turn may not see is refused by `WorldService`. CSV import needs a column mapping and stays on the owner surfaces.

Pinned by `bulk-tools.test.ts`: 'import path outside fs reach is refused', 'export respects the audience of the turn', 'world_build refused in a shared turn'.
