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

`world_import` (facts-yaml or mcp-jsonl, read through `ctx.scopedFs`, `fs_reach: { read: 'from-personality' }`), `world_export` (facts-yaml, json, graphml, mermaid, mcp-jsonl, csv; `as_of` slices; `save_to` writes through `ctx.scopedFs`), `world_build` (calls `WorldToolPort.build`, the first-build pipeline). Import and build are refused in a shared turn; export of a world the turn may not see is refused by `WorldService`. CSV import needs a column mapping and stays on the owner surfaces.

Pinned by `bulk-tools.test.ts`: 'import path outside fs reach is refused', 'export respects the audience of the turn', 'world_build refused in a shared turn'.

## Guarantees and what pins them

Every rule lives in `WorldService`; the tools only shape arguments and results.

- The tools hold a narrow port, never a provider, `purge`, `acceptProposal` or a config writer (R13): `extensions/world-service/src/__tests__/world-port.test.ts` 'R13 tool port is narrow'; `packages/wiring/src/__tests__/worlds-wiring.test.ts`.
- Results are tagged with their world and never span an unmounted or `owner_only`-in-shared-turn world (R6, R8): `world-tools.test.ts` 'R8 unscoped queries are tagged and span only mounted worlds', 'shared turn drops owner_only worlds from results'.
- A write without `world` is refused when two or more worlds are mounted (R9): 'R9 write without world refused when 2+ mounted'.
- An agent write on a shared world is a proposal and the author is always `agent` (R1, R2): enforced by `WorldService.writeFacts` and `WorldService.agentCtx`, pinned by `write-routing.test.ts` in `world-service` and 'assert on acme becomes a proposal; on private applies' here.
- Read tools are marked `outputIsUntrusted`, and the tools are registered only when `world.enabled` and the toolset lists them: `world-tools.test.ts`; `packages/wiring/src/__tests__/worlds-wiring.test.ts`.
- Archcheck layer `extensions`, tier 2; it never imports `world-sqlite` or `world-service` internals beyond the port type (`architecture.config.ts`, `pnpm arch`).

## Known limits

- `world_build` save consent is behavioural: the tool cannot see the user's yes (plan O-11). On a shared world save only creates proposals.
- `world_import` accepts facts-yaml and mcp-jsonl; CSV import needs a mapping and stays on the owner surfaces (`ethos world import`, the World page).
- Read results are capped at 8000 characters; a large world needs a narrower query.
