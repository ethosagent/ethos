# ADR 0011 — The agent saves initiative config directly, after a chat yes

## Status

Accepted. It adds no law and edits no existing one; ARCHITECTURE.md carries one sentence under Law 7.

## Context

The initiative engine lets a personality own a standing area of work, read-only, inside a budget. The user sets it up in chat; the agent writes `personalities/<id>/initiatives/*.yaml` and the user never hand-writes YAML. The plan touches these laws and rules:

- **§II runtime boundary.** `packages/types/src/initiative.ts` (contracts), `initiative-store` and `initiative-runner` (extensions), `InitiativeConfigService` and the engine tools (extensions, depending on contracts only). Nothing in core imports an implementation.
- **Law 3.** Wiring is the only composition root: the runner, store, config service and tools are assembled in `packages/wiring` only.
- **Law 7.** Initiative YAML under `~/.ethos` is written through the injected `Storage`, never raw `node:fs`. The direct save in this ADR is the exception to the self-change path under this law.
- **Law 8 and S1.** The personality toolset is the sole authority. A run's read tools are the engine's read allowlist intersected with the personality's toolset. The engine's own tools are framework-internal (`alwaysInclude`, like `get_skill`). See the S1 conflict below.
- **Law 10 (silent libraries).** No `console.*` in the new packages; errors go to `Logger` or an injected `onError`. Not to be confused with the plan's layer "L10", which is the config-save bound below.
- **Law 11 and S5, S7.** Two new guarantees (read-only runs, bounded config save) must not be weakenable from outside the kernel. A blocked `before_tool_call` skips execution and still persists a `tool_result` (S5). A refused save or a source outside the roots surfaces as a typed error (S7).
- **Law 6.** `PersonalityConfig` does not change; initiatives are a sidecar, so `.personality-field-count` does not move.
- **§VI.** A new contract type is Structural-adjacent, a frozen-schema change is Schema class. Each item in the table below names its gate.
- **§VII.** `Constitution` is frozen by `.constitution-field-count`; adding `initiatives` moves it from 5 to 6 with maintainer review. `AgentEvent`, `Tool`, `Storage`, `MemoryProvider` and `UsageSourceKind` do not change.
- **Rules files.** `storage.md` (turn-scoped definition floor, and `propose_self_amendment` as the one governed path for a turn to change its definition), `agent-loop.md` (single owners; a run drains `AgentLoop.run()`), `providers-and-tools.md` (tool census, result budget), `sqlite-durability.md` (`initiatives.db` is STRICT, `synchronous = FULL`), `personality.md` (sidecar, no new `PersonalityConfig` field), `ui-design.md` (every key has a Personality or Settings control). `docs/content/security/security-boundary.md` holds the guarantee register; the plan adds two rows.

Today a turn changes its own definition only through `propose_self_amendment`: it files a pending record, and a person applies it at a terminal (`ethos personality amendments apply`). That path covers `toolset.yaml` membership and identity fields.

## Decision

After the user's explicit yes in a private chat turn, the agent saves `initiatives/*.yaml` directly through `InitiativeConfigService`. It does not use `propose_self_amendment`. The save is bounded by the plan's L10, all enforced inside the service and the storage floor:

- sources only under the operator's readable roots, and never a blocked path (`.env*`, key files, the state-dir deny list);
- a child's sources are a subset of its parent's (self-start);
- budget values are clamped to the operator ceilings in `Constitution.initiatives`;
- strict schema: unknown keys inside an initiative file are rejected, a hand-edited invalid file pauses that initiative and says why;
- the personality definition floor (`PERSONALITY_DEFINITION_ENTRIES` gains `'initiatives/'`) refuses every file tool, so the only writer is the service. This is why the exception is narrow: no other write path to that directory exists.

Why not `propose_self_amendment`: initiative YAML grants no tool and no folder beyond the operator's roots. The amendment path exists because a toolset or identity edit widens what the personality can do; this file cannot. Applying a proposal needs a person at a terminal, so setup by chat would be two steps away from usable: the agent interviews the user, then the user leaves chat to run a CLI command. That makes the headline feature unusable.

What would make the exception wrong: any field in initiative YAML that widens reach or grants a tool, for example a tool name, a path outside the operator roots, a write-capable source, an autonomy level that executes rather than recommends, or a budget field with no operator ceiling. If one is proposed, that field goes through `propose_self_amendment` (or the schema rejects it) and this ADR is superseded. The strict schema is the guard, and its test fails on an added field.

### Contract and frozen-schema approvals

Each needs maintainer approval before the owning task merges.

| Change | Gate | Task |
|---|---|---|
| New contract file `packages/types/src/initiative.ts` (not a frozen schema) | review | 1.1 |
| `Constitution.initiatives` | `.constitution-field-count` 5 to 6, constitution-field-count test | 3.2 |
| `'initiatives/'` in `PERSONALITY_DEFINITION_ENTRIES` | safety module (`packages/types` + `packages/storage-fs` floor); ARCHITECTURE.md §V, Law 11 | 3.4 |
| `initiatives.db` in `STATE_DIR_DENY_ENTRIES` | security kernel (`packages/storage-fs`) | 3.4 |
| Engine tools are framework-internal (`alwaysInclude`) | ARCHITECTURE.md §V S1 reading; this ADR | 4.4 |
| Direct save of `initiatives/*.yaml` after a chat yes | this ADR plus one line under Law 7 | 0.1, 3.7 |
| Two register rows (G-INIT-RO, G-INIT-CFG) | `scripts/check-architecture.mjs`; moves the "thirteen guarantees" counts in SECURITY.md and README.md | 3.7 |

### Surfaced conflict: "on by default" vs S1

The decided default is that every personality has the engine on. S1 says the toolset is the sole authority.

- **Option A (chosen).** The engine's own tools (ledger tools in runs, config and recall tools in chat) are framework-internal `alwaysInclude` tools, hidden per personality by `buildPersonalityToolExclude` when the feature is off. A run's read tools stay intersected with the personality toolset, so guidance can only map to tools the personality already has.
- **Option B (not chosen).** Require `initiative_define` in each `toolset.yaml`. It keeps S1 literal, but every existing personality is off until someone edits its toolset, which contradicts the default.

A is chosen because the engine tools grant no reach (read-only, ledger and own YAML only) and the one S1 surface that does reach, the run's read tools, is still bounded by the toolset. S1's "no code path circumvents the allowlist" is itself a known gap, so the maintainer should confirm that reading.

## Consequences

- Chat setup works in one turn: interview, user says yes, file saved.
- A direct writer of a definition-adjacent directory now exists outside the amendment path. It is one service, behind the definition floor, so file tools still cannot write there.
- The `initiatives/` floor entry also blocks a turn from writing `settings.yaml` in that directory; the service writes it. Turns can still read both (no secret in either; stated, not enforced).
- Limitation: until Task 3.7 lands, the bound above has no test that pins it. The names below are the tests the plan commits to, not existing ones.

## Enforced by

Planned, landing with the tasks named above (not yet present in the tree):

- `InitiativeConfigService` validation tests and the strict-schema test (Task 3.7).
- The storage definition-floor test extended for `initiatives/` (Task 3.4).
- G-INIT-CFG and G-INIT-RO rows in `docs/content/security/security-boundary.md`, checked by `scripts/check-architecture.mjs` (Task 3.7).
