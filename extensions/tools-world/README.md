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
